import type { Config } from "../config.js";

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";

export class MissingSearchApiKeyError extends Error {
  constructor() {
    super("Search unavailable: missing API key");
  }
}

type BraveWebResult = {
  title?: unknown;
  url?: unknown;
  description?: unknown;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveWebResult[];
  };
};

type TinyfishWebResult = {
  title?: unknown;
  name?: unknown;
  url?: unknown;
  link?: unknown;
  snippet?: unknown;
  description?: unknown;
  content?: unknown;
  text?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseBraveResponse(value: unknown): BraveSearchResponse {
  if (!isRecord(value)) {
    return {};
  }

  const web = value.web;
  if (!isRecord(web) || !Array.isArray(web.results)) {
    return {};
  }

  return {
    web: {
      results: web.results.filter(isRecord)
    }
  };
}

function parseTinyfishResponse(value: unknown): TinyfishWebResult[] {
  if (!isRecord(value)) {
    return [];
  }

  const candidateArrays = [
    value.results,
    value.organic_results,
    value.items,
    isRecord(value.web) ? value.web.results : undefined,
    isRecord(value.data) ? value.data.results : undefined
  ];
  const results = candidateArrays.find(Array.isArray);

  return results?.filter(isRecord) ?? [];
}

function toBraveSearchResult(result: BraveWebResult): SearchResult | null {
  if (
    typeof result.title !== "string" ||
    typeof result.url !== "string" ||
    typeof result.description !== "string"
  ) {
    return null;
  }

  return {
    title: result.title,
    url: result.url,
    snippet: result.description
  };
}

function toTinyfishSearchResult(result: TinyfishWebResult): SearchResult | null {
  const title = firstString(result.title, result.name);
  const url = firstString(result.url, result.link);
  const snippet = firstString(
    result.snippet,
    result.description,
    result.content,
    result.text
  );

  if (!title || !url || !snippet) {
    return null;
  }

  return {
    title,
    url,
    snippet
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WebSearchTool {
  constructor(private readonly config: Pick<Config, "searchApiKey" | "searchProvider">) {}

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    if (!this.config.searchApiKey.trim()) {
      throw new MissingSearchApiKeyError();
    }

    if (this.config.searchProvider === "tinyfish") {
      return this.searchTinyfish(query, maxResults);
    }

    return this.searchBrave(query, maxResults);
  }

  private async searchTinyfish(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL(TINYFISH_SEARCH_URL);
    url.searchParams.set("query", query);
    url.searchParams.set("max_results", String(maxResults));

    const response = await this.fetchWithRetry(url, {
      "X-API-Key": this.config.searchApiKey
    });
    const results = parseTinyfishResponse(await response.json());

    return results
      .map(toTinyfishSearchResult)
      .filter((result): result is SearchResult => result !== null)
      .slice(0, maxResults);
  }

  private async searchBrave(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = new URL(BRAVE_SEARCH_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(maxResults));

    const response = await this.fetchWithRetry(url, {
      "X-Subscription-Token": this.config.searchApiKey
    });
    const body = parseBraveResponse(await response.json());

    return (body.web?.results ?? [])
      .map(toBraveSearchResult)
      .filter((result): result is SearchResult => result !== null);
  }

  private async fetchWithRetry(url: URL, headers: Record<string, string>): Promise<Response> {
    let response = await fetch(url, {
      headers
    });

    if (isRetryableStatus(response.status)) {
      await delay(1_000);
      response = await fetch(url, {
        headers
      });
    }

    if (!response.ok) {
      throw new Error(`${this.providerName()} Search API failed with status ${response.status}`);
    }

    return response;
  }

  private providerName(): string {
    return this.config.searchProvider === "tinyfish" ? "Tinyfish" : "Brave";
  }
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No results found for: ${query}`;
  }

  return results
    .map(
      (result, index) =>
        `[${index + 1}] ${result.title}\nURL: ${result.url}\nSnippet: ${result.snippet}`
    )
    .join("\n\n");
}

export async function runWebSearch(
  config: Pick<Config, "searchApiKey" | "searchProvider">,
  query: string,
  maxResults: number
): Promise<string> {
  try {
    const tool = new WebSearchTool(config);
    const results = await tool.search(query, maxResults);

    return formatSearchResults(query, results);
  } catch (error: unknown) {
    if (error instanceof MissingSearchApiKeyError) {
      return error.message;
    }

    return `Search failed: ${getErrorMessage(error)}`;
  }
}
