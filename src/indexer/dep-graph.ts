import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

import { glob } from "glob";
import Parser, { type Language, type SyntaxNode } from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import TypeScriptGrammars from "tree-sitter-typescript";
import DartParser, { type SyntaxNode as DartSyntaxNode } from "@sengac/tree-sitter";
import Dart from "@sengac/tree-sitter-dart";

import { dataPath } from "../paths.js";
import { createVectorClient } from "../vector-store.js";
import { CodeParser, type CodeSymbol } from "./code-parser.js";
import {
  createProjectFilePolicy,
  filterProjectFiles
} from "./project-files.js";
import { loadWorkspaceForProject } from "../workspace/workspace.js";

const CODE_COLLECTION_NAME = "infimium_code";
export const DEP_GRAPH_DB_PATH = dataPath("infimium.db");
const require = createRequire(import.meta.url);
const { tsx, typescript } = TypeScriptGrammars;
const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs"]);
const TS_EXTENSIONS = new Set([".ts", ".tsx"]);
const PY_EXTENSIONS = new Set([".py"]);
const DART_EXTENSIONS = new Set([".dart"]);
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".dart", ".go", ".rs", ".java"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "__init__.py", "index.dart", "main.go", "lib.rs"];
const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "typeof", "sizeof",
  "new", "super", "this", "class", "def", "fn", "match", "assert"
]);

type CodeLanguage = "javascript" | "typescript" | "python" | "dart";

type CodeMetadata = {
  name?: unknown;
  filePath?: unknown;
  lineStart?: unknown;
};

type CollectionGetResult = {
  metadatas?: Array<Record<string, unknown> | null>;
};

type CollectionLike = {
  get(args: { include: Array<"metadatas"> }): Promise<CollectionGetResult>;
};

type VectorClientLike = {
  getOrCreateCollection(args: {
    name: string;
    embeddingFunction: null;
  }): Promise<CollectionLike>;
};

type SymbolCallRecord = {
  caller: string;
  callee: string;
  lineStart: number;
};

type HttpRouteRecord = {
  method: string;
  path: string;
  handlerSymbol: string;
  filePath: string;
  lineStart: number;
  framework: string;
};

export class DepGraphBuilder {
  private db: import("node:sqlite").DatabaseSync | null = null;

  constructor(
    private readonly vectorClient: VectorClientLike = createVectorClient(),
    private readonly sqlitePath: string = DEP_GRAPH_DB_PATH,
    private readonly codeParser: CodeParser = new CodeParser()
  ) {}

