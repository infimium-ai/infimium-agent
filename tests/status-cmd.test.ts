import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatStatus,
  readInfimiumStatus
} from "../src/cli/status-cmd.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function createDb(dbPath: string, sql: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

describe("status command", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "infimium-status-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns null when no SQLite index exists", async () => {
    const status = await readInfimiumStatus({
      docsDbPath: join(tempDir, "missing-docs.db"),
      codeDbPath: join(tempDir, "missing-code.db"),
      graphDbPath: join(tempDir, "missing-graph.db"),
      chromaClient: {
        getCollection: vi.fn()
      }
    });

    expect(status).toBeNull();
  });

  it("reads docs, code, graph, project, and Chroma counts", async () => {
    const docsDbPath = join(tempDir, "infimium_docs.db");
    const codeDbPath = join(tempDir, "infimium_code.db");
    const graphDbPath = join(tempDir, "infimium.db");
    const lastIndexedAt = 1_800_000;

    createDb(
      docsDbPath,
      `
        CREATE TABLE indexed_docs (
          file_path TEXT PRIMARY KEY,
          indexed_at INTEGER,
          mtime INTEGER,
          chunk_count INTEGER
        );
        INSERT INTO indexed_docs VALUES ('a.md', 1, 1, 3);
        INSERT INTO indexed_docs VALUES ('b.md', 1, 1, 4);
      `
    );
    createDb(
      codeDbPath,
      `
        CREATE TABLE indexed_code_files (
          file_path TEXT PRIMARY KEY,
          content_hash TEXT,
          indexed_at INTEGER,
          symbol_count INTEGER
        );
        INSERT INTO indexed_code_files VALUES ('a.ts', 'one', ${lastIndexedAt - 1000}, 5);
        INSERT INTO indexed_code_files VALUES ('b.ts', 'two', ${lastIndexedAt}, 7);
      `
    );
    createDb(
      graphDbPath,
      `
        CREATE TABLE file_imports (
          source_file TEXT NOT NULL,
          imported_file TEXT NOT NULL,
          PRIMARY KEY (source_file, imported_file)
        );
        CREATE TABLE project_changes (
          project_path TEXT NOT NULL
        );
        INSERT INTO file_imports VALUES ('a.ts', 'b.ts');
        INSERT INTO file_imports VALUES ('c.ts', 'b.ts');
        INSERT INTO project_changes VALUES ('/one');
        INSERT INTO project_changes VALUES ('/one');
        INSERT INTO project_changes VALUES ('/two');
      `
    );

    const chromaCount = vi.fn().mockResolvedValue(11);
    const status = await readInfimiumStatus({
      docsDbPath,
      codeDbPath,
      graphDbPath,
      chromaClient: {
        getCollection: vi.fn().mockResolvedValue({
          count: chromaCount
        })
      }
    });

    expect(status).toMatchObject({
      docsFiles: 2,
      docsChunks: 11,
      codeFiles: 2,
      codeSymbols: 12,
      importRelationships: 2,
      watchedProjects: 2,
      lastIndexedAt
    });
    expect(chromaCount).toHaveBeenCalledOnce();
  });

  it("formats the status panel", () => {
    expect(
      formatStatus(
        {
          docsFiles: 47,
          docsChunks: 312,
          codeSymbols: 847,
          codeFiles: 124,
          importRelationships: 312,
          watchedProjects: 2,
          graphDbSizeBytes: 2.1 * 1024 * 1024,
          lastIndexedAt: 1_000_000
        },
        1_000_000 + 2 * 60 * 60 * 1000
      )
    ).toBe(
      [
        "───────────────────────────",
        "  Infimium status",
        "───────────────────────────",
        "  Docs         47 files · 312 chunks",
        "  Code         847 symbols · 124 files",
        "  Dep graph    312 relationships",
        "  Projects     2 watched",
        "  DB size      2.1 MB",
        "  Last indexed 2 hours ago",
        "───────────────────────────"
      ].join("\n")
    );
  });
});
