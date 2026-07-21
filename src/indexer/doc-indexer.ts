import { readFile, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { basename, extname, relative, resolve } from "node:path";

import { load } from "cheerio";
import { ChromaClient, type Collection, type Metadata } from "chromadb";
import { glob } from "glob";
import { PDFParse } from "pdf-parse";

import { createChromaClient } from "../chroma.js";
import type { Config } from "../config.js";
import { dataPath } from "../paths.js";

const COLLECTION_NAME = "infimium_docs";
const OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const CHUNK_SIZE_CHARS = 512 * 4;
const CHUNK_OVERLAP_CHARS = 50 * 4;
const SQLITE_DB_PATH = dataPath("infimium_docs.db");
const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".pdf", ".html"]);

type DocMetadata = Metadata & {
  filePath: string;
  chunkIndex: number;
  mtime: number;
};

type IndexedDocRow = {
  file_path: string;
  indexed_at: number;
  mtime: number;
  chunk_count: number;
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
};

export class DocIndexer {
  private readonly chroma: ChromaClient;
  private readonly ollamaHost: string;
  private readonly sqlitePath: string;
  private db: DatabaseSync | null = null;

  constructor(
    config: Pick<Config, "ollamaHost">,
    chromaClient: ChromaClient = createChromaClient(),
    sqlitePath: string = SQLITE_DB_PATH
  ) {
    this.chroma = chromaClient;
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
      filesSkipped: 0
    };

    this.initializeDb();

    for (const [index, filePath] of filePaths.entries()) {
      onProgress?.({
        current: index + 1,
        total: filePaths.length,
        filePath
      });

      const result = await this.indexFile(collection, filePath);
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
      filesSkipped: 0
    };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private async getCollection(): Promise<Collection> {
    return this.chroma.getOrCreateCollection({
      name: COLLECTION_NAME,
      embeddingFunction: null
    });
  }

  private async findDocumentFiles(rootPath: string): Promise<string[]> {
    const matches = await glob("**/*.{md,txt,pdf,html}", {
      cwd: rootPath,
      absolute: true,
      nodir: true,
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/*.db"
      ]
    });

    return matches
      .filter((filePath) => SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  }

  private async indexFile(
    collection: Collection,
    filePath: string
  ): Promise<{ skipped: boolean; chunksCreated: number }> {
    const fileStat = await stat(filePath);
    const mtime = Math.trunc(fileStat.mtimeMs);

    if (this.isUnchanged(filePath, mtime)) {
      return { skipped: true, chunksCreated: 0 };
    }

    await collection.delete({ where: { filePath } });

    const text = await this.readDocument(filePath);
    const chunks = chunkText(text);
    if (chunks.length > 0) {
      await this.storeChunks(collection, filePath, mtime, chunks);
    }

    this.upsertIndexedDoc(filePath, mtime, chunks.length);

    return { skipped: false, chunksCreated: chunks.length };
  }

  private isUnchanged(filePath: string, mtime: number): boolean {
    const row = this.getDb()
      .prepare("SELECT file_path, indexed_at, mtime, chunk_count FROM indexed_docs WHERE file_path = ?")
      .get(filePath);
    const indexedDoc = parseIndexedDocRow(row);

    return indexedDoc?.mtime === mtime;
  }

  private upsertIndexedDoc(filePath: string, mtime: number, chunkCount: number): void {
    this.getDb()
      .prepare(
        `INSERT OR REPLACE INTO indexed_docs
          (file_path, indexed_at, mtime, chunk_count)
         VALUES (?, ?, ?, ?)`
      )
      .run(filePath, Date.now(), mtime, chunkCount);
  }

  private async storeChunks(
    collection: Collection,
    filePath: string,
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
      metadatas.push({ filePath, chunkIndex, mtime });
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
        CREATE TABLE IF NOT EXISTS indexed_docs (
          file_path TEXT PRIMARY KEY,
          indexed_at INTEGER,
          mtime INTEGER,
          chunk_count INTEGER
        )
      `);
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

function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + CHUNK_SIZE_CHARS, normalized.length);
    chunks.push(normalized.slice(start, end));

    if (end === normalized.length) {
      break;
    }

    start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
  }

  return chunks;
}

function parseIndexedDocRow(row: unknown): IndexedDocRow | null {
  if (!isRecord(row)) {
    return null;
  }

  const filePath = row.file_path;
  const indexedAt = row.indexed_at;
  const mtime = row.mtime;
  const chunkCount = row.chunk_count;
  if (
    typeof filePath !== "string" ||
    typeof indexedAt !== "number" ||
    typeof mtime !== "number" ||
    typeof chunkCount !== "number"
  ) {
    return null;
  }

  return {
    file_path: filePath,
    indexed_at: indexedAt,
    mtime,
    chunk_count: chunkCount
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

export function displayPath(rootPath: string, filePath: string): string {
  const rel = relative(rootPath, filePath);
  return rel && !rel.startsWith("..") ? rel : basename(filePath);
}