  async buildGraph(dirPath: string): Promise<void> {
    const rootPath = resolve(dirPath);
    const files = await findCodeFiles(rootPath);
    const dartPackageRoots = readDartPackageRoots(rootPath);

    this.initializeDb();
    this.clearGraphForRoot(rootPath);

    for (const sourceFile of files) {
      const symbols = await this.codeParser.parseFileAsync(sourceFile);
      for (const symbol of symbols) {
        this.insertSymbolLocation(symbol.name, symbol.filePath, symbol.lineStart);
      }

      const source = readFileSync(sourceFile, "utf8");
      for (const edge of extractSymbolCalls(symbols)) {
        this.insertSymbolCall(edge.caller, sourceFile, edge.callee, edge.lineStart);
      }
      for (const route of extractHttpRoutes(source, sourceFile, symbols)) {
        this.insertHttpRoute(route);
      }

      const imports = extractImports(sourceFile)
        .map((importPath) => resolveImport(sourceFile, importPath, dartPackageRoots))
        .filter((importedFile): importedFile is string => importedFile !== null);

      for (const importedFile of new Set(imports)) {
        this.insertFileImport(sourceFile, importedFile);
      }
    }

    await this.populateSymbolLocations(rootPath);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private clearGraphForRoot(rootPath: string): void {
    const db = this.getDb();
    const imports = db
      .prepare("SELECT source_file, imported_file FROM file_imports")
      .all() as Array<{ source_file?: unknown; imported_file?: unknown }>;
    const deleteImport = db.prepare(
      "DELETE FROM file_imports WHERE source_file = ? AND imported_file = ?"
    );
    for (const row of imports) {
      if (
        typeof row.source_file === "string" &&
        typeof row.imported_file === "string" &&
        isWithinRoot(row.source_file, rootPath)
      ) {
        deleteImport.run(row.source_file, row.imported_file);
      }
    }

    const symbols = db
      .prepare("SELECT symbol_name, file_path FROM symbol_locations")
      .all() as Array<{ symbol_name?: unknown; file_path?: unknown }>;
    const deleteSymbol = db.prepare(
      "DELETE FROM symbol_locations WHERE symbol_name = ? AND file_path = ?"
    );
    for (const row of symbols) {
      if (
        typeof row.symbol_name === "string" &&
        typeof row.file_path === "string" &&
        isWithinRoot(row.file_path, rootPath)
      ) {
        deleteSymbol.run(row.symbol_name, row.file_path);
      }
    }

    this.deleteRowsForRoot("symbol_calls", "caller_file", rootPath);
    this.deleteRowsForRoot("http_routes", "file_path", rootPath);
  }

  private deleteRowsForRoot(tableName: "symbol_calls" | "http_routes", column: string, rootPath: string): void {
    this.getDb()
      .prepare(`DELETE FROM ${tableName} WHERE ${column} = ? OR ${column} LIKE ?`)
      .run(rootPath, `${rootPath}/%`);
  }

  private insertFileImport(sourceFile: string, importedFile: string): void {
    this.getDb()
      .prepare(
        `INSERT OR IGNORE INTO file_imports
          (source_file, imported_file)
         VALUES (?, ?)`
      )
      .run(sourceFile, importedFile);
  }

  private insertSymbolLocation(
    symbolName: string,
    filePath: string,
    lineStart: number
  ): void {
    this.getDb()
      .prepare(
        `INSERT OR REPLACE INTO symbol_locations
          (symbol_name, file_path, line_start)
         VALUES (?, ?, ?)`
      )
      .run(symbolName, filePath, lineStart);
  }

  private insertSymbolCall(
    callerSymbol: string,
    callerFile: string,
    calleeSymbol: string,
    lineStart: number
  ): void {
    this.getDb()
      .prepare(
        `INSERT OR IGNORE INTO symbol_calls
          (caller_symbol, caller_file, callee_symbol, line_start)
         VALUES (?, ?, ?, ?)`
      )
      .run(callerSymbol, callerFile, calleeSymbol, lineStart);
  }

  private insertHttpRoute(route: HttpRouteRecord): void {
    this.getDb()
      .prepare(
        `INSERT OR REPLACE INTO http_routes
          (method, route_path, handler_symbol, file_path, line_start, framework)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        route.method,
        route.path,
        route.handlerSymbol,
        route.filePath,
        route.lineStart,
        route.framework
      );
  }

  private async populateSymbolLocations(rootPath: string): Promise<void> {
    const collection = await this.vectorClient.getOrCreateCollection({
      name: CODE_COLLECTION_NAME,
      embeddingFunction: null
    });
    const result = await collection.get({ include: ["metadatas"] });

    for (const metadata of result.metadatas ?? []) {
      if (!metadata) {
        continue;
      }

      const { name, filePath, lineStart } = metadata;
      if (
        typeof name === "string" &&
        typeof filePath === "string" &&
        typeof lineStart === "number" &&
        isWithinRoot(filePath, rootPath)
      ) {
        this.insertSymbolLocation(name, filePath, lineStart);
      }
    }
  }

  private getDb(): import("node:sqlite").DatabaseSync {
    if (!this.db) {
      const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
      this.db = new DatabaseSync(this.sqlitePath);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 30000;

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

        CREATE INDEX IF NOT EXISTS symbol_calls_callee_idx
          ON symbol_calls(callee_symbol);

        CREATE TABLE IF NOT EXISTS http_routes (
          method TEXT NOT NULL,
          route_path TEXT NOT NULL,
          handler_symbol TEXT NOT NULL,
          file_path TEXT NOT NULL,
          line_start INTEGER NOT NULL,
          framework TEXT NOT NULL,
          PRIMARY KEY (method, route_path, file_path, line_start)
        );

        CREATE INDEX IF NOT EXISTS http_routes_handler_idx
          ON http_routes(handler_symbol);
      `);
    }

    return this.db;
  }

  private initializeDb(): void {
    this.getDb();
  }
}

