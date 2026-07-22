import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

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

  it("stores active work in a project-scoped scratchpad session", () => {
    const store = new ProjectMemoryStore(dbPath);
    try {
      store.remember({
        projectPath: "/repo",
        currentTask: "Ship memory compaction",
        eventType: "progress",
        summary: "Added the session schema",
        createdAt: 1_000
      });
      store.remember({
        projectPath: "/repo",
        eventType: "decision",
        summary: "Keep get_context deterministic",
        createdAt: 2_000
      });

      const context = store.getResumeContext("/repo", 5);
      expect(context.activeSession?.task).toBe("Ship memory compaction");
      expect(context.activeScratchpad.map((event) => event.summary)).toEqual([
        "Added the session schema",
        "Keep get_context deterministic"
      ]);
      expect(store.getResumeContext("/other").activeSession).toBeNull();
    } finally {
      store.close();
    }
  });

  it("archives a completed session and supersedes changed ledger values", () => {
    const store = new ProjectMemoryStore(dbPath);
    try {
      store.remember({ projectPath: "/repo", summary: "Started work", createdAt: 1_000 });
      const session = store.getActiveSession("/repo");
      expect(session).not.toBeNull();
      if (!session) return;

      const first = store.completeSession({
        projectPath: "/repo",
        sessionId: session.id,
        milestone: "Memory foundation",
        summary: "Added session-scoped memory.",
        durableMemories: [{
          category: "decision",
          key: "context-compiler",
          value: "Keep get_context deterministic",
          confidence: 0.9
        }],
        unresolvedBlockers: [],
        relevantFiles: ["src/memory/project-memory.ts"],
        completedAt: 2_000
      });
      const repeated = store.completeSession({
        projectPath: "/repo",
        sessionId: session.id,
        milestone: "Ignored duplicate",
        summary: "Should not replace the archive.",
        durableMemories: [],
        unresolvedBlockers: [],
        relevantFiles: [],
        completedAt: 3_000
      });

      expect(repeated.id).toBe(first.id);
      expect(store.getActiveSession("/repo")).toBeNull();
      expect(store.getRecentArchives("/repo")[0]?.milestone).toBe("Memory foundation");
      expect(store.getRelevantLedger("/repo")[0]?.value).toBe("Keep get_context deterministic");

      store.supersedeLedgerEntry(
        "/repo",
        "context-compiler",
        "Keep get_context deterministic and network-free",
        "decision"
      );
      expect(store.getRelevantLedger("/repo")[0]?.value).toContain("network-free");
    } finally {
      store.close();
    }
  });

  it("searches compacted archive and ledger memory", () => {
    const store = new ProjectMemoryStore(dbPath);
    try {
      store.remember({ projectPath: "/repo", summary: "Started auth work", createdAt: 1_000 });
      const session = store.getActiveSession("/repo");
      if (!session) throw new Error("Expected active session");
      store.completeSession({
        projectPath: "/repo",
        sessionId: session.id,
        milestone: "Authentication",
        summary: "Implemented JWT login and refreshed expired tokens.",
        durableMemories: [{
          category: "rule",
          key: "auth-header",
          value: "All API calls require the authorization header",
          confidence: 1
        }],
        unresolvedBlockers: [],
        relevantFiles: [],
        completedAt: 2_000
      });

      const results = store.searchMemory("/repo", "authorization auth");
      expect(results.map((result) => result.source)).toContain("ledger");
      expect(results.map((result) => result.source)).toContain("archive");
    } finally {
      store.close();
    }
  });

  it("imports legacy project_changes into a non-destructive active session", () => {
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE project_changes (
        project_path TEXT NOT NULL,
        event_type TEXT,
        summary TEXT,
        details TEXT,
        created_at INTEGER
      );
      CREATE TABLE project_state (
        project_path TEXT PRIMARY KEY,
        current_task TEXT,
        last_plan_path TEXT,
        last_note TEXT,
        updated_at INTEGER
      );
    `);
    legacyDb.prepare("INSERT INTO project_changes VALUES (?, 'progress', ?, NULL, ?)")
      .run("/legacy", "Implemented authentication", 1_000);
    legacyDb.prepare("INSERT INTO project_changes VALUES (?, 'decision', ?, NULL, ?)")
      .run("/legacy", "Use JWT refresh tokens", 2_000);
    legacyDb.prepare("INSERT INTO project_state VALUES (?, ?, NULL, ?, ?)")
      .run("/legacy", "Finish authentication", "Use JWT refresh tokens", 2_000);
    legacyDb.close();

    const store = new ProjectMemoryStore(dbPath);
    try {
      const context = store.getResumeContext("/legacy", 5);
      expect(context.activeSession?.task).toBe("Finish authentication");
      expect(context.activeScratchpad.map((event) => event.summary)).toEqual([
        "Implemented authentication",
        "Use JWT refresh tokens"
      ]);

      const legacyCheck = new Database(dbPath, { readonly: true });
      const count = legacyCheck.prepare("SELECT COUNT(*) AS count FROM project_changes").get() as { count: number };
      legacyCheck.close();
      expect(count.count).toBe(2);
    } finally {
      store.close();
    }
  });

  it("bounds legacy events and context snapshot history per project", () => {
    const store = new ProjectMemoryStore(dbPath);
    try {
      for (let index = 0; index < 505; index += 1) {
        store.remember({
          projectPath: "/repo",
          eventType: "index",
          summary: `Index event ${index}`,
          createdAt: index + 1
        });
      }
      for (let index = 0; index < 105; index += 1) {
        store.saveContextSnapshot({
          projectPath: "/repo",
          filePath: "/repo/context/layer.md",
          snapshotText: `schemaVersion: 4\nsequence: ${index}\n`,
          format: "yaml",
          updatedAt: index + 1
        });
      }

      const db = new Database(dbPath, { readonly: true });
      const eventCount = db.prepare(
        "SELECT COUNT(*) AS count FROM project_changes WHERE project_path = '/repo'"
      ).get() as { count: number };
      const snapshotCount = db.prepare(
        "SELECT COUNT(*) AS count FROM context_snapshot_history WHERE project_path = '/repo'"
      ).get() as { count: number };
      db.close();

      expect(eventCount.count).toBe(500);
      expect(snapshotCount.count).toBe(100);
    } finally {
      store.close();
    }
  });

  it("normalizes duplicate legacy active sessions before enforcing uniqueness", () => {
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE memory_sessions (
        id TEXT PRIMARY KEY, project_path TEXT NOT NULL, task TEXT,
        status TEXT NOT NULL, started_at INTEGER NOT NULL,
        completed_at INTEGER, compacted_at INTEGER
      );
      INSERT INTO memory_sessions VALUES
        ('older', '/repo', 'Old task', 'active', 1000, NULL, NULL),
        ('newer', '/repo', 'Current task', 'active', 2000, NULL, NULL);
    `);
    legacyDb.close();

    const store = new ProjectMemoryStore(dbPath);
    try {
      expect(store.getActiveSession("/repo")?.id).toBe("newer");
      const db = new Database(dbPath, { readonly: true });
      const older = db.prepare("SELECT status FROM memory_sessions WHERE id = 'older'").get() as {
        status: string;
      };
      db.close();
      expect(older.status).toBe("abandoned");
    } finally {
      store.close();
    }
  });
});
