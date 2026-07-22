import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDeterministicCompaction,
  compactProjectMemory
} from "../src/memory/memory-compactor.js";
import { ProjectMemoryStore } from "../src/memory/project-memory.js";

describe("memory compactor", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "infimium-compactor-"));
    dbPath = join(tempDir, "infimium.db");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("compresses scratchpad events without requiring Ollama", async () => {
    const store = new ProjectMemoryStore(dbPath);
    try {
      store.remember({
        projectPath: tempDir,
        currentTask: "Build memory compaction",
        eventType: "progress",
        summary: "Added src/memory/memory-compactor.ts",
        createdAt: 1_000
      });
      store.remember({
        projectPath: tempDir,
        eventType: "decision",
        summary: "Keep get_context network-free",
        details: "Compaction runs on explicit task completion",
        createdAt: 2_000
      });
      store.remember({
        projectPath: tempDir,
        eventType: "blocker",
        summary: "Need migration coverage",
        createdAt: 3_000
      });

      const result = await compactProjectMemory({
        projectPath: tempDir,
        useModel: false,
        store
      });

      expect(result.usedModel).toBe(false);
      expect(result.scratchpadEvents).toBe(3);
      expect(result.archive.summary).toContain("Key outcomes");
      expect(result.archive.relevantFiles).toContain("src/memory/memory-compactor.ts");
      expect(store.getActiveSession(tempDir)).toBeNull();
      expect(store.getRelevantLedger(tempDir).map((entry) => entry.category)).toEqual([
        "blocker",
        "decision"
      ]);
    } finally {
      store.close();
    }
  });

  it("deduplicates repeated scratchpad events", () => {
    const result = buildDeterministicCompaction("/repo", "Fix auth", [
      {
        id: 1,
        sessionId: "one",
        projectPath: "/repo",
        eventType: "progress",
        summary: "Updated auth flow",
        details: null,
        createdAt: 1,
        compactedAt: null
      },
      {
        id: 2,
        sessionId: "one",
        projectPath: "/repo",
        eventType: "progress",
        summary: "Updated auth flow",
        details: null,
        createdAt: 2,
        compactedAt: null
      }
    ]);

    expect(result.summary.match(/Updated auth flow/g)).toHaveLength(1);
  });

  it("does not create an archive without an active session", async () => {
    const store = new ProjectMemoryStore(dbPath);
    try {
      await expect(compactProjectMemory({
        projectPath: tempDir,
        useModel: false,
        store
      })).rejects.toThrow("No active memory session");
    } finally {
      store.close();
    }
  });

  it("rejects placeholder and ungrounded model output before storage", async () => {
    const store = new ProjectMemoryStore(dbPath);
    try {
      store.remember({
        projectPath: tempDir,
        currentTask: "Validate model compaction",
        eventType: "decision",
        summary: "Keep get_context network-free in src/memory/context-layer.ts",
        createdAt: 1_000
      });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            milestone: "short completed milestone",
            summary: "Validated memory compaction. Some important work remains unresolved.",
            durableMemories: [{
              category: "decision",
              key: "context-network",
              value: "Keep get_context network-free",
              confidence: 0.9
            }],
            unresolvedBlockers: ["Invented deployment blocker"],
            relevantFiles: ["src/memory/context-layer.ts", "src/invented.ts"]
          })
        })
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await compactProjectMemory({ projectPath: tempDir, store });
      const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const requestBody = JSON.parse(String(request.body)) as { format?: unknown };

      expect(requestBody.format).toMatchObject({ type: "object" });
      expect(result.archive.milestone).toBe("Validate model compaction");
      expect(result.archive.summary).not.toContain("unresolved");
      expect(result.archive.unresolvedBlockers).toEqual([]);
      expect(result.archive.relevantFiles).toEqual(["src/memory/context-layer.ts"]);
      expect(store.getRelevantLedger(tempDir)[0]?.key).toBe("context-network");
    } finally {
      store.close();
    }
  });
});
