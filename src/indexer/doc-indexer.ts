import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";

import { ChromaClient, type Collection, type Metadata } from "chromadb";
import { glob } from "glob";
import { load } from "cheerio";
import { PDFParse } from "pdf-parse";

const COLLECTION_NAME = "infimium_docs";
const OLLAMA_EMBEDDING_URL = "http://localhost:11434/api/embeddings";
const OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const CHUNK_SIZE_CHARS = 512 * 4;
const CHUNK_OVERLAP_CHARS = 50 * 4;
const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".pdf", ".html"]);

type DocMetadata = Metadata & {
  filePath: string;
  chunkIndex: number;
  modifiedAt: number;
};

export type IndexProgress = {
  current: number;
  total: number;
  filePath: string;
};

export type IndexStats = {
  indexedFiles: number;
  skippedFiles: number;
  chunks: number;
  dbSizeBytes: number;
};

export class DocIndexer {
  private readonly docsPath: string;
  private readonly chroma: ChromaClient;

  constructor(localDocsPath: string, chromaClient: ChromaClient = new ChromaClient()) {
    this.docsPath = resolve(localDocsPath);
    this.chroma = chromaClient;
  }

  async index(onProgress?: (progress: IndexProgress) => void): Promise<IndexStats> {
    const collection = await this.getCollection();
    const filePaths = await this.findDocumentFiles();
    const stats: IndexStats = {
      indexedFiles: 0,
      skippedFiles: 0,
      chunks: 0,
      dbSizeBytes: 0
    };

    for (const [index, filePath] of filePaths.entries()) {
      onProgress?.({
        current: index + 1,
        total: filePaths.length,
        filePath
      });

      const result = await this.indexFile(collection, filePath);
      if (result.skipped) {
        stats.skippedFiles += 1;
        continue;
      }

      stats.indexedFiles += 1;
      stats.chunks += result.chunks;
      stats.dbSizeBytes += result.dbSizeBytes;
    }

    return stats;
  }

  private async getCollection(): Promise<Collection> {
    return this.chroma.getOrCreateCollection({
      name: COLLECTION_NAME,
      embeddingFunction: null
    });
  }

  private async findDocumentFiles(): Promise<string[]> {
    const matches = await glob("**/*.{md,txt,pdf,html}", {
      cwd: this.docsPath,
      absolute: true,
      nodir: true,
      ignore: ["**/node_modules/**", "**/.git/**"]
    });

    return matches
      .filter((filePath) => SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  }

  private async indexFile(
    collection: Collection,
    filePath: string
  ): Promise<{ skipped: boolean; chunks: number; dbSizeBytes: number }> {
    const fileStat = await stat(filePath);
    const modifiedAt = fileStat.mtimeMs;

    if (await this.isUnchanged(collection, filePath, modifiedAt)) {
      return { skipped: true, chunks: 0, dbSizeBytes: 0 };
    }

    await collection.delete({ where: { filePath } });

    const text = await this.readDocument(filePath);
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      return { skipped: false, chunks: 0, dbSizeBytes: 0 };
    }

    const ids: string[] = [];
    const embeddings: number[][] = [];
    const documents: string[] = [];
    const metadatas: DocMetadata[] = [];

    for (const [chunkIndex, chunk] of chunks.entries()) {
      ids.push(createChunkId(filePath, modifiedAt, chunkIndex));
      embeddings.push(await embedChunk(chunk));
      documents.push(chunk);
      metadatas.push({ filePath, chunkIndex, modifiedAt });
    }

    await collection.upsert({
      ids,
      embeddings,
      documents,
      metadatas
    });

    return {
      skipped: false,
      chunks: chunks.length,
      dbSizeBytes: estimateStoredBytes({ documents, embeddings, metadatas })
    };
  }

  private async isUnchanged(
    collection: Collection,
    filePath: string,
    modifiedAt: number
  ): Promise<boolean> {
    const existing = await collection.get<DocMetadata>({
      where: { filePath },
      include: ["metadatas"],
      limit: 1
    });
    const metadata = existing.metadatas?.[0];

    return metadata?.modifiedAt === modifiedAt;
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

async function embedChunk(chunkText: string): Promise<number[]> {
  const response = await fetch(OLLAMA_EMBEDDING_URL, {
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

function createChunkId(filePath: string, modifiedAt: number, chunkIndex: number): string {
  return createHash("sha256")
    .update(`${filePath}:${modifiedAt}:${chunkIndex}`)
    .digest("hex");
}

function estimateStoredBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function formatDbSize(bytes: number): string {
  if (bytes < 1_000_000) {
    return `${(bytes / 1_000).toFixed(1)}KB`;
  }

  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}

export function displayPath(rootPath: string, filePath: string): string {
  const rel = relative(rootPath, filePath);
  return rel && !rel.startsWith("..") ? rel : basename(filePath);
}
