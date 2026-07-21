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
  calledBy: SymbolCallResult[];
  calls: SymbolCallResult[];
  routes: HttpRouteResult[];
};

export type SymbolCallResult = {
  symbol: string;
  filePath: string;
  lineStart: number;
};

export type HttpRouteResult = {
  method: string;
  path: string;
  filePath: string;
  lineStart: number;
  framework: string;
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

type SymbolCallRow = {
  symbol: string;
  file_path: string;
  line_start: number;
};

type HttpRouteRow = {
  method: string;
  route_path: string;
  file_path: string;
  line_start: number;
  framework: string;
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
        imports: [],
        calledBy: [],
        calls: [],
        routes: []
      };
    }

    return {
      symbol,
      definedIn,
      importedBy: this.findImportedBy(definedIn),
      imports: this.findImports(definedIn),
      calledBy: this.findCalledBy(symbol),
      calls: this.findCalls(symbol),
      routes: this.findRoutes(symbol)
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
      .filter((row) => this.isKnownProjectPath(row.file_path))
      .map((row) => row.file_path);
  }

  private findImports(filePath: string): string[] {
    return this.getDb()
      .prepare("SELECT imported_file AS file_path FROM file_imports WHERE source_file = ? ORDER BY imported_file")
      .all(filePath)
      .map(parseFilePathRow)
      .filter((row): row is FilePathRow => row !== null)
      .filter((row) => this.isKnownProjectPath(row.file_path))
      .map((row) => row.file_path);
  }

  private findCalledBy(symbolName: string): SymbolCallResult[] {
    return this.getDb()
      .prepare(
        `SELECT caller_symbol AS symbol, caller_file AS file_path, line_start
         FROM symbol_calls WHERE callee_symbol = ?
         ORDER BY caller_file, line_start`
      )
      .all(symbolName)
      .map(parseSymbolCallRow)
      .filter((row): row is SymbolCallRow => row !== null)
      .filter((row) => this.isKnownProjectPath(row.file_path))
      .map(toSymbolCallResult);
  }

  private findCalls(symbolName: string): SymbolCallResult[] {
    return this.getDb()
      .prepare(
        `SELECT callee_symbol AS symbol, caller_file AS file_path, line_start
         FROM symbol_calls WHERE caller_symbol = ?
         ORDER BY line_start, callee_symbol`
      )
      .all(symbolName)
      .map(parseSymbolCallRow)
      .filter((row): row is SymbolCallRow => row !== null)
      .filter((row) => this.isKnownProjectPath(row.file_path))
      .map(toSymbolCallResult);
  }

  private findRoutes(symbolName: string): HttpRouteResult[] {
    return this.getDb()
      .prepare(
        `SELECT method, route_path, file_path, line_start, framework
         FROM http_routes WHERE handler_symbol = ?
         ORDER BY file_path, line_start`
      )
      .all(symbolName)
      .map(parseHttpRouteRow)
      .filter((row): row is HttpRouteRow => row !== null)
      .filter((row) => this.isKnownProjectPath(row.file_path))
      .map((row) => ({
        method: row.method,
        path: row.route_path,
        filePath: row.file_path,
        lineStart: row.line_start,
        framework: row.framework
      }));
  }

  private isKnownProjectPath(filePath: string): boolean {
    return this.projectPaths.length === 0 ||
      this.projectPaths.some((projectPath) => isPathWithin(filePath, projectPath));
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

        CREATE TABLE IF NOT EXISTS symbol_calls (
          caller_symbol TEXT NOT NULL,
          caller_file TEXT NOT NULL,
          callee_symbol TEXT NOT NULL,
          line_start INTEGER NOT NULL,
          PRIMARY KEY (caller_symbol, caller_file, callee_symbol, line_start)
        );

        CREATE TABLE IF NOT EXISTS http_routes (
          method TEXT NOT NULL,
          route_path TEXT NOT NULL,
          handler_symbol TEXT NOT NULL,
          file_path TEXT NOT NULL,
          line_start INTEGER NOT NULL,
          framework TEXT NOT NULL,
          PRIMARY KEY (method, route_path, file_path, line_start)
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
  const calledBy = formatCallList(result.calledBy, codebasePath);
  const calls = formatCallList(result.calls, codebasePath);
  const routes = formatRouteList(result.routes, codebasePath);

  return [
    `Symbol: ${result.symbol}()`,
    `Defined in: ${definedIn}`,
    "",
    `Imported by (${result.importedBy.length} files):`,
    importedBy,
    "",
    "This file imports:",
    imports,
    "",
    `Called by (${result.calledBy.length} symbols):`,
    calledBy,
    "",
    `Calls (${result.calls.length} symbols):`,
    calls,
    "",
    `HTTP routes (${result.routes.length}):`,
    routes
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

function formatCallList(calls: SymbolCallResult[], codebasePath?: string | null): string {
  if (calls.length === 0) return "  None";
  return calls
    .map((call) => `  → ${call.symbol}() — ${displayPath(call.filePath, codebasePath)}:${call.lineStart}`)
    .join("\n");
}

function formatRouteList(routes: HttpRouteResult[], codebasePath?: string | null): string {
  if (routes.length === 0) return "  None";
  return routes
    .map(
      (route) =>
        `  → ${route.method} ${route.path} — ${displayPath(route.filePath, codebasePath)}:${route.lineStart} (${route.framework})`
    )
    .join("\n");
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
  return "[outside workspace]";
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

function parseSymbolCallRow(row: unknown): SymbolCallRow | null {
  if (
    !isRecord(row) ||
    typeof row.symbol !== "string" ||
    typeof row.file_path !== "string" ||
    typeof row.line_start !== "number"
  ) return null;
  return { symbol: row.symbol, file_path: row.file_path, line_start: row.line_start };
}

function toSymbolCallResult(row: SymbolCallRow): SymbolCallResult {
  return { symbol: row.symbol, filePath: row.file_path, lineStart: row.line_start };
}

function parseHttpRouteRow(row: unknown): HttpRouteRow | null {
  if (
    !isRecord(row) ||
    typeof row.method !== "string" ||
    typeof row.route_path !== "string" ||
    typeof row.file_path !== "string" ||
    typeof row.line_start !== "number" ||
    typeof row.framework !== "string"
  ) return null;
  return {
    method: row.method,
    route_path: row.route_path,
    file_path: row.file_path,
    line_start: row.line_start,
    framework: row.framework
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
