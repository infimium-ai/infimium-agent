import { afterEach, describe, expect, it, vi } from "vitest";

import { runFetchUrl } from "../src/tools/fetch-url.js";

function htmlResponse(html: string, status = 200): Response {
  return {
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    status,
    text: async () => html
  } as Response;
}

describe("FetchUrlTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns markdown from a simple HTML page", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      htmlResponse(
        "<html><body><nav>Menu</nav><main><h1>Hello</h1><p>World</p></main></body></html>"
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const output = await runFetchUrl("https://example.com");

    expect(output).toBe("Hello\n=====\n\nWorld");
  });

  it("returns an HTTP error for non-200 responses", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(htmlResponse("Not found", 404));
    vi.stubGlobal("fetch", fetchMock);

    const output = await runFetchUrl("https://example.com/missing");

    expect(output).toBe("Failed to fetch https://example.com/missing: HTTP 404");
  });

  it("returns a timeout message when the request aborts", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    const output = await runFetchUrl("https://example.com/slow");

    expect(output).toBe("Timeout fetching https://example.com/slow");
  });
});
