import { createRequire } from "node:module";
import { relative, resolve } from "node:path";

import { DEP_GRAPH_DB_PATH } from "../indexer/dep-graph.js";
import {
  findWorkspaceProject,
  isPathWithin,
  loadWorkspaceForProject
} from "../workspace/workspace.js";

const require = createRequire(import.meta.url);

export type DepGraphResult = {
  symbol: string;
  definedIn: string | null;
  importedBy: string[];
  imports: string[];
};

type DepGraphToolOptions = {
  sqlitePath?: string;
  codebasePath?: string | null;
};

type SymbolLocationRow = {
  file_path: string;
};

type FilePathRow = {
  file_path: string;
};

export class DepGraphTool {
  private db: import("node:sqlite").DatabaseSync | null = null;
  private readonly sqlitePath: string;
  private readonly codebasePath: string | null;
  private readonly projectPaths: string[];

  constructor(options: DepGraphToolOptions = {}) {
    this.sqlitePath = options.sqlitePath ?? DEP_GRAPH_DB_PATH;
    this.codebasePath = options.codebasePath ? resolve(options.codebasePath) : null;
    const workspace = this.codebasePath
      ? loadWorkspaceForProject(this.codebasePath)
      : null;
    this.projectPaths = workspace?.projects.map((project) => project.path) ??
      (this.codebasePath ? [this.codebasePath] : []);
  }

  query(symbolName: string): DepGraphResult {
    const symbol = normalizeSymbolName(symbolName);
    const definedIn = this.findSymbolFile(symbol);

    if (!definedIn) {
      return {
        symbol,
        definedIn: null,
        importedBy: [],
        imports: []
      };
    }

    return {
      symbol,
      definedIn,
      importedBy: this.findImportedBy(definedIn),
      imports: this.findImports(definedIn)
    };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private findSymbolFile(symbolName: string): string | null {
    const rows = this.getDb()
      .prepare(
        "SELECT file_path FROM symbol_locations WHERE symbol_name = ? ORDER BY line_start"
      )
      .all(symbolName)
      .map(parseSymbolLocationRow)
      .filter((row): row is SymbolLocationRow => row !== null);
    if (this.projectPaths.length === 0) {
      return rows[0]?.file_path ?? null;
    }

    const currentProjectMatch = this.codebasePath
      ? rows.find((row) => isPathWithin(row.file_path, this.codebasePath!))
      : null;
    return currentProjectMatch?.file_path ??
      rows.find((row) =>
        this.projectPaths.some((projectPath) => isPathWithin(row.file_path, projectPath))
      )?.file_path ??
      null;
  }

  private findImportedBy(filePath: string): string[] {
    return this.getDb()
      .prepare("SELECT source_file AS file_path FROM file_imports WHERE imported_file = ? ORDER BY source_file")
      .all(filePath)
      .map(parseFilePathRow)
      .filter((row): row is FilePathRow => row !== null)
      .map((row) => row.file_path);
  }

  private findImports(filePath: string): string[] {
    return this.getDb()
      .prepare("SELECT imported_file AS file_path FROM file_imports WHERE source_file = ? ORDER BY imported_file")
      .all(filePath)
      .map(parseFilePathRow)
      .filter((row): row is FilePathRow => row !== null)
      .map((row) => row.file_path);
  }

  private getDb(): import("node:sqlite").DatabaseSync {
    if (!this.db) {
      const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
      this.db = new DatabaseSync(this.sqlitePath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS file_imports (
          source_file TEXT NOT NULL,
          imported_file TEXT NOT NULL,
          PRIMARY KEY (source_file, imported_file)
        );

        CREATE TABLE IF NOT EXISTS symbol_locations (
          symbol_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          line_start INTEGER,
          PRIMARY KEY (symbol_name, file_path)
        );
      `);
    }

    return this.db;
  }
}

export function formatDepGraphResult(
  result: DepGraphResult,
  codebasePath?: string | null
): string {
  const definedIn = result.definedIn
    ? displayPath(result.definedIn, codebasePath)
    : "Not found";
  const importedBy = formatPathList(result.importedBy, codebasePath);
  const imports = formatPathList(result.imports, codebasePath);

  return [
    `Symbol: ${result.symbol}()`,
    `Defined in: ${definedIn}`,
    "",
    `Imported by (${result.importedBy.length} files):`,
    importedBy,
    "",
    "This file imports:",
    imports
  ].join("\n");
}

export function runDepGraph(
  symbolName: string,
  options: DepGraphToolOptions = {}
): string {
  const tool = new DepGraphTool(options);

  try {
    return formatDepGraphResult(tool.query(symbolName), options.codebasePath);
  } finally {
    tool.close();
  }
}

function formatPathList(paths: string[], codebasePath?: string | null): string {
  if (paths.length === 0) {
    return "  None";
  }

  return paths.map((filePath) => `  → ${displayPath(filePath, codebasePath)}`).join("\n");
}

function displayPath(filePath: string, codebasePath?: string | null): string {
  if (!codebasePath) {
    return filePath;
  }

  const relativePath = relative(codebasePath, filePath);
  if (relativePath && !relativePath.startsWith("..")) {
    return relativePath;
  }

  const workspace = loadWorkspaceForProject(codebasePath);
  const project = workspace ? findWorkspaceProject(workspace, filePath) : null;
  if (project) {
    return `${project.id}:${relative(project.path, filePath)}`;
  }
  return filePath;
}

function normalizeSymbolName(symbolName: string): string {
  return symbolName.trim().replace(/\(\)$/, "");
}

function parseSymbolLocationRow(row: unknown): SymbolLocationRow | null {
  if (!isRecord(row) || typeof row.file_path !== "string") {
    return null;
  }

  return { file_path: row.file_path };
}

function parseFilePathRow(row: unknown): FilePathRow | null {
  if (!isRecord(row) || typeof row.file_path !== "string") {
    return null;
  }

  return { file_path: row.file_path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
