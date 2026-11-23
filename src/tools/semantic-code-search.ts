import { resolve } from "node:path";

import { createVectorClient } from "../vector-store.js";
import { DEFAULT_OLLAMA_HOST } from "./query-local-docs.js";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  isTransientError,
  type RetryConfig,
  retryWithBackoff
} from "./resilience.js";

const COLLECTION_NAME = "infimium_code";
const OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const SKELETON_LENGTH = 300;

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
  signature?: unknown;
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
  where?:
    | { projectPath: { $eq: string } }
    | { $and: Array<{ projectPath: { $eq: string } } | { language: { $eq: string } }> };
};

type CollectionLike = {
  count(): Promise<number>;
  query(args: QueryArgs): Promise<QueryResultLike>;
};

type VectorClientLike = {
  getOrCreateCollection(args: {
    name: string;
    embeddingFunction: null;
  }): Promise<CollectionLike>;
};

type CodeSearchOptions = {
  codebasePath: string | null;
  ollamaHost?: string;
  vectorClient?: VectorClientLike;
  retryConfig?: RetryConfig;
};

export class CodeSearchUnavailableError extends Error {
  readonly details: string | undefined;

  constructor(details?: string) {
    const message = details
      ? `Code search unavailable: ${details}`
      : "Code search unavailable. Embedded vector index could not be opened.";
    super(message);
    this.name = "CodeSearchUnavailableError";
    this.details = details;
  }
}

export class CodeSearchNotConfiguredError extends Error {
  constructor() {
    super("Add CODEBASE_PATH to your .env");
    this.name = "CodeSearchNotConfiguredError";
  }
}

export class CodeSearchEmptyError extends Error {
  constructor() {
    super("Code not indexed. Run: infimium index");
    this.name = "CodeSearchEmptyError";
  }
}

export class CodeSearchDegradedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeSearchDegradedError";
  }
}

export class CodeSearchTool {
  private readonly codebasePath: string | null;
  private readonly ollamaHost: string;
  private readonly vectorClient: VectorClientLike;
  private readonly ollamaCircuitBreaker: CircuitBreaker;
  private readonly retryConfig: RetryConfig | undefined;

  constructor(options: CodeSearchOptions) {
    this.codebasePath = options.codebasePath ? resolve(options.codebasePath) : null;
    this.ollamaHost = options.ollamaHost ?? DEFAULT_OLLAMA_HOST;
    this.vectorClient = options.vectorClient ?? createVectorClient();
    this.retryConfig = options.retryConfig;
    this.ollamaCircuitBreaker = new CircuitBreaker(3, 10_000, 1);
  }

  async search(
    query: string,
    language?: string,
    topK: number = 5
  ): Promise<CodeResult[]> {
    const codebasePath = this.codebasePath;
    if (!codebasePath) {
      throw new CodeSearchNotConfiguredError();
    }

    try {
      const collection = await this.getCollection();
      const queryEmbedding = await this.embedQueryWithRetry(query);
      return this.queryCollection(collection, queryEmbedding, language, topK, codebasePath);
    } catch (error: unknown) {
      if (error instanceof CircuitBreakerOpenError) {
        throw new CodeSearchDegradedError(
          "Semantic search is temporarily unavailable (Ollama unreachable). Try again in a few seconds."
        );
      }

      if (isTransientError(error)) {
        throw new CodeSearchDegradedError(
          "Semantic search is temporarily unavailable (Ollama unreachable). Try again in a few seconds."
        );
      }

      if (
        error instanceof CodeSearchUnavailableError ||
        error instanceof CodeSearchNotConfiguredError ||
        error instanceof CodeSearchEmptyError ||
        error instanceof CodeSearchDegradedError
      ) {
        throw error;
      }

      throw error;
    }
  }

  private async getCollection(): Promise<CollectionLike> {
    try {
      return await this.vectorClient.getOrCreateCollection({
        name: COLLECTION_NAME,
        embeddingFunction: null
      });
    } catch (error: unknown) {
      if (isTransientError(error)) {
        throw new CodeSearchUnavailableError();
      }

      throw new CodeSearchUnavailableError(
        error instanceof Error ? error.message : "Unknown error opening vector store"
      );
    }
  }

  private async queryCollection(
    collection: CollectionLike,
    queryEmbedding: number[],
    language: string | undefined,
    topK: number,
    projectPath: string
  ): Promise<CodeResult[]> {
    try {
      const count = await collection.count();
      if (count === 0) {
        throw new CodeSearchEmptyError();
      }

      const queryArgs: QueryArgs = {
        queryEmbeddings: [queryEmbedding],
        nResults: topK,
        include: ["documents", "metadatas", "distances"],
        where: { projectPath: { $eq: projectPath } }
      };
      if (language) {
        queryArgs.where = {
          $and: [
            { projectPath: { $eq: projectPath } },
            { language: { $eq: language } }
          ]
        };
      }

      return parseQueryResults(await collection.query(queryArgs));
    } catch (error: unknown) {
      if (error instanceof CodeSearchEmptyError) {
        throw error;
      }

      if (isTransientError(error)) {
        throw new CodeSearchUnavailableError();
      }

      throw new CodeSearchUnavailableError(
        error instanceof Error ? error.message : "Vector store query error"
      );
    }
  }

  private async embedQueryWithRetry(query: string): Promise<number[]> {
    return retryWithBackoff(
      () => this.ollamaCircuitBreaker.execute(() => this.embedQuery(query)),
      (error) => isTransientError(error) && !(error instanceof CircuitBreakerOpenError),
      this.retryConfig
    );
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
      snippet: buildSkeleton(bodyText, metadata.signature)
    });
  }

  return parsed.sort((a, b) => b.score - a.score);
}

function buildSkeleton(bodyText: string, signature: unknown): string {
  if (typeof signature === "string" && signature.trim()) {
    return truncate(signature.trim(), SKELETON_LENGTH);
  }

  const bodyStart = bodyText.search(/\{|=>|:\s*(?:\n|$)/);
  const candidate = bodyStart > 0 ? bodyText.slice(0, bodyStart) : bodyText.split("\n", 1)[0] ?? bodyText;
  return truncate(candidate.replace(/\s+/g, " ").trim(), SKELETON_LENGTH);
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
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
  return 1 / (1 + Math.log1p(Math.max(0, distance)));
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
    if (error instanceof CodeSearchNotConfiguredError) {
      return error.message;
    }

    if (error instanceof CodeSearchEmptyError) {
      return error.message;
    }

    if (error instanceof CodeSearchDegradedError) {
      return `${error.message}\nTip: Check Ollama status with 'infimium doctor' or run 'ollama serve'.`;
    }

    if (error instanceof CodeSearchUnavailableError) {
      return error.details
        ? `${error.message}\nTip: Run 'infimium doctor' to diagnose issues.`
        : error.message;
    }

    const message = error instanceof Error ? error.message : String(error);
    return `Code search failed: ${message}`;
  }
}
