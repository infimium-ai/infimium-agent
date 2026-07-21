import { readFile, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import { load } from "cheerio";
import { glob } from "glob";
import { PDFParse } from "pdf-parse";

import {
  createVectorClient,
  type EmbeddedVectorClient,
  type EmbeddedVectorCollection,
  type VectorMetadata
} from "../vector-store.js";
import type { Config } from "../config.js";
import { dataPath } from "../paths.js";
import {
  createProjectFilePolicy,
  filterProjectFiles
} from "./project-files.js";
import { splitText } from "./text-splitter.js";

const COLLECTION_NAME = "infimium_docs";
const OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const DOC_INDEX_SCHEMA_VERSION = 3;
const SQLITE_DB_PATH = dataPath("infimium_docs.db");
const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".pdf", ".html"]);

type DocMetadata = VectorMetadata & {
  filePath: string;
  chunkIndex: number;
  mtime: number;
  projectPath: string;
};

type IndexedDocRow = {
  file_path: string;
  indexed_at: number;
  mtime: number;
  chunk_count: number;
  index_version: number;
};

type StatsRow = {
  filesIndexed: number;
  chunksCreated: number;
};

export type IndexProgress = {
  current: number;
  total: number;
  filePath: string;
};

export type IndexStats = {
  filesIndexed: number;
  chunksCreated: number;
  filesSkipped: number;
  filesPruned: number;
};

export class DocIndexer {
  private readonly vectors: EmbeddedVectorClient;
  private readonly ollamaHost: string;
  private readonly sqlitePath: string;
  private db: DatabaseSync | null = null;

  constructor(
    config: Pick<Config, "ollamaHost">,
    vectorClient: EmbeddedVectorClient = createVectorClient(),
    sqlitePath: string = SQLITE_DB_PATH
  ) {
    this.vectors = vectorClient;
    this.ollamaHost = config.ollamaHost;
    this.sqlitePath = resolve(sqlitePath);
  }

