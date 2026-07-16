import { ChromaClient } from "chromadb";

import { createChromaClient } from "../chroma.js";
import { DEFAULT_OLLAMA_HOST } from "./query-local-docs.js";

const COLLECTION_NAME = "infimium_code";
const OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const SNIPPET_LENGTH = 300;

export type CodeResult = {
  name: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  language: string;
  score: number;
  snippet: string;
};

type CodeMetadata = {
  name?: unknown;
  filePath?: unknown;
  lineStart?: unknown;
  lineEnd?: unknown;
  language?: unknown;
};

type QueryResultLike = {
  documents?: Array<Array<string | null>>;
  metadatas?: Array<Array<CodeMetadata | null>>;
  distances?: Array<Array<number | null>>;
};

type QueryArgs = {
  queryEmbeddings: number[][];
  nResults: number;
  include: Array<"documents" | "metadatas" | "distances">;
  where?: { language: { $eq: string } };
};

type CollectionLike = {
  count(): Promise<number>;
  query(args: QueryArgs): Promise<QueryResultLike>;
};

type ChromaClientLike = {
  getOrCreateCollection(args: {
    name: string;
    embeddingFunction: null;
  }): Promise<CollectionLike>;
};

type CodeSearchOptions = {
  codebasePath: string | null;
  ollamaHost?: string;
  chromaClient?: ChromaClientLike;
};

export class CodeSearchUnavailableError extends Error {
  constructor() {
    super("Code search unavailable. Is ChromaDB running?");
  }
}

export class CodeSearchNotConfiguredError extends Error {
  constructor() {
    super("Add CODEBASE_PATH to your .env");
  }
}

export class CodeSearchEmptyError extends Error {
  constructor() {
    super("Code not indexed. Run: infimium index");
  }
}

export class CodeSearchTool {
  private readonly codebasePath: string | null;
  private readonly ollamaHost: string;
  private readonly chromaClient: ChromaClientLike;

  constructor(options: CodeSearchOptions) {
    this.codebasePath = options.codebasePath;
    this.ollamaHost = options.ollamaHost ?? DEFAULT_OLLAMA_HOST;
    this.chromaClient = options.chromaClient ?? createChromaClient();
  }

  async search(
    query: string,
    language?: string,
    topK: number = 5
  ): Promise<CodeResult[]> {
    if (!this.codebasePath) {
      throw new CodeSearchNotConfiguredError();
    }

    const collection = await this.getCollection();
    const queryEmbedding = await this.embedQuery(query);

    return this.queryCollection(collection, queryEmbedding, language, topK);
  }

  private async getCollection(): Promise<CollectionLike> {
    try {
      return await this.chromaClient.getOrCreateCollection({
        name: COLLECTION_NAME,
        embeddingFunction: null
      });
    } catch (error: unknown) {
      if (isConnectionError(error)) {
        throw new CodeSearchUnavailableError();
      }

      throw error;
    }
  }

  private async queryCollection(
    collection: CollectionLike,
    queryEmbedding: number[],
    language: string | undefined,
    topK: number
  ): Promise<CodeResult[]> {
    try {
      const count = await collection.count();
      if (count === 0) {
        throw new CodeSearchEmptyError();
      }

      const queryArgs: QueryArgs = {
        queryEmbeddings: [queryEmbedding],
        nResults: topK,
        include: ["documents", "metadatas", "distances"]
      };
      if (language) {
        queryArgs.where = { language: { $eq: language } };
      }

      return parseQueryResults(await collection.query(queryArgs));
    } catch (error: unknown) {
      if (error instanceof CodeSearchEmptyError) {
        throw error;
      }

      if (isConnectionError(error)) {
        throw new CodeSearchUnavailableError();
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

function parseQueryResults(result: QueryResultLike): CodeResult[] {
  const documents = result.documents?.[0] ?? [];
  const metadatas = result.metadatas?.[0] ?? [];
  const distances = result.distances?.[0] ?? [];
  const parsed: CodeResult[] = [];

  for (const [index, bodyText] of documents.entries()) {
    const metadata = metadatas[index];
    if (typeof bodyText !== "string" || !metadata) {
      continue;
    }

    const parsedMetadata = parseMetadata(metadata);
    if (!parsedMetadata) {
      continue;
    }

    parsed.push({
      ...parsedMetadata,
      score: distanceToScore(distances[index] ?? 1),
      snippet: bodyText.slice(0, SNIPPET_LENGTH)
    });
  }

  return parsed.sort((a, b) => b.score - a.score);
}

function parseMetadata(metadata: CodeMetadata): Omit<CodeResult, "score" | "snippet"> | null {
  const { name, filePath, lineStart, lineEnd, language } = metadata;
  if (
    typeof name !== "string" ||
    typeof filePath !== "string" ||
    typeof lineStart !== "number" ||
    typeof lineEnd !== "number" ||
    typeof language !== "string"
  ) {
    return null;
  }

  return {
    name,
    filePath,
    lineStart,
    lineEnd,
    language
  };
}

function distanceToScore(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance));
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

export function formatCodeResults(results: CodeResult[]): string {
  if (results.length === 0) {
    return "Code not indexed. Run: infimium index";
  }

  return results
    .map(
      (result, index) =>
        `[${index + 1}] ${result.name}() — ${result.filePath}:${result.lineStart}-${result.lineEnd} (score: ${result.score.toFixed(2)})\n${result.snippet}`
    )
    .join("\n\n");
}

export async function runSemanticCodeSearch(
  options: CodeSearchOptions,
  query: string,
  language: string | undefined,
  topK: number
): Promise<string> {
  try {
    const search = new CodeSearchTool(options);
    const results = await search.search(query, language, topK);

    return formatCodeResults(results);
  } catch (error: unknown) {
    if (
      error instanceof CodeSearchUnavailableError ||
      error instanceof CodeSearchNotConfiguredError ||
      error instanceof CodeSearchEmptyError
    ) {
      return error.message;
    }

    const message = error instanceof Error ? error.message : String(error);
    return `Code search failed: ${message}`;
  }
}
