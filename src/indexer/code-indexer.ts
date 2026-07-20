import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";

import { ChromaClient, type Metadata } from "chromadb";
import { glob } from "glob";

import { createChromaClient } from "../chroma.js";
import type { Config } from "../config.js";
import { dataPath } from "../paths.js";
import { CodeParser, type CodeSymbol } from "./code-parser.js";
import { DepGraphBuilder, DEP_GRAPH_DB_PATH } from "./dep-graph.js";
import {
  createProjectFilePolicy,
  filterProjectFiles
} from "./project-files.js";

const COLLECTION_NAME = "infimium_code";
const OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const CODE_INDEX_SCHEMA_VERSION = "2";
const SQLITE_DB_PATH = dataPath("infimium_code.db");
const require = createRequire(import.meta.url);

export type CodeIndexStats = {
  filesProcessed: number;
  symbolsIndexed: number;
  filesSkipped: number;
  filesPruned: number;
};

type CodeMetadata = Metadata & {
  name: string;
  type: CodeSymbol["type"];
  filePath: string;
  lineStart: number;
  lineEnd: number;
  language: CodeSymbol["language"];
  signature: string;
  projectPath: string;
};

type IndexedCodeFileRow = {
  file_path: string;
  content_hash: string;
  indexed_at: number;
  symbol_count: number;
};

type CollectionLike = {
  delete(args: { where: { filePath: string } }): Promise<unknown>;
  get(args: { include: Array<"metadatas"> }): Promise<{
    metadatas?: Array<CodeMetadata | null>;
  }>;
  upsert(args: {
    ids: string[];
    embeddings: number[][];
    documents: string[];
    metadatas: CodeMetadata[];
  }): Promise<unknown>;
};

type ChromaClientLike = {
  getOrCreateCollection(args: {
    name: string;
    embeddingFunction: null;
  }): Promise<CollectionLike>;
};

export class CodeIndexer {
  private readonly chroma: ChromaClientLike;
  private readonly ollamaHost: string;
  private readonly parser: CodeParser;
  private readonly sqlitePath: string;
  private db: import("node:sqlite").DatabaseSync | null = null;

  constructor(
    config: Pick<Config, "ollamaHost">,
    chromaClient: ChromaClientLike = createChromaClient(),
    parser: CodeParser = new CodeParser(),
    sqlitePath: string = SQLITE_DB_PATH,
    private readonly depGraphSqlitePath: string = DEP_GRAPH_DB_PATH
  ) {
    this.chroma = chromaClient;
    this.ollamaHost = config.ollamaHost;
    this.parser = parser;
    this.sqlitePath = resolve(sqlitePath);
  }

