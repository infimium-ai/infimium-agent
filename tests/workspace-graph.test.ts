import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadWorkspace } from "../src/workspace/workspace.js";
import { WorkspaceGraphStore } from "../src/workspace/workspace-graph.js";

const require = createRequire(import.meta.url);

describe("workspace graph", () => {
  let rootPath: string;
  let dbPath: string;
  let frontendPath: string;
  let backendPath: string;
  let manifestPath: string;

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), "infimium-workspace-graph-"));
    dbPath = join(rootPath, "infimium.db");
    frontendPath = join(rootPath, "frontend");
    backendPath = join(rootPath, "backend");
    manifestPath = join(rootPath, "infimium.workspace.json");
    await mkdir(frontendPath);
    await mkdir(backendPath);
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: "Product",
        projects: [
          { id: "frontend", path: "./frontend", dependsOn: ["backend"] },
          { id: "backend", path: "./backend" }
        ]
      }),
      "utf8"
    );

    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE file_imports (
        source_file TEXT NOT NULL,
        imported_file TEXT NOT NULL,
        PRIMARY KEY (source_file, imported_file)
      );
    `);
    db.prepare("INSERT INTO file_imports VALUES (?, ?)").run(
      join(frontendPath, "client.ts"),
      join(backendPath, "api.ts")
    );
    db.close();
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  it("stores declared dependencies and derives cross-project import edges", () => {
    const store = new WorkspaceGraphStore(dbPath);
    try {
      const graph = store.sync(loadWorkspace(manifestPath), 1_000);
      expect(graph.relationships).toEqual([
        {
          sourceProjectId: "frontend",
          targetProjectId: "backend",
          type: "depends_on",
          weight: 1
        },
        {
          sourceProjectId: "frontend",
          targetProjectId: "backend",
          type: "imports",
          weight: 1
        }
      ]);
    } finally {
      store.close();
    }
  });

  it("can read without initializing graph tables", () => {
    const emptyDbPath = join(rootPath, "read-only.db");
    const store = new WorkspaceGraphStore(emptyDbPath, { initialize: false });
    try {
      expect(store.get("missing")).toEqual({
        workspaceId: "missing",
        relationships: []
      });
    } finally {
      store.close();
    }
  });
});
