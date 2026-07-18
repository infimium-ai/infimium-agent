import { ChromaClient } from "chromadb";

import { createChromaClient } from "../chroma.js";

const COLLECTION_NAME = "infimium_docs";
export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

export type DocResult = {
  content: string;
  filePath: string;
  score: number;
  chunkIndex: number;
};

type DocsMetadata = {
  filePath?: unknown;
  chunkIndex?: unknown;
};

type QueryResultLike = {
  documents?: Array<Array<string | null>>;
  metadatas?: Array<Array<DocsMetadata | null>>;
  distances?: Array<Array<number | null>>;
};

type CollectionLike = {
  count(): Promise<number>;
  query(args: {
    queryEmbeddings: number[][];
    nResults: number;
    include: Array<"documents" | "metadatas" | "distances">;
  }): Promise<QueryResultLike>;
};

type ChromaClientLike = {
  getOrCreateCollection(args: {
    name: string;
    embeddingFunction: null;
  }): Promise<CollectionLike>;
};

type LocalDocsSearchOptions = {
  localDocsPath: string | null;
  ollamaHost?: string;
  chromaClient?: ChromaClientLike;
};

export class LocalDocsUnavailableError extends Error {
  constructor() {
    super("Local docs unavailable. Is ChromaDB running?");
  }
}

export class LocalDocsNotConfiguredError extends Error {
  constructor() {
    super("Add LOCAL_DOCS_PATH to your .env");
  }
}

export class LocalDocsEmptyError extends Error {
  constructor() {
    super("No docs indexed. Run: infimium index");
  }
}

export class LocalDocsSearch {
  private readonly localDocsPath: string | null;
  private readonly ollamaHost: string;
  private readonly chromaClient: ChromaClientLike;

  constructor(options: LocalDocsSearchOptions) {
    this.localDocsPath = options.localDocsPath;
    this.ollamaHost = options.ollamaHost ?? DEFAULT_OLLAMA_HOST;
    this.chromaClient = options.chromaClient ?? createChromaClient();
  }

  async search(query: string, topK: number): Promise<DocResult[]> {
    if (!this.localDocsPath) {
      throw new LocalDocsNotConfiguredError();
    }

    const collection = await this.getCollection();
    const results = await this.queryCollection(collection, query, topK);

    return deduplicateAdjacentChunks(results).slice(0, topK);
  }

  private async getCollection(): Promise<CollectionLike> {
    try {
      return await this.chromaClient.getOrCreateCollection({
        name: COLLECTION_NAME,
        embeddingFunction: null
      });
    } catch (error: unknown) {
      if (isConnectionError(error)) {
        throw new LocalDocsUnavailableError();
      }

      throw error;
    }
  }

  private async queryCollection(
    collection: CollectionLike,
    query: string,
    topK: number
  ): Promise<DocResult[]> {
    try {
      const count = await collection.count();
      if (count === 0) {
        throw new LocalDocsEmptyError();
      }

      const queryEmbedding = await this.embedQuery(query);
      const rawResults = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: topK * 2,
        include: ["documents", "metadatas", "distances"]
      });

      return parseQueryResults(rawResults);
    } catch (error: unknown) {
      if (error instanceof LocalDocsEmptyError) {
        throw error;
      }

      if (isConnectionError(error)) {
        throw new LocalDocsUnavailableError();
      }

      throw error;
    }
  }

  private async embedQuery(query: string): Promise<number[]> {
    const response = await fetch(`${this.ollamaHost}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_EMBEDDING_MODEL,
        prompt: query
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
}

function parseQueryResults(result: QueryResultLike): DocResult[] {
  const documents = result.documents?.[0] ?? [];
  const metadatas = result.metadatas?.[0] ?? [];
  const distances = result.distances?.[0] ?? [];
  const parsed: DocResult[] = [];

  for (const [index, content] of documents.entries()) {
    const metadata = metadatas[index];
    if (typeof content !== "string" || !metadata) {
      continue;
    }

    const filePath = metadata.filePath;
    const chunkIndex = metadata.chunkIndex;
    if (typeof filePath !== "string" || typeof chunkIndex !== "number") {
      continue;
    }

    const distance = distances[index] ?? 1;
    parsed.push({
      content,
      filePath,
      chunkIndex,
      score: distanceToScore(distance)
    });
  }

  return parsed.sort((a, b) => b.score - a.score);
}

function distanceToScore(distance: number): number {
  return 1 / (1 + Math.log1p(Math.max(0, distance)));
}

function deduplicateAdjacentChunks(results: DocResult[]): DocResult[] {
  const deduped: DocResult[] = [];

  for (const result of results) {
    const existingIndex = deduped.findIndex(
      (item) =>
        item.filePath === result.filePath &&
        Math.abs(item.chunkIndex - result.chunkIndex) <= 1
    );

    if (existingIndex === -1) {
      deduped.push(result);
      continue;
    }

    if (result.score > deduped[existingIndex].score) {
      deduped[existingIndex] = result;
    }
  }

  return deduped.sort((a, b) => b.score - a.score);
}

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("econnrefused") ||
    message.includes("connection refused") ||
    message.includes("failed to connect") ||
    error.name === "ChromaConnectionError"
  );
}

export function formatDocResults(results: DocResult[]): string {
  if (results.length === 0) {
    return "No docs indexed. Run: infimium index";
  }

  return results
    .map(
      (result, index) =>
        `[${index + 1}] ${result.filePath} (chunk ${result.chunkIndex} · score ${result.score.toFixed(2)})\n${result.content}`
    )
    .join("\n\n---\n\n");
}

export async function runQueryLocalDocs(
  options: LocalDocsSearchOptions,
  query: string,
  topK: number
): Promise<string> {
  try {
    const search = new LocalDocsSearch(options);
    const results = await search.search(query, topK);

    return formatDocResults(results);
  } catch (error: unknown) {
    if (
      error instanceof LocalDocsUnavailableError ||
      error instanceof LocalDocsNotConfiguredError ||
      error instanceof LocalDocsEmptyError
    ) {
      return error.message;
    }

    const message = error instanceof Error ? error.message : String(error);
    return `Local docs search failed: ${message}`;
  }
}
