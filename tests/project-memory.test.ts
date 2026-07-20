import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ProjectMemoryStore,
  formatResumeContext
} from "../src/memory/project-memory.js";

describe("project memory", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "infimium-memory-"));
    dbPath = join(tempDir, "infimium.db");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("remembers progress and returns resume context for a project", () => {
    const store = new ProjectMemoryStore(dbPath);
    try {
      store.remember({
        projectPath: "/repo",
        eventType: "progress",
        summary: "Implemented the context resume command",
        currentTask: "Build project memory",
        createdAt: 1_000
      });
      store.remember({
        projectPath: "/repo",
        eventType: "decision",
        summary: "Use SQLite instead of cloud storage",
        createdAt: 2_000
      });

      const context = store.getResumeContext("/repo", 5);
      const output = formatResumeContext(context, 62_000);

      expect(context.state.currentTask).toBe("Build project memory");
      expect(context.recentEvents).toHaveLength(2);
      expect(context.recentEvents[0]?.summary).toBe("Use SQLite instead of cloud storage");
      expect(store.getWatchedProjectCount()).toBe(1);
      expect(output).toContain("Current task: Build project memory");
      expect(output).toContain("decision: Use SQLite instead of cloud storage");
    } finally {
      store.close();
    }
  });

  it("keeps memory isolated by project path", () => {
    const store = new ProjectMemoryStore(dbPath);
    try {
      store.remember({
        projectPath: "/repo-a",
        summary: "Repo A note"
      });
      store.remember({
        projectPath: "/repo-b",
        summary: "Repo B note"
      });

      expect(store.getResumeContext("/repo-a").recentEvents[0]?.summary).toBe("Repo A note");
      expect(store.getResumeContext("/repo-b").recentEvents[0]?.summary).toBe("Repo B note");
      expect(store.getWatchedProjectCount()).toBe(2);
    } finally {
      store.close();
    }
  });

  it("tracks the active project from memory and context snapshots", () => {
    const store = new ProjectMemoryStore(dbPath);
    try {
      store.remember({
        projectPath: "/repo-a",
        summary: "Repo A note",
        createdAt: 1_000
      });

      expect(store.getActiveProjectPath()).toBe("/repo-a");

      store.saveContextSnapshot({
        projectPath: "/repo-b",
        filePath: "/repo-b/context/layer.md",
        snapshotText: "schemaVersion: 2\n",
        format: "yaml",
        updatedAt: 2_000
      });

      expect(store.getActiveProjectPath()).toBe("/repo-b");
      expect(store.getKnownProjectPaths()).toEqual(["/repo-a", "/repo-b"]);
      expect(store.getWatchedProjectCount()).toBe(2);
    } finally {
      store.close();
    }
  });

  it("creates the data directory when it does not exist", () => {
    const nestedDbPath = join(tempDir, "nested", "data", "infimium.db");
    const store = new ProjectMemoryStore(nestedDbPath);
    try {
      store.remember({
        projectPath: "/repo",
        summary: "Created memory directory"
      });

      expect(store.getResumeContext("/repo").recentEvents[0]?.summary).toBe(
        "Created memory directory"
      );
    } finally {
      store.close();
    }
  });
});
