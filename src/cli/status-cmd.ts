import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { dataPath } from "../paths.js";
import { createVectorClient } from "../vector-store.js";

const DOCS_DB_PATH = dataPath("infimium_docs.db");
const CODE_DB_PATH = dataPath("infimium_code.db");
const GRAPH_DB_PATH = dataPath("infimium.db");
const DOCS_COLLECTION_NAME = "infimium_docs";
const STATUS_DIVIDER = "───────────────────────────";
const require = createRequire(import.meta.url);

type Database = import("node:sqlite").DatabaseSync;

type VectorCollectionLike = {
  count(): Promise<number>;
};

type VectorClientLike = {
  getCollection(args: { name: string }): Promise<VectorCollectionLike>;
};

type StatusOptions = {
  docsDbPath?: string;
  codeDbPath?: string;
  graphDbPath?: string;
  vectorClient?: VectorClientLike;
  nowMs?: number;
  projectPath?: string;
};

type InfimiumStatus = {
  docsFiles: number;
  docsChunks: number;
  codeSymbols: number;
  codeFiles: number;
  importRelationships: number;
  watchedProjects: number;
  graphDbSizeBytes: number;
  lastIndexedAt: number | null;
};

type NumberRow = Record<string, number | bigint | null | undefined>;

export async function runStatusCommand(options: StatusOptions = {}): Promise<void> {
  const status = await readInfimiumStatus(options);
  if (!status) {
    console.log("Not indexed. Run: infimium index");
    return;
  }

  console.log(formatStatus(status, options.nowMs));
}

export async function readInfimiumStatus(
  options: StatusOptions = {}
): Promise<InfimiumStatus | null> {
  const docsDbPath = resolve(options.docsDbPath ?? DOCS_DB_PATH);
  const codeDbPath = resolve(options.codeDbPath ?? CODE_DB_PATH);
  const graphDbPath = resolve(options.graphDbPath ?? GRAPH_DB_PATH);

  if (!existsSync(docsDbPath) && !existsSync(codeDbPath) && !existsSync(graphDbPath)) {
    return null;
  }

  const projectPath = options.projectPath ? resolve(options.projectPath) : null;
  const docsStats = readDocsStats(docsDbPath, projectPath);
  const codeStats = readCodeStats(codeDbPath, projectPath);
  const graphStats = readGraphStats(graphDbPath, projectPath);
  const vectorChunks = projectPath
    ? null
    : await readVectorCollectionCount(
        options.vectorClient ?? createVectorClient(),
        DOCS_COLLECTION_NAME
      );

  return {
    docsFiles: docsStats.files,
    docsChunks: vectorChunks ?? docsStats.chunks,
    codeSymbols: codeStats.symbols,
    codeFiles: codeStats.files,
    importRelationships: graphStats.importRelationships,
    watchedProjects: graphStats.watchedProjects,
    graphDbSizeBytes: existsSync(graphDbPath) ? statSync(graphDbPath).size : 0,
    lastIndexedAt: codeStats.lastIndexedAt
  };
}

export function formatStatus(status: InfimiumStatus, nowMs: number = Date.now()): string {
  return [
    STATUS_DIVIDER,
    "  Infimium status",
    STATUS_DIVIDER,
    statusLine("Docs", `${status.docsFiles} files · ${status.docsChunks} chunks`),
    statusLine("Code", `${status.codeSymbols} symbols · ${status.codeFiles} files`),
    statusLine("Dep graph", `${status.importRelationships} relationships`),
    statusLine("Projects", `${status.watchedProjects} watched`),
    statusLine("DB size", formatMegabytes(status.graphDbSizeBytes)),
    statusLine("Last indexed", formatRelativeTime(status.lastIndexedAt, nowMs)),
    STATUS_DIVIDER
  ].join("\n");
}

function readDocsStats(
  dbPath: string,
  projectPath: string | null
): { files: number; chunks: number } {
  return withExistingDb(dbPath, (db) => {
    if (!tableExists(db, "indexed_docs")) {
      return { files: 0, chunks: 0 };
    }

    const row = projectPath
      ? db
          .prepare(
            `SELECT COUNT(*) AS files, COALESCE(SUM(chunk_count), 0) AS chunks
             FROM indexed_docs WHERE file_path = ? OR file_path LIKE ?`
          )
          .get(projectPath, `${projectPath}/%`) as NumberRow | undefined
      : db
          .prepare(
            "SELECT COUNT(*) AS files, COALESCE(SUM(chunk_count), 0) AS chunks FROM indexed_docs"
          )
          .get() as NumberRow | undefined;

    return {
      files: readNumber(row, "files"),
      chunks: readNumber(row, "chunks")
    };
  }) ?? { files: 0, chunks: 0 };
}

