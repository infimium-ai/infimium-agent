import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const savedEnv = { ...process.env };

const runFetchUrlMock = vi.fn();
const runSemanticCodeSearchMock = vi.fn();
const runQueryLocalDocsMock = vi.fn();

vi.mock("../src/tools/fetch-url.js", () => ({
  runFetchUrl: runFetchUrlMock
}));

vi.mock("../src/tools/semantic-code-search.js", () => ({
  runSemanticCodeSearch: runSemanticCodeSearchMock
}));

vi.mock("../src/tools/query-local-docs.js", () => ({
  runQueryLocalDocs: runQueryLocalDocsMock
}));

describe("CLI retrieval commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...savedEnv,
      CODEBASE_PATH: "/repo",
      LOCAL_DOCS_PATH: "/repo/docs",
      OLLAMA_HOST: "http://localhost:11434"
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
  });

  it("runs fetch with an extract mode", async () => {
    const { runFetchCommand } = await import("../src/commands/fetch.js");
    const logMock = vi.spyOn(console, "log").mockImplementation(() => {});
    runFetchUrlMock.mockResolvedValue("Fetched markdown");

    await runFetchCommand(["https://example.com", "--extract", "text"]);

    expect(runFetchUrlMock).toHaveBeenCalledWith("https://example.com", "text");
    expect(logMock).toHaveBeenCalledWith("Fetched markdown");
  });

  it("runs semantic code search with language and top-k", async () => {
    const { runCodeSearchCommand } = await import("../src/commands/code-search.js");
    const logMock = vi.spyOn(console, "log").mockImplementation(() => {});
    runSemanticCodeSearchMock.mockResolvedValue("Code results");

    await runCodeSearchCommand([
      "price calculation",
      "--language",
      "typescript",
      "--top-k",
      "3"
    ]);

    expect(runSemanticCodeSearchMock).toHaveBeenCalledWith(
      {
        codebasePath: "/repo",
        ollamaHost: "http://localhost:11434"
      },
      "price calculation",
      "typescript",
      3
    );
    expect(logMock).toHaveBeenCalledWith("Code results");
  });

  it("runs docs search with top-k", async () => {
    const { runDocsSearchCommand } = await import("../src/commands/docs-search.js");
    const logMock = vi.spyOn(console, "log").mockImplementation(() => {});
    runQueryLocalDocsMock.mockResolvedValue("Doc results");

    await runDocsSearchCommand(["setup guide", "--limit", "2"]);

    expect(runQueryLocalDocsMock).toHaveBeenCalledWith(
      {
        localDocsPath: "/repo/docs",
        ollamaHost: "http://localhost:11434"
      },
      "setup guide",
      2
    );
    expect(logMock).toHaveBeenCalledWith("Doc results");
  });
});
