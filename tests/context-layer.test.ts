import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { ContextLayerWriter, readContextLayer } from "../src/memory/context-layer.js";
import { ProjectMemoryStore } from "../src/memory/project-memory.js";

describe("context layer", () => {
  let tempDir: string;
  let projectPath: string;
  let dbPath: string;
  let contextFilePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "infimium-context-"));
    projectPath = join(tempDir, "repo");
    dbPath = join(tempDir, "data", "infimium.db");
    contextFilePath = join(tempDir, "data", "context", "layer.md");
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, "index.ts"), "export const value = 1;\n", "utf8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes YAML context with a project overview and stores the latest snapshot", async () => {
    const memoryStore = new ProjectMemoryStore(dbPath);
    try {
      memoryStore.remember({
        projectPath,
        eventType: "progress",
        summary: "Added get_context",
        currentTask: "Build durable context layer",
        createdAt: 1_000
      });

      const writer = new ContextLayerWriter({
        projectPath,
        filePath: contextFilePath,
        memoryStore,
        activityWindowMs: 60_000
      });
      const snapshot = await writer.refresh();
      const written = await readFile(contextFilePath, "utf8");
      const parsed = parseYaml(written) as typeof snapshot;
      const cached = memoryStore.getLatestContextSnapshot(projectPath);

      expect(parsed.activeExecution.currentTask).toBe("Build durable context layer");
      expect(parsed.activeExecution.activeScratchpad[0]?.summary).toBe("Added get_context");
      expect(parsed.dynamicState.contextFilePath).toBe(contextFilePath);
      expect(parsed.staticAnchors.project.name).toBe("repo");
      expect(parsed.staticAnchors.codebase.shape).toContain("repo is a generic codebase");
      expect(parsed.staticAnchors.project.entryPoints).toContain("index.ts");
      expect(parsed.staticAnchors.retrieval.strategy).toBe("AST-first");
      expect(parsed.activeExecution.agentHandoff.preferredTools).toContain("expand_symbol");
      expect(cached?.snapshotText).toContain("Build durable context layer");
      expect(cached?.snapshotText).toContain("staticAnchors:");
      expect(cached?.format).toBe("yaml");
    } finally {
      memoryStore.close();
    }
  });

  it("returns the cached context when refresh is disabled", async () => {
    const memoryStore = new ProjectMemoryStore(dbPath);
    try {
      memoryStore.remember({
        projectPath,
        summary: "Cached context note"
      });
      const writer = new ContextLayerWriter({
        projectPath,
        filePath: contextFilePath,
        memoryStore
      });
      await writer.refresh();

      const context = await readContextLayer({
        projectPath,
        filePath: contextFilePath,
        refresh: false,
        memoryStore
      });

      expect(context).toContain("Cached context note");
      expect(context).toContain("schemaVersion: 4");
    } finally {
      memoryStore.close();
    }
  });

  it("keeps cached schema v3 snapshots readable during migration", async () => {
    const memoryStore = new ProjectMemoryStore(dbPath);
    try {
      memoryStore.saveContextSnapshot({
        projectPath,
        filePath: contextFilePath,
        snapshotText: "schemaVersion: 3\nproject:\n  name: legacy\n",
        format: "yaml",
        updatedAt: 1_000
      });

      const context = await readContextLayer({
        projectPath,
        filePath: contextFilePath,
        refresh: false,
        memoryStore
      });

      expect(context).toContain("schemaVersion: 3");
      expect(context).toContain("name: legacy");
    } finally {
      memoryStore.close();
    }
  });

  it("supports JSON output without changing the YAML file format", async () => {
    const memoryStore = new ProjectMemoryStore(dbPath);
    try {
      const context = await readContextLayer({
        projectPath,
        filePath: contextFilePath,
        format: "json",
        memoryStore
      });
      expect(JSON.parse(context)).toMatchObject({
        schemaVersion: 4,
        staticAnchors: { project: { path: projectPath } }
      });
      expect(await readFile(contextFilePath, "utf8")).toContain("schemaVersion: 4");
    } finally {
      memoryStore.close();
    }
  });

  it("keeps progress notes ahead of index events in recent memory", async () => {
    const memoryStore = new ProjectMemoryStore(dbPath);
    try {
      memoryStore.remember({
        projectPath,
        eventType: "progress",
        summary: "User-visible progress",
        createdAt: 1_000
      });
      memoryStore.remember({
        projectPath,
        eventType: "index",
        summary: "Indexed project",
        createdAt: 2_000
      });

      const writer = new ContextLayerWriter({
        projectPath,
        filePath: contextFilePath,
        memoryStore
      });
      const snapshot = await writer.refresh();

      expect(snapshot.activeExecution.activeScratchpad[0]?.summary).toBe("User-visible progress");
      expect(snapshot.activeExecution.activeScratchpad).toHaveLength(1);
      expect(snapshot.activeExecution.lastNote).toBe("User-visible progress");
    } finally {
      memoryStore.close();
    }
  });

  it("can write a passive background snapshot without changing the active project", async () => {
    const memoryStore = new ProjectMemoryStore(dbPath);
    try {
      memoryStore.setActiveProjectPath("/active-repo", 1_000);

      const writer = new ContextLayerWriter({
        projectPath,
        filePath: contextFilePath,
        memoryStore,
        activateProject: false
      });
      await writer.refresh();

      expect(memoryStore.getActiveProjectPath()).toBe("/active-repo");
    } finally {
      memoryStore.close();
    }
  });

  it("caps noisy working-tree arrays and reports omitted files", async () => {
    spawnSync("git", ["init"], { cwd: projectPath });
    await mkdir(join(projectPath, "src"), { recursive: true });
    for (let index = 0; index < 15; index += 1) {
      await writeFile(
        join(projectPath, "src", `file-${index}.ts`),
        `export const value${index} = ${index};\n`,
        "utf8"
      );
    }

    const memoryStore = new ProjectMemoryStore(dbPath);
    try {
      const writer = new ContextLayerWriter({
        projectPath,
        filePath: contextFilePath,
        memoryStore
      });
      const snapshot = await writer.refresh();

      expect(snapshot.dynamicState.workingTree.totalChangedFiles).toBe(16);
      expect(snapshot.dynamicState.workingTree.changedFiles).toHaveLength(10);
      expect(snapshot.dynamicState.workingTree.omittedFiles).toBe(6);
      expect(snapshot.dynamicState.workingTree.summary).toContain("16 changed files");
    } finally {
      memoryStore.close();
    }
  });

  it("returns compressed related-project context without mixing project memory", async () => {
    const backendPath = join(tempDir, "backend");
    await mkdir(backendPath, { recursive: true });
    await writeFile(join(backendPath, "README.md"), "# Backend API\n", "utf8");
    await writeFile(
      join(tempDir, "infimium.workspace.json"),
      JSON.stringify({
        name: "Example product",
        projects: [
          { id: "frontend", path: "./repo", role: "client", dependsOn: ["backend"] },
          { id: "backend", path: "./backend", role: "api" }
        ]
      }),
      "utf8"
    );

    const memoryStore = new ProjectMemoryStore(dbPath);
    try {
      memoryStore.remember({
        projectPath,
        eventType: "progress",
        summary: "Frontend task"
      });
      memoryStore.remember({
        projectPath: backendPath,
        eventType: "progress",
        summary: "Private backend task"
      });

      const writer = new ContextLayerWriter({
        projectPath,
        filePath: contextFilePath,
        memoryStore
      });
      const snapshot = await writer.refresh();

      expect(snapshot.staticAnchors.workspace).toMatchObject({
        name: "Example product",
        currentProjectId: "frontend",
        totalProjects: 2,
        relationships: [
          {
            sourceProjectId: "frontend",
            targetProjectId: "backend",
            type: "depends_on"
          }
        ]
      });
      expect(snapshot.staticAnchors.workspace?.projects.map((project) => project.id)).toEqual([
        "frontend",
        "backend"
      ]);
      expect(snapshot.activeExecution.activeScratchpad.map((event) => event.summary)).toEqual(["Frontend task"]);
      expect(JSON.stringify(snapshot.staticAnchors.workspace)).not.toContain("Private backend task");
      expect(snapshot.dynamicState.workingTree.changedFiles.every((file) => !file.path.includes("backend"))).toBe(true);
    } finally {
      memoryStore.close();
    }
  });
});