function readCodeStats(
  dbPath: string,
  projectPath: string | null
): { files: number; symbols: number; lastIndexedAt: number | null } {
  return withExistingDb(dbPath, (db) => {
    if (!tableExists(db, "indexed_code_files")) {
      return { files: 0, symbols: 0, lastIndexedAt: null };
    }

    const baseSql =
        `SELECT
          COUNT(*) AS files,
          COALESCE(SUM(symbol_count), 0) AS symbols,
          MAX(indexed_at) AS lastIndexedAt
         FROM indexed_code_files`;
    const row = projectPath
      ? db
          .prepare(`${baseSql} WHERE file_path = ? OR file_path LIKE ?`)
          .get(projectPath, `${projectPath}/%`) as NumberRow | undefined
      : db.prepare(baseSql).get() as NumberRow | undefined;

    return {
      files: readNumber(row, "files"),
      symbols: readNumber(row, "symbols"),
      lastIndexedAt: readNullableNumber(row, "lastIndexedAt")
    };
  }) ?? { files: 0, symbols: 0, lastIndexedAt: null };
}

function readGraphStats(
  dbPath: string,
  projectPath: string | null
): { importRelationships: number; watchedProjects: number } {
  return withExistingDb(dbPath, (db) => ({
    importRelationships: [
      tableExists(db, "file_imports")
        ? projectPath
          ? readParameterizedCount(
              db,
              "SELECT COUNT(*) AS count FROM file_imports WHERE source_file = ? OR source_file LIKE ?",
              [projectPath, `${projectPath}/%`]
            )
          : readCount(db, "SELECT COUNT(*) AS count FROM file_imports")
        : 0,
      tableExists(db, "symbol_calls")
        ? projectPath
          ? readParameterizedCount(
              db,
              "SELECT COUNT(*) AS count FROM symbol_calls WHERE caller_file = ? OR caller_file LIKE ?",
              [projectPath, `${projectPath}/%`]
            )
          : readCount(db, "SELECT COUNT(*) AS count FROM symbol_calls")
        : 0,
      tableExists(db, "http_routes")
        ? projectPath
          ? readParameterizedCount(
              db,
              "SELECT COUNT(*) AS count FROM http_routes WHERE file_path = ? OR file_path LIKE ?",
              [projectPath, `${projectPath}/%`]
            )
          : readCount(db, "SELECT COUNT(*) AS count FROM http_routes")
        : 0
    ].reduce((total, count) => total + count, 0),
    watchedProjects: readWatchedProjectCount(db)
  })) ?? { importRelationships: 0, watchedProjects: 0 };
}

function readWatchedProjectCount(db: Database): number {
  const tables = ["project_changes", "project_state", "context_snapshots"].filter((tableName) =>
    tableExists(db, tableName)
  );

  if (tables.length === 0) {
    return 0;
  }

  return readCount(
    db,
    `SELECT COUNT(DISTINCT project_path) AS count FROM (${tables
      .map((tableName) => `SELECT project_path FROM ${tableName}`)
      .join(" UNION ")})`
  );
}

async function readVectorCollectionCount(
  vectorClient: VectorClientLike,
  collectionName: string
): Promise<number | null> {
  try {
    const collection = await vectorClient.getCollection({ name: collectionName });
    return collection.count();
  } catch {
    return null;
  }
}

function withExistingDb<T>(dbPath: string, read: (db: Database) => T): T | null {
  if (!existsSync(dbPath)) {
    return null;
  }

  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);

  return row !== undefined;
}

function readCount(db: Database, sql: string): number {
  const row = db.prepare(sql).get() as NumberRow | undefined;
  return readNumber(row, "count");
}

function readParameterizedCount(db: Database, sql: string, values: string[]): number {
  const row = db.prepare(sql).get(...values) as NumberRow | undefined;
  return readNumber(row, "count");
}

function readNumber(row: NumberRow | undefined, key: string): number {
  return readNullableNumber(row, key) ?? 0;
}

function readNullableNumber(row: NumberRow | undefined, key: string): number | null {
  const value = row?.[key];
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  return null;
}

function statusLine(label: string, value: string): string {
  return `  ${label.padEnd(12)} ${value}`;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatRelativeTime(timestampMs: number | null, nowMs: number): string {
  if (!timestampMs) {
    return "never";
  }

  const elapsedMs = Math.max(0, nowMs - timestampMs);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  if (elapsedSeconds < 60) {
    return elapsedSeconds === 1 ? "1 second ago" : `${elapsedSeconds} seconds ago`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return elapsedMinutes === 1 ? "1 minute ago" : `${elapsedMinutes} minutes ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return elapsedHours === 1 ? "1 hour ago" : `${elapsedHours} hours ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return elapsedDays === 1 ? "1 day ago" : `${elapsedDays} days ago`;
}
