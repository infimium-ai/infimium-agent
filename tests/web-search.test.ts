import { afterEach, describe, expect, it, vi } from "vitest";

import { runWebSearch } from "../src/tools/web-search.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

describe("WebSearchTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("formats normal Tinyfish results", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          {
            title: "Infimium",
            url: "https://infimium.ai",
            snippet: "Local MCP search infrastructure."
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const output = await runWebSearch(
      { searchApiKey: "test-key", searchProvider: "tinyfish" },
      "infimium",
      1
    );

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("https://api.search.tinyfish.ai/");
    expect(String(url)).toContain("query=infimium");
    expect(init?.headers).toEqual({ "X-API-Key": "test-key" });
    expect(output).toBe(
      "[1] Infimium\nURL: https://infimium.ai\nSnippet: Local MCP search infrastructure."
    );
  });

  it("formats normal Brave fallback results", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      jsonResponse({
        web: {
          results: [
            {
              title: "Infimium",
              url: "https://infimium.ai",
              description: "Local MCP search infrastructure."
            }
          ]
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const output = await runWebSearch(
      { searchApiKey: "test-key", searchProvider: "brave" },
      "infimium",
      1
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(output).toBe(
      "[1] Infimium\nURL: https://infimium.ai\nSnippet: Local MCP search infrastructure."
    );
  });

  it("handles empty Tinyfish results", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const output = await runWebSearch(
      { searchApiKey: "test-key", searchProvider: "tinyfish" },
      "missing topic",
      5
    );

    expect(output).toBe("No results found for: missing topic");
  });

  it("handles Tinyfish API errors gracefully", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse({ message: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const output = await runWebSearch(
      { searchApiKey: "test-key", searchProvider: "tinyfish" },
      "infimium",
      5
    );

    expect(output).toBe(
      "Search failed: Tinyfish Search API failed with status 401"
    );
  });
});
