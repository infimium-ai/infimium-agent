import type { Config } from "../config.js";

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

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

function toSearchResult(result: BraveWebResult): SearchResult | null {
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
  constructor(private readonly config: Pick<Config, "searchApiKey">) {}

  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    if (!this.config.searchApiKey.trim()) {
      throw new MissingSearchApiKeyError();
    }

    const url = new URL(BRAVE_SEARCH_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(maxResults));

    const response = await this.fetchWithRetry(url);
    const body = parseBraveResponse(await response.json());

    return (body.web?.results ?? [])
      .map(toSearchResult)
      .filter((result): result is SearchResult => result !== null);
  }

  private async fetchWithRetry(url: URL): Promise<Response> {
    let response = await fetch(url, {
      headers: {
        "X-Subscription-Token": this.config.searchApiKey
      }
    });

    if (isRetryableStatus(response.status)) {
      await delay(1_000);
      response = await fetch(url, {
        headers: {
          "X-Subscription-Token": this.config.searchApiKey
        }
      });
    }

    if (!response.ok) {
      throw new Error(`Brave Search API failed with status ${response.status}`);
    }

    return response;
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
  config: Pick<Config, "searchApiKey">,
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
