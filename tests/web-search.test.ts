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

  it("formats normal Brave results", async () => {
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
      { searchApiKey: "test-key" },
      "infimium",
      1
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(output).toBe(
      "[1] Infimium\nURL: https://infimium.ai\nSnippet: Local MCP search infrastructure."
    );
  });

  it("handles empty Brave results", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse({ web: { results: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    const output = await runWebSearch(
      { searchApiKey: "test-key" },
      "missing topic",
      5
    );

    expect(output).toBe("No results found for: missing topic");
  });

  it("handles Brave API errors gracefully", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse({ message: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const output = await runWebSearch(
      { searchApiKey: "test-key" },
      "infimium",
      5
    );

    expect(output).toBe(
      "Search failed: Brave Search API failed with status 401"
    );
  });
});