  async indexDirectory(
    dirPath: string,
    onProgress?: (progress: IndexProgress) => void
  ): Promise<IndexStats> {
    const rootPath = resolve(dirPath);
    const collection = await this.getCollection();
    const filePaths = await this.findDocumentFiles(rootPath);
    const stats: IndexStats = {
      filesIndexed: 0,
      chunksCreated: 0,
      filesSkipped: 0,
      filesPruned: 0
    };

    this.initializeDb();
    stats.filesPruned = await this.pruneStaleFiles(collection, rootPath, filePaths);

    for (const [index, filePath] of filePaths.entries()) {
      onProgress?.({
        current: index + 1,
        total: filePaths.length,
        filePath
      });

      let result: { skipped: boolean; chunksCreated: number };
      try {
        result = await this.indexFile(collection, filePath, rootPath);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Warning: skipped ${filePath}: ${message}`);
        stats.filesSkipped += 1;
        continue;
      }
      if (result.skipped) {
        stats.filesSkipped += 1;
        continue;
      }

      stats.filesIndexed += 1;
      stats.chunksCreated += result.chunksCreated;
    }

    return stats;
  }

  getStats(): IndexStats {
    const row = this.getDb()
      .prepare(
        "SELECT COUNT(*) AS filesIndexed, COALESCE(SUM(chunk_count), 0) AS chunksCreated FROM indexed_docs"
      )
      .get();
    const stats = parseStatsRow(row);

    return {
      filesIndexed: stats.filesIndexed,
      chunksCreated: stats.chunksCreated,
      filesSkipped: 0,
      filesPruned: 0
    };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private async getCollection(): Promise<EmbeddedVectorCollection> {
    return this.vectors.getOrCreateCollection({
      name: COLLECTION_NAME,
      embeddingFunction: null
    });
  }

  private async findDocumentFiles(rootPath: string): Promise<string[]> {
    const policy = await createProjectFilePolicy(rootPath);
    const matches = await glob("**/*.{md,txt,pdf,html}", {
      cwd: rootPath,
      absolute: true,
      nodir: true,
      ignore: policy.globIgnorePatterns
    });

    return filterProjectFiles(
      matches.filter((filePath) => SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase())),
      policy
    );
  }

  private async pruneStaleFiles(
    collection: EmbeddedVectorCollection,
    rootPath: string,
    currentFilePaths: string[]
  ): Promise<number> {
    const currentFiles = new Set(currentFilePaths);
    const rows = this.getDb()
      .prepare("SELECT file_path FROM indexed_docs")
      .all() as Array<{ file_path?: unknown }>;
    const staleFiles = rows
      .map((row) => row.file_path)
      .filter((filePath): filePath is string => typeof filePath === "string")
      .filter((filePath) => isWithinRoot(filePath, rootPath))
      .filter((filePath) => !currentFiles.has(filePath));

    for (const filePath of staleFiles) {
      await collection.delete({ where: { filePath } });
      this.getDb().prepare("DELETE FROM indexed_docs WHERE file_path = ?").run(filePath);
    }

    return staleFiles.length;
  }

  private async indexFile(
    collection: EmbeddedVectorCollection,
    filePath: string,
    projectPath: string
  ): Promise<{ skipped: boolean; chunksCreated: number }> {
    const fileStat = await stat(filePath);
    const mtime = Math.trunc(fileStat.mtimeMs);

    if (this.isUnchanged(filePath, mtime)) {
      return { skipped: true, chunksCreated: 0 };
    }

    await collection.delete({ where: { filePath } });

    const text = await this.readDocument(filePath);
    const chunks = splitText(text);
    if (chunks.length > 0) {
      await this.storeChunks(collection, filePath, projectPath, mtime, chunks);
    }

    this.upsertIndexedDoc(filePath, mtime, chunks.length);

    return { skipped: false, chunksCreated: chunks.length };
  }

  private isUnchanged(filePath: string, mtime: number): boolean {
    const row = this.getDb()
      .prepare(
        "SELECT file_path, indexed_at, mtime, chunk_count, index_version FROM indexed_docs WHERE file_path = ?"
      )
      .get(filePath);
    const indexedDoc = parseIndexedDocRow(row);

    return (
      indexedDoc?.mtime === mtime &&
      indexedDoc.index_version === DOC_INDEX_SCHEMA_VERSION
    );
  }

  private upsertIndexedDoc(filePath: string, mtime: number, chunkCount: number): void {
    this.getDb()
      .prepare(
        `INSERT OR REPLACE INTO indexed_docs
          (file_path, indexed_at, mtime, chunk_count, index_version)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(filePath, Date.now(), mtime, chunkCount, DOC_INDEX_SCHEMA_VERSION);
  }

  private async storeChunks(
    collection: EmbeddedVectorCollection,
    filePath: string,
    projectPath: string,
    mtime: number,
    chunks: string[]
  ): Promise<void> {
    const ids: string[] = [];
    const embeddings: number[][] = [];
    const documents: string[] = [];
    const metadatas: DocMetadata[] = [];

    for (const [chunkIndex, chunk] of chunks.entries()) {
      ids.push(`${filePath}::chunk::${chunkIndex}`);
      embeddings.push(await this.embedChunk(chunk));
      documents.push(chunk);
      metadatas.push({ filePath, projectPath, chunkIndex, mtime });
    }

    await collection.upsert({
      ids,
      embeddings,
      documents,
      metadatas
    });
  }

  private async embedChunk(chunkText: string): Promise<number[]> {
    const response = await fetch(`${this.ollamaHost}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_EMBEDDING_MODEL,
        prompt: chunkText
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

  private async readDocument(filePath: string): Promise<string> {
    const extension = extname(filePath).toLowerCase();

    if (extension === ".pdf") {
      return readPdf(filePath);
    }

    const content = await readFile(filePath, "utf8");
    if (extension === ".html") {
      return load(content)("body").text().replace(/\s+/g, " ").trim();
    }

    return content;
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      this.db = new DatabaseSync(this.sqlitePath);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 30000;

        CREATE TABLE IF NOT EXISTS indexed_docs (
          file_path TEXT PRIMARY KEY,
          indexed_at INTEGER,
          mtime INTEGER,
          chunk_count INTEGER,
          index_version INTEGER NOT NULL DEFAULT 1
        )
      `);
      const columns = this.db.prepare("PRAGMA table_info(indexed_docs)").all() as Array<{
        name?: unknown;
      }>;
      if (!columns.some((column) => column.name === "index_version")) {
        this.db.exec(
          "ALTER TABLE indexed_docs ADD COLUMN index_version INTEGER NOT NULL DEFAULT 1"
        );
      }
    }

    return this.db;
  }

  private initializeDb(): void {
    this.getDb();
  }
}

async function readPdf(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

function parseIndexedDocRow(row: unknown): IndexedDocRow | null {
  if (!isRecord(row)) {
    return null;
  }

  const filePath = row.file_path;
  const indexedAt = row.indexed_at;
  const mtime = row.mtime;
  const chunkCount = row.chunk_count;
  const indexVersion = row.index_version;
  if (
    typeof filePath !== "string" ||
    typeof indexedAt !== "number" ||
    typeof mtime !== "number" ||
    typeof chunkCount !== "number" ||
    typeof indexVersion !== "number"
  ) {
    return null;
  }

  return {
    file_path: filePath,
    indexed_at: indexedAt,
    mtime,
    chunk_count: chunkCount,
    index_version: indexVersion
  };
}

function parseStatsRow(row: unknown): StatsRow {
  if (!isRecord(row)) {
    return { filesIndexed: 0, chunksCreated: 0 };
  }

  const filesIndexed = row.filesIndexed;
  const chunksCreated = row.chunksCreated;

  return {
    filesIndexed: typeof filesIndexed === "number" ? filesIndexed : 0,
    chunksCreated: typeof chunksCreated === "number" ? chunksCreated : 0
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWithinRoot(filePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function displayPath(rootPath: string, filePath: string): string {
  const rel = relative(rootPath, filePath);
  return rel && !rel.startsWith("..") ? rel : basename(filePath);
}
