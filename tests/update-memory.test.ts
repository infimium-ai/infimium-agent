import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { ProjectMemoryStore } from "../src/memory/project-memory.js";
import { startMemoryUpdateWorker, updateMemory } from "../src/memory/update-memory.js";
import { readContextLayer } from "../src/memory/context-layer.js";
import { runInfimiumUpdateTool } from "../src/commands/infimium-update.js";

describe("project memory updates", () => {
  let root: string;
  let project: string;
  let other: string;
  let store: ProjectMemoryStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "infimium-updates-"));
    project = join(root, "one");
    other = join(root, "two");
    await mkdir(project);
    await mkdir(other);
    vi.stubEnv("INFIMIUM_DATA_DIR", join(root, "data"));
    vi.stubEnv("INFIMIUM_TELEMETRY", "false");
    for (const repo of [project, other]) {
      spawnSync("git", ["init", "-q", repo]);
      await writeFile(join(repo, "package.json"), JSON.stringify({ name: repo === project ? "one" : "two", description: "Test project for memory" }));
      await writeFile(join(repo, "index.ts"), "export const answer = 1;\n");
    }
    store = new ProjectMemoryStore(join(root, "data", "infimium.db"));
  });
  afterEach(async () => {
    store.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("links durable episodes, files, tasks and handoff without completing the active session", async () => {
    const first = await updateMemory({ projectPath: project, note: "Added auth validation", task: "Finish auth", handoff: "Run auth tests", files: ["index.ts"] }, store);
    expect(first.updated).toBe(true);
    await writeFile(join(project, "index.ts"), "export const answer = 12345;\n");
    const second = await updateMemory({ projectPath: project, source: "automatic" }, store);
    expect(second.checkpoint?.previousId).toBe(first.checkpoint?.id);
    expect(second.checkpoint?.handoff).toBe("Run auth tests");
    expect(store.getActiveSession(project)?.status).toBe("active");
    const context = parse(await readContextLayer({ projectPath: project, memoryStore: store }));
    expect(context.activeExecution.memoryGraph.edges.map((edge: { relation: string }) => edge.relation))
      .toEqual(expect.arrayContaining(["followed_by", "records", "involves", "hands_off"]));
    expect(context.activeExecution.agentHandoff.instruction).toContain("Do not rescan");
    expect(await readFile(second.contextFile, "utf8")).toContain("Run auth tests");
  });

  it("deduplicates unchanged automatic observations and isolates projects", async () => {
    await updateMemory({ projectPath: project, note: "Project one" }, store);
    expect((await updateMemory({ projectPath: project, source: "automatic" }, store)).updated).toBe(false);
    await updateMemory({ projectPath: other, note: "Project two" }, store);
    expect(store.getMemoryCheckpoints(project)).toHaveLength(1);
    expect(store.getMemoryCheckpoints(other)[0]?.previousId).toBeNull();
    expect(await readContextLayer({ projectPath: other, memoryStore: store })).not.toContain("Project one");
  });

  it("uses saved context even after repository files disappear, and overlays new memory", async () => {
    await updateMemory({ projectPath: project, note: "Initial note" }, store);
    store.remember({ projectPath: project, summary: "Latest agent progress" });
    await rm(project, { recursive: true });
    const context = parse(await readContextLayer({ projectPath: project, memoryStore: store }));
    expect(context.staticAnchors.project.name).toBe("one");
    expect(context.activeExecution.lastNote).toBe("Latest agent progress");
    expect(store.getMemoryCheckpoints(project)).toHaveLength(1);
  });

  it("reports missing cache without scanning or creating a snapshot", async () => {
    const context = parse(await readContextLayer({ projectPath: project, memoryStore: store }));
    expect(context.status).toBe("missing");
    expect(store.getLatestContextSnapshot(project)).toBeNull();
  });

  it("persists opt-in settings and claims each scheduled update only once", async () => {
    store.configureMemoryUpdates(project, true, 10_000);
    const reopened = new ProjectMemoryStore(store.getDatabasePath());
    expect(reopened.getMemoryUpdateSettings()[0]?.enabled).toBe(true);
    const scheduled = store.getMemoryUpdateSettings()[0]!.nextRunAt;
    vi.spyOn(Date, "now").mockReturnValue(scheduled + 1);
    const worker = startMemoryUpdateWorker({ store, pollMs: 60_000 });
    const secondWorker = startMemoryUpdateWorker({ store: reopened, pollMs: 60_000 });
    try {
      await Promise.all([worker.tick(), secondWorker.tick()]);
      expect(store.getMemoryCheckpoints(project)).toHaveLength(1);
      store.configureMemoryUpdates(project, false, 10_000);
      await writeFile(join(project, "index.ts"), "export const stopped = true;\n");
      vi.spyOn(Date, "now").mockReturnValue(scheduled + 100_000);
      await worker.tick();
      expect(store.getMemoryCheckpoints(project)).toHaveLength(1);
    } finally {
      await worker.stop();
      await secondWorker.stop();
      reopened.close();
      vi.restoreAllMocks();
    }
  });

  it("rejects invalid intervals, excluded files and references outside the project", async () => {
    expect(() => store.configureMemoryUpdates(project, true, 0)).toThrow("interval");
    await expect(updateMemory({ projectPath: project, files: ["../two/index.ts"] }, store)).rejects.toThrow("inside");
    await expect(updateMemory({ projectPath: project, files: [".env"] }, store)).rejects.toThrow("inside");
    await expect(runInfimiumUpdateTool({ action: "stop", project_path: project, note: "silently lost?" })).rejects.toThrow("refresh");
  });

  it("runs the built CLI alias and records a failure when an enabled project disappears", async () => {
    const result = spawnSync(process.execPath, ["dist/src/index.js", "infimium_update", "refresh", "--project", project, "--note", "CLI checkpoint"], {
      encoding: "utf8", env: { ...process.env, INFIMIUM_DATA_DIR: join(root, "data"), INFIMIUM_TELEMETRY: "false" }
    });
    expect(result.status, result.stderr).toBe(0);
    expect(parse(result.stdout).updated).toBe(true);
    store.configureMemoryUpdates(project, true, 10_000);
    const scheduled = store.getMemoryUpdateSettings()[0]!.nextRunAt;
    vi.spyOn(Date, "now").mockReturnValue(scheduled + 1);
    await rm(project, { recursive: true });
    const worker = startMemoryUpdateWorker({ store, pollMs: 60_000 });
    try {
      await worker.tick();
      expect(store.getMemoryUpdateSettings()[0]?.lastError).toContain("ENOENT");
    } finally { await worker.stop(); vi.restoreAllMocks(); }
  });
});