  async indexCodebase(dirPath: string): Promise<CodeIndexStats> {
    const rootPath = resolve(dirPath);
    const collection = await this.getCollection();
    const filePaths = await this.findCodeFiles(rootPath);
    const stats: CodeIndexStats = {
      filesProcessed: 0,
      symbolsIndexed: 0,
      filesSkipped: 0,
      filesPruned: 0
    };

    this.initializeDb();
    stats.filesPruned = await this.pruneStaleFiles(collection, rootPath, filePaths);

    for (const filePath of filePaths) {
      const result = await this.indexFile(collection, filePath, rootPath);
      if (result.skipped) {
        stats.filesSkipped += 1;
        continue;
      }

      stats.filesProcessed += 1;
      stats.symbolsIndexed += result.symbolsIndexed;
    }

    const depGraphBuilder = new DepGraphBuilder(this.chroma, this.depGraphSqlitePath);
    try {
      await depGraphBuilder.buildGraph(rootPath);
    } finally {
      depGraphBuilder.close();
    }

    return stats;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private async getCollection(): Promise<CollectionLike> {
    return this.chroma.getOrCreateCollection({
      name: COLLECTION_NAME,
      embeddingFunction: null
    });
  }

  private async findCodeFiles(rootPath: string): Promise<string[]> {
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

  private async pruneStaleFiles(
    collection: CollectionLike,
    rootPath: string,
    currentFilePaths: string[]
  ): Promise<number> {
    const currentFiles = new Set(currentFilePaths);
    const rows = this.getDb()
      .prepare("SELECT file_path FROM indexed_code_files")
      .all() as Array<{ file_path?: unknown }>;
    const staleFiles = rows
      .map((row) => row.file_path)
      .filter((filePath): filePath is string => typeof filePath === "string")
      .filter((filePath) => isWithinRoot(filePath, rootPath))
      .filter((filePath) => !currentFiles.has(filePath));

    for (const filePath of staleFiles) {
      await collection.delete({ where: { filePath } });
      this.getDb()
        .prepare("DELETE FROM indexed_code_files WHERE file_path = ?")
        .run(filePath);
    }

    return staleFiles.length;
  }

  private async indexFile(
    collection: CollectionLike,
    filePath: string,
    projectPath: string
  ): Promise<{ skipped: boolean; symbolsIndexed: number }> {
    const content = await readFile(filePath, "utf8");
    const contentHash = hashContent(content);

    if (this.isUnchanged(filePath, contentHash)) {
      return { skipped: true, symbolsIndexed: 0 };
    }

    const symbols = this.parser.parseFile(filePath);
    await collection.delete({ where: { filePath } });

    if (symbols.length > 0) {
      await this.storeSymbols(collection, symbols, projectPath);
    }

    this.upsertIndexedCodeFile(filePath, contentHash, symbols.length);

    return { skipped: false, symbolsIndexed: symbols.length };
  }

  private async storeSymbols(
    collection: CollectionLike,
    symbols: CodeSymbol[],
    projectPath: string
  ): Promise<void> {
    const ids: string[] = [];
    const embeddings: number[][] = [];
    const documents: string[] = [];
    const metadatas: CodeMetadata[] = [];

    for (const symbol of symbols) {
      ids.push(`${symbol.filePath}::${symbol.name}::${symbol.lineStart}`);
      embeddings.push(await this.embedSymbol(symbol.bodyText));
      documents.push(symbol.bodyText);
      metadatas.push({
        name: symbol.name,
        type: symbol.type,
        filePath: symbol.filePath,
        lineStart: symbol.lineStart,
        lineEnd: symbol.lineEnd,
        language: symbol.language,
        signature: symbol.signatureText,
        projectPath
      });
    }

    await collection.upsert({
      ids,
      embeddings,
      documents,
      metadatas
    });
  }

  private async embedSymbol(bodyText: string): Promise<number[]> {
    const promptText = bodyText.length > 4000 ? bodyText.slice(0, 4000) : bodyText;
    const response = await fetch(`${this.ollamaHost}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_EMBEDDING_MODEL,
        prompt: promptText
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama embedding failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as { embedding?: unknown };
    if (!Array.isArray(body.embedding) || !body.embedding.every((value) => typeof value === "number")) {
      throw new Error("Ollama embedding response did not contain a numeric embedding");
    }

    return body.embedding;
  }

  private isUnchanged(filePath: string, contentHash: string): boolean {
    const row = this.getDb()
      .prepare(
        "SELECT file_path, content_hash, indexed_at, symbol_count FROM indexed_code_files WHERE file_path = ?"
      )
      .get(filePath);
    const indexedFile = parseIndexedCodeFileRow(row);

    return indexedFile?.content_hash === contentHash;
  }

  private upsertIndexedCodeFile(
    filePath: string,
    contentHash: string,
    symbolCount: number
  ): void {
    this.getDb()
      .prepare(
        `INSERT OR REPLACE INTO indexed_code_files
          (file_path, content_hash, indexed_at, symbol_count)
         VALUES (?, ?, ?, ?)`
      )
      .run(filePath, contentHash, Date.now(), symbolCount);
  }

  private getDb(): import("node:sqlite").DatabaseSync {
    if (!this.db) {
      const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
      this.db = new DatabaseSync(this.sqlitePath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS indexed_code_files (
          file_path TEXT PRIMARY KEY,
          content_hash TEXT,
          indexed_at INTEGER,
          symbol_count INTEGER
        )
      `);
    }

    return this.db;
  }

  private initializeDb(): void {
    this.getDb();
  }
}

function hashContent(content: string): string {
  return createHash("sha256")
    .update(`${CODE_INDEX_SCHEMA_VERSION}\0${content}`)
    .digest("hex");
}

function parseIndexedCodeFileRow(row: unknown): IndexedCodeFileRow | null {
  if (!isRecord(row)) {
    return null;
  }

  const filePath = row.file_path;
  const contentHash = row.content_hash;
  const indexedAt = row.indexed_at;
  const symbolCount = row.symbol_count;
  if (
    typeof filePath !== "string" ||
    typeof contentHash !== "string" ||
    typeof indexedAt !== "number" ||
    typeof symbolCount !== "number"
  ) {
    return null;
  }

  return {
    file_path: filePath,
    content_hash: contentHash,
    indexed_at: indexedAt,
    symbol_count: symbolCount
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWithinRoot(filePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
