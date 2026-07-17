import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSearchCommand } from "../src/commands/search.js";

const savedEnv = { ...process.env };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

describe("search command", () => {
  beforeEach(() => {
    process.env = {
      ...savedEnv,
      SEARCH_PROVIDER: "tinyfish",
      SEARCH_API_KEY: "test-key"
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
  });

  it("prints formatted Tinyfish results from a terminal query", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        results: [
          {
            title: "Salman Khan",
            url: "https://example.test/salman-khan",
            snippet: "Indian actor and film producer."
          }
        ]
      })
    );
    const logMock = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock);

    await runSearchCommand(["who is", "Salman Khan", "--max-results", "1"]);

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("query=who+is+Salman+Khan");
    expect(String(url)).toContain("max_results=1");
    expect(logMock).toHaveBeenCalledWith(
      "[1] Salman Khan\nURL: https://example.test/salman-khan\nSnippet: Indian actor and film producer."
    );
  });
});