function extractSymbolCalls(symbols: CodeSymbol[]): SymbolCallRecord[] {
  const edges: SymbolCallRecord[] = [];
  const callPattern = /\b([A-Za-z_$][\w$]*)\s*\(/g;

  for (const symbol of symbols) {
    if (symbol.type === "class") {
      continue;
    }
    const bodyStart = findImplementationStart(symbol.bodyText, symbol.language);
    const implementation = symbol.bodyText.slice(bodyStart);
    for (const match of implementation.matchAll(callPattern)) {
      const callee = match[1];
      if (!callee || CALL_KEYWORDS.has(callee)) {
        continue;
      }
      const absoluteOffset = bodyStart + (match.index ?? 0);
      edges.push({
        caller: symbol.name,
        callee,
        lineStart: symbol.lineStart + countNewlines(symbol.bodyText.slice(0, absoluteOffset))
      });
    }
  }

  return uniqueCalls(edges);
}

function findImplementationStart(bodyText: string, language: CodeSymbol["language"]): number {
  if (language === "python") {
    const newline = bodyText.indexOf("\n");
    return newline === -1 ? bodyText.length : newline + 1;
  }
  const arrow = bodyText.indexOf("=>");
  const brace = bodyText.indexOf("{");
  const candidates = [arrow === -1 ? null : arrow + 2, brace === -1 ? null : brace + 1]
    .filter((value): value is number => value !== null);
  return candidates.length > 0 ? Math.min(...candidates) : 0;
}

function uniqueCalls(edges: SymbolCallRecord[]): SymbolCallRecord[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.caller}:${edge.callee}:${edge.lineStart}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractHttpRoutes(
  source: string,
  filePath: string,
  symbols: CodeSymbol[]
): HttpRouteRecord[] {
  const routes: HttpRouteRecord[] = [];
  collectCallStyleRoutes(source, filePath, symbols, routes);
  collectDecoratorRoutes(source, filePath, symbols, routes);
  collectJavaRoutes(source, filePath, symbols, routes);
  collectGoRoutes(source, filePath, symbols, routes);
  collectRustRoutes(source, filePath, symbols, routes);
  return routes;
}

function collectCallStyleRoutes(
  source: string,
  filePath: string,
  symbols: CodeSymbol[],
  routes: HttpRouteRecord[]
): void {
  const pattern = /\b(app|router|server|fastify)\.(get|post|put|patch|delete|options|head)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*(?:async\s*)?([A-Za-z_$][\w$]*)?/gi;
  for (const match of source.matchAll(pattern)) {
    const lineStart = lineAtOffset(source, match.index ?? 0);
    routes.push({
      method: (match[2] ?? "ANY").toUpperCase(),
      path: match[3] ?? "/",
      handlerSymbol: match[4] ?? symbolAtLine(symbols, lineStart)?.name ?? "anonymous",
      filePath,
      lineStart,
      framework: match[1]?.toLowerCase() ?? "router"
    });
  }
}

function collectDecoratorRoutes(
  source: string,
  filePath: string,
  symbols: CodeSymbol[],
  routes: HttpRouteRecord[]
): void {
  const pattern = /@(app|router|blueprint)\.(get|post|put|patch|delete|options|head)\s*\(\s*["']([^"']+)["']/gi;
  for (const match of source.matchAll(pattern)) {
    const lineStart = lineAtOffset(source, match.index ?? 0);
    routes.push({
      method: (match[2] ?? "ANY").toUpperCase(),
      path: match[3] ?? "/",
      handlerSymbol: nextSymbol(symbols, lineStart)?.name ?? "anonymous",
      filePath,
      lineStart,
      framework: match[1]?.toLowerCase() ?? "python-router"
    });
  }
}

function collectJavaRoutes(
  source: string,
  filePath: string,
  symbols: CodeSymbol[],
  routes: HttpRouteRecord[]
): void {
  const pattern = /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const lineStart = lineAtOffset(source, match.index ?? 0);
    routes.push({
      method: match[1] === "Request" ? "ANY" : (match[1] ?? "ANY").toUpperCase(),
      path: match[2] ?? "/",
      handlerSymbol: nextSymbol(symbols, lineStart)?.name ?? "anonymous",
      filePath,
      lineStart,
      framework: "spring"
    });
  }
}

function collectGoRoutes(
  source: string,
  filePath: string,
  symbols: CodeSymbol[],
  routes: HttpRouteRecord[]
): void {
  const pattern = /\b(?:http\.)?HandleFunc\s*\(\s*["']([^"']+)["']\s*,\s*([A-Za-z_][\w]*)/g;
  for (const match of source.matchAll(pattern)) {
    const lineStart = lineAtOffset(source, match.index ?? 0);
    routes.push({
      method: "ANY",
      path: match[1] ?? "/",
      handlerSymbol: match[2] ?? "anonymous",
      filePath,
      lineStart,
      framework: "net/http"
    });
  }
}

function collectRustRoutes(
  source: string,
  filePath: string,
  symbols: CodeSymbol[],
  routes: HttpRouteRecord[]
): void {
  const pattern = /#\[(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']\s*\)\]/gi;
  for (const match of source.matchAll(pattern)) {
    const lineStart = lineAtOffset(source, match.index ?? 0);
    routes.push({
      method: (match[1] ?? "ANY").toUpperCase(),
      path: match[2] ?? "/",
      handlerSymbol: nextSymbol(symbols, lineStart)?.name ?? "anonymous",
      filePath,
      lineStart,
      framework: "rust-web"
    });
  }
}

function symbolAtLine(symbols: CodeSymbol[], line: number): CodeSymbol | null {
  return symbols
    .filter((symbol) => symbol.lineStart <= line && symbol.lineEnd >= line)
    .sort((left, right) => (left.lineEnd - left.lineStart) - (right.lineEnd - right.lineStart))[0] ?? null;
}

function nextSymbol(symbols: CodeSymbol[], line: number): CodeSymbol | null {
  return symbols
    .filter((symbol) => symbol.lineStart >= line)
    .sort((left, right) => left.lineStart - right.lineStart)[0] ?? null;
}

function lineAtOffset(source: string, offset: number): number {
  return 1 + countNewlines(source.slice(0, offset));
}

function countNewlines(value: string): number {
  return (value.match(/\n/g) ?? []).length;
}

async function findCodeFiles(rootPath: string): Promise<string[]> {
  const policy = await createProjectFilePolicy(rootPath);
  const matches = await glob("**/*.{ts,tsx,js,jsx,py,dart,go,rs,java}", {
    cwd: policy.rootPath,
    absolute: true,
    nodir: true,
    follow: true,
    ignore: [
      ...policy.globIgnorePatterns,
      "**/*.test.ts",
      "**/*.spec.ts"
    ]
  });

  return filterProjectFiles(matches, policy);
}

function extractImports(filePath: string): string[] {
  const language = detectLanguage(filePath);
  if (!language) {
    return [];
  }

  try {
    if (language === "dart") {
      return extractDartImports(filePath);
    }

    const source = readFileSync(filePath, "utf8");
    const parser = new Parser();
    parser.setLanguage(loadLanguage(filePath, language));
    const tree = parser.parse(source);

    if (tree.rootNode.hasError) {
      return [];
    }

    return collectImports(tree.rootNode, language);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: failed to parse imports from ${filePath}: ${message}`);
    return [];
  }
}

function detectLanguage(filePath: string): CodeLanguage | null {
  const extension = extname(filePath).toLowerCase();

  if (JS_EXTENSIONS.has(extension)) {
    return "javascript";
  }

  if (TS_EXTENSIONS.has(extension)) {
    return "typescript";
  }

  if (PY_EXTENSIONS.has(extension)) {
    return "python";
  }

  if (DART_EXTENSIONS.has(extension)) {
    return "dart";
  }

  return null;
}

function loadLanguage(filePath: string, language: CodeLanguage): Language {
  if (language === "javascript") {
    return JavaScript;
  }

  if (language === "python") {
    return Python;
  }

  if (language === "dart") {
    throw new Error("Dart uses the dedicated modern Tree-sitter runtime");
  }

  return extname(filePath).toLowerCase() === ".tsx" ? tsx : typescript;
}

function collectImports(rootNode: SyntaxNode, language: CodeLanguage): string[] {
  const imports: string[] = [];

  function visit(node: SyntaxNode): void {
    if (language === "python") {
      const importPath = pythonImportFromNode(node);
      if (importPath) {
        imports.push(importPath);
      }
    } else {
      const importPath = jsTsImportFromNode(node);
      if (importPath) {
        imports.push(importPath);
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(rootNode);

  return imports;
}

function extractDartImports(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const parser = new DartParser();
  parser.setLanguage(Dart);
  const tree = parser.parse(source);
  if (tree.rootNode.hasError) {
    return [];
  }

  const imports: string[] = [];
  function visit(node: DartSyntaxNode): void {
    if (node.type === "library_import" || node.type === "library_export") {
      const uri = findDartStringLiteral(node);
      if (uri) {
        imports.push(unquote(uri));
      }
      return;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(tree.rootNode);
  return imports;
}

function findDartStringLiteral(node: DartSyntaxNode): string | null {
  if (node.type === "string_literal") {
    return node.text;
  }
  for (const child of node.namedChildren) {
    const found = findDartStringLiteral(child);
    if (found) {
      return found;
    }
  }
  return null;
}

function jsTsImportFromNode(node: SyntaxNode): string | null {
  if (node.type === "import_declaration" || node.type === "import_statement") {
    const sourceNode = node.childForFieldName("source");
    if (sourceNode?.type === "string") {
      return unquote(sourceNode.text);
    }

    return node.namedChildren.find((child) => child.type === "string")
      ? unquote(node.namedChildren.find((child) => child.type === "string")?.text ?? "")
      : null;
  }

  if (node.type === "call_expression" && readName(node.childForFieldName("function")) === "require") {
    const argsNode = node.childForFieldName("arguments");
    const firstArg = argsNode?.namedChildren[0];

    return firstArg?.type === "string" ? unquote(firstArg.text) : null;
  }

  return null;
}

function pythonImportFromNode(node: SyntaxNode): string | null {
  if (node.type === "import_statement") {
    const dottedName = node.namedChildren.find((child) => child.type === "dotted_name");

    return dottedName?.text ?? null;
  }

  if (node.type === "import_from_statement") {
    const moduleNode = node.childForFieldName("module_name") ??
      node.namedChildren.find((child) => child.type === "dotted_name" || child.type === "relative_import");

    return moduleNode?.text ?? null;
  }

  return null;
}

function readName(node: SyntaxNode | null): string | null {
  return node?.text ?? null;
}

function resolveImport(
  sourceFile: string,
  importPath: string,
  dartPackageRoots: Map<string, string>
): string | null {
  if (importPath.startsWith("package:")) {
    const packageImport = importPath.slice("package:".length);
    const separatorIndex = packageImport.indexOf("/");
    if (separatorIndex <= 0) {
      return null;
    }
    const packageName = packageImport.slice(0, separatorIndex);
    const packageRoot = dartPackageRoots.get(packageName);
    if (!packageRoot) {
      return null;
    }
    return resolveExistingImport(
      resolve(packageRoot, "lib", packageImport.slice(separatorIndex + 1))
    );
  }

  if (!importPath.startsWith(".")) {
    return null;
  }

  return resolveExistingImport(resolve(dirname(sourceFile), importPath));
}

function resolveExistingImport(basePath: string): string | null {
  return buildImportCandidates(basePath).find((candidate) => existsSync(candidate)) ?? null;
}

function buildImportCandidates(basePath: string): string[] {
  const extension = extname(basePath).toLowerCase();
  const pathWithoutExtension = extension
    ? basePath.slice(0, -extension.length)
    : basePath;

  return unique([
    basePath,
    ...(extension ? RESOLVE_EXTENSIONS.map((candidate) => `${pathWithoutExtension}${candidate}`) : []),
    ...RESOLVE_EXTENSIONS.map((candidate) => `${basePath}${candidate}`),
    ...INDEX_FILES.map((fileName) => resolve(basePath, fileName)),
    ...(extension ? INDEX_FILES.map((fileName) => resolve(pathWithoutExtension, fileName)) : [])
  ]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function unquote(value: string): string {
  return value.replace(/^r?["']|["']$/g, "");
}

function readDartPackageRoots(rootPath: string): Map<string, string> {
  const workspace = loadWorkspaceForProject(rootPath);
  const projectPaths = workspace?.projects.map((project) => project.path) ?? [rootPath];
  const packageRoots = new Map<string, string>();
  for (const projectPath of projectPaths) {
    const packageName = readDartPackageName(projectPath);
    if (packageName) {
      packageRoots.set(packageName, projectPath);
    }
  }
  return packageRoots;
}

function readDartPackageName(rootPath: string): string | null {
  const pubspecPath = resolve(rootPath, "pubspec.yaml");
  if (!existsSync(pubspecPath)) {
    return null;
  }
  const match = readFileSync(pubspecPath, "utf8").match(/^name:\s*([^\s#]+)/m);
  return match?.[1] ?? null;
}

function isWithinRoot(filePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
