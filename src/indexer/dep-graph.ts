import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

import { ChromaClient } from "chromadb";
import { glob } from "glob";
import Parser, { type Language, type SyntaxNode } from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import TypeScriptGrammars from "tree-sitter-typescript";
import DartParser, { type SyntaxNode as DartSyntaxNode } from "@sengac/tree-sitter";
import Dart from "@sengac/tree-sitter-dart";

import { createChromaClient } from "../chroma.js";
import { dataPath } from "../paths.js";
import { CodeParser } from "./code-parser.js";
import {
  createProjectFilePolicy,
  filterProjectFiles
} from "./project-files.js";

const CODE_COLLECTION_NAME = "infimium_code";
export const DEP_GRAPH_DB_PATH = dataPath("infimium.db");
const require = createRequire(import.meta.url);
const { tsx, typescript } = TypeScriptGrammars;
const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs"]);
const TS_EXTENSIONS = new Set([".ts", ".tsx"]);
const PY_EXTENSIONS = new Set([".py"]);
const DART_EXTENSIONS = new Set([".dart"]);
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".dart"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "__init__.py", "index.dart"];

type CodeLanguage = "javascript" | "typescript" | "python" | "dart";

type CodeMetadata = {
  name?: unknown;
  filePath?: unknown;
  lineStart?: unknown;
};

type CollectionGetResult = {
  metadatas?: Array<CodeMetadata | null>;
};

type CollectionLike = {
  get(args: { include: Array<"metadatas"> }): Promise<CollectionGetResult>;
};

type ChromaClientLike = {
  getOrCreateCollection(args: {
    name: string;
    embeddingFunction: null;
  }): Promise<CollectionLike>;
};

export class DepGraphBuilder {
  private db: import("node:sqlite").DatabaseSync | null = null;

  constructor(
    private readonly chromaClient: ChromaClientLike = createChromaClient(),
    private readonly sqlitePath: string = DEP_GRAPH_DB_PATH,
    private readonly codeParser: CodeParser = new CodeParser()
  ) {}

  async buildGraph(dirPath: string): Promise<void> {
    const rootPath = resolve(dirPath);
    const files = await findCodeFiles(rootPath);
    const dartPackageName = readDartPackageName(rootPath);

    this.initializeDb();
    this.clearGraphForRoot(rootPath);

    for (const sourceFile of files) {
      for (const symbol of this.codeParser.parseFile(sourceFile)) {
        this.insertSymbolLocation(symbol.name, symbol.filePath, symbol.lineStart);
      }

      const imports = extractImports(sourceFile)
        .map((importPath) => resolveImport(sourceFile, importPath, rootPath, dartPackageName))
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
        (isWithinRoot(row.source_file, rootPath) || isWithinRoot(row.imported_file, rootPath))
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

  private async populateSymbolLocations(rootPath: string): Promise<void> {
    const collection = await this.chromaClient.getOrCreateCollection({
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

  private initializeDb(): void {
    this.getDb();
  }
}

async function findCodeFiles(rootPath: string): Promise<string[]> {
  const policy = await createProjectFilePolicy(rootPath);
  const matches = await glob("**/*.{ts,tsx,js,jsx,py,dart}", {
    cwd: rootPath,
    absolute: true,
    nodir: true,
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
  rootPath: string,
  dartPackageName: string | null
): string | null {
  if (importPath.startsWith("package:") && dartPackageName) {
    const packagePrefix = `package:${dartPackageName}/`;
    if (!importPath.startsWith(packagePrefix)) {
      return null;
    }
    return resolveExistingImport(resolve(rootPath, "lib", importPath.slice(packagePrefix.length)));
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
