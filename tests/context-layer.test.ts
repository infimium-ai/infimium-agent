import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  it("writes JSON context to layer.md and stores the latest snapshot in SQLite", async () => {
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
      const parsed = JSON.parse(written) as typeof snapshot;
      const cached = memoryStore.getLatestContextSnapshot(projectPath);

      expect(parsed.currentTask).toBe("Build durable context layer");
      expect(parsed.recentMemory[0]?.summary).toBe("Added get_context");
      expect(parsed.contextFilePath).toBe(contextFilePath);
      expect(cached?.snapshotJson).toContain("Build durable context layer");
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

      expect(snapshot.recentMemory[0]?.summary).toBe("User-visible progress");
      expect(snapshot.recentMemory[1]?.summary).toBe("Indexed project");
      expect(snapshot.lastNote).toBe("User-visible progress");
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
});
