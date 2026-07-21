import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { dataPath } from "../paths.js";
import {
  findWorkspaceProject,
  type InfimiumWorkspace
} from "./workspace.js";

const require = createRequire(import.meta.url);

type Database = import("node:sqlite").DatabaseSync;

export type WorkspaceGraphRelationship = {
  sourceProjectId: string;
  targetProjectId: string;
  type: "depends_on" | "imports";
  weight: number;
};

export type WorkspaceGraphSnapshot = {
  workspaceId: string;
  relationships: WorkspaceGraphRelationship[];
};

export type WorkspaceGraphStoreOptions = {
  initialize?: boolean;
};

export class WorkspaceGraphStore {
  private readonly db: Database;

  constructor(
    sqlitePath: string = dataPath("infimium.db"),
    options: WorkspaceGraphStoreOptions = {}
  ) {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const resolvedPath = resolve(sqlitePath);
    mkdirSync(dirname(resolvedPath), { recursive: true });
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (options.initialize ?? true) {
      this.ensureSchema();
    }
  }

  sync(workspace: InfimiumWorkspace, updatedAt: number = Date.now()): WorkspaceGraphSnapshot {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO workspaces
            (workspace_id, name, manifest_path, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET
            name = excluded.name,
            manifest_path = excluded.manifest_path,
            updated_at = excluded.updated_at`
        )
        .run(workspace.workspaceId, workspace.name, workspace.manifestPath, updatedAt);

      this.db
        .prepare("DELETE FROM workspace_projects WHERE workspace_id = ?")
        .run(workspace.workspaceId);
      this.db
        .prepare("DELETE FROM workspace_relationships WHERE workspace_id = ?")
        .run(workspace.workspaceId);

      const insertProject = this.db.prepare(
        `INSERT INTO workspace_projects
          (workspace_id, project_id, project_path, role)
         VALUES (?, ?, ?, ?)`
      );
      for (const project of workspace.projects) {
        insertProject.run(workspace.workspaceId, project.id, project.path, project.role);
      }

      const insertRelationship = this.db.prepare(
        `INSERT INTO workspace_relationships
          (workspace_id, source_project_id, target_project_id, relationship_type, weight)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, source_project_id, target_project_id, relationship_type)
         DO UPDATE SET weight = excluded.weight`
      );
      for (const project of workspace.projects) {
        for (const targetId of project.dependsOn) {
          insertRelationship.run(
            workspace.workspaceId,
            project.id,
            targetId,
            "depends_on",
            1
          );
        }
      }

      for (const relationship of this.readCrossProjectImports(workspace)) {
        insertRelationship.run(
          workspace.workspaceId,
          relationship.sourceProjectId,
          relationship.targetProjectId,
          relationship.type,
          relationship.weight
        );
      }

      this.db.exec("COMMIT");
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.get(workspace.workspaceId);
  }

  get(workspaceId: string): WorkspaceGraphSnapshot {
    if (!this.tableExists("workspace_relationships")) {
      return { workspaceId, relationships: [] };
    }

    const rows = this.db
      .prepare(
        `SELECT source_project_id, target_project_id, relationship_type, weight
         FROM workspace_relationships
         WHERE workspace_id = ?
         ORDER BY relationship_type, source_project_id, target_project_id`
      )
      .all(workspaceId) as Array<Record<string, unknown>>;

    return {
      workspaceId,
      relationships: rows
        .map(parseRelationship)
        .filter((value): value is WorkspaceGraphRelationship => value !== null)
    };
  }

  close(): void {
    this.db.close();
  }

  private readCrossProjectImports(
    workspace: InfimiumWorkspace
  ): WorkspaceGraphRelationship[] {
    if (!this.tableExists("file_imports")) {
      return [];
    }

    const rows = this.db
      .prepare("SELECT source_file, imported_file FROM file_imports")
      .all() as Array<{ source_file?: unknown; imported_file?: unknown }>;
    const counts = new Map<string, WorkspaceGraphRelationship>();

    for (const row of rows) {
      if (typeof row.source_file !== "string" || typeof row.imported_file !== "string") {
        continue;
      }
      const source = findWorkspaceProject(workspace, row.source_file);
      const target = findWorkspaceProject(workspace, row.imported_file);
      if (!source || !target || source.id === target.id) {
        continue;
      }

      const key = `${source.id}\0${target.id}`;
      const existing = counts.get(key);
      if (existing) {
        existing.weight += 1;
      } else {
        counts.set(key, {
          sourceProjectId: source.id,
          targetProjectId: target.id,
          type: "imports",
          weight: 1
        });
      }
    }

    return [...counts.values()];
  }

  private tableExists(tableName: string): boolean {
    return this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) !== undefined;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        manifest_path TEXT NOT NULL UNIQUE,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_projects (
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        role TEXT,
        PRIMARY KEY (workspace_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS workspace_relationships (
        workspace_id TEXT NOT NULL,
        source_project_id TEXT NOT NULL,
        target_project_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        weight INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (
          workspace_id,
          source_project_id,
          target_project_id,
          relationship_type
        )
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_projects_path
        ON workspace_projects(project_path);
    `);
  }
}

function parseRelationship(row: Record<string, unknown>): WorkspaceGraphRelationship | null {
  const sourceProjectId = row.source_project_id;
  const targetProjectId = row.target_project_id;
  const type = row.relationship_type;
  const weight = row.weight;
  if (
    typeof sourceProjectId !== "string" ||
    typeof targetProjectId !== "string" ||
    (type !== "depends_on" && type !== "imports") ||
    (typeof weight !== "number" && typeof weight !== "bigint")
  ) {
    return null;
  }

  return {
    sourceProjectId,
    targetProjectId,
    type,
    weight: Number(weight)
  };
}
