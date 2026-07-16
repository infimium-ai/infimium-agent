import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";

import { ChromaClient } from "chromadb";
import { glob } from "glob";
import Parser, { type Language, type SyntaxNode } from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import TypeScriptGrammars from "tree-sitter-typescript";

const CODE_COLLECTION_NAME = "infimium_code";
export const DEP_GRAPH_DB_PATH = "infimium.db";
const require = createRequire(import.meta.url);
const { tsx, typescript } = TypeScriptGrammars;
const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs"]);
const TS_EXTENSIONS = new Set([".ts", ".tsx"]);
const PY_EXTENSIONS = new Set([".py"]);
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "__init__.py"];

type CodeLanguage = "javascript" | "typescript" | "python";

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
    private readonly chromaClient: ChromaClientLike = new ChromaClient(),
    private readonly sqlitePath: string = DEP_GRAPH_DB_PATH
  ) {}

  async buildGraph(dirPath: string): Promise<void> {
    const rootPath = resolve(dirPath);
    const files = await findCodeFiles(rootPath);

    this.initializeDb();
    this.clearGraphTables();

    for (const sourceFile of files) {
      const imports = extractImports(sourceFile)
        .map((importPath) => resolveImport(sourceFile, importPath))
        .filter((importedFile): importedFile is string => importedFile !== null);

      for (const importedFile of new Set(imports)) {
        this.insertFileImport(sourceFile, importedFile);
      }
    }

    await this.populateSymbolLocations();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private clearGraphTables(): void {
    const db = this.getDb();
    db.exec("DELETE FROM file_imports");
    db.exec("DELETE FROM symbol_locations");
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

  private async populateSymbolLocations(): Promise<void> {
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
        typeof lineStart === "number"
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
  const matches = await glob("**/*.{ts,tsx,js,jsx,py}", {
    cwd: rootPath,
    absolute: true,
    nodir: true,
    ignore: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/*.test.ts",
      "**/*.spec.ts"
    ]
  });

  return matches.sort((a, b) => a.localeCompare(b));
}

function extractImports(filePath: string): string[] {
  const language = detectLanguage(filePath);
  if (!language) {
    return [];
  }

  try {
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

  return null;
}

function loadLanguage(filePath: string, language: CodeLanguage): Language {
  if (language === "javascript") {
    return JavaScript;
  }

  if (language === "python") {
    return Python;
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

function resolveImport(sourceFile: string, importPath: string): string | null {
  if (!importPath.startsWith(".")) {
    return null;
  }

  const basePath = resolve(dirname(sourceFile), importPath);
  const candidates = [
    basePath,
    ...RESOLVE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...INDEX_FILES.map((fileName) => resolve(basePath, fileName))
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}
