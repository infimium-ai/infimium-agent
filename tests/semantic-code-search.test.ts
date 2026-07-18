import { afterEach, describe, expect, it, vi } from "vitest";

import { runSemanticCodeSearch } from "../src/tools/semantic-code-search.js";

type FakeCollection = {
  count: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
};

function embeddingResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ embedding: [0.1, 0.2, 0.3] })
  } as Response;
}

function fakeClient(collection: FakeCollection) {
  return {
    getOrCreateCollection: vi.fn().mockResolvedValue(collection)
  };
}

describe("CodeSearchTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("formats semantic code results and applies a language filter", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(embeddingResponse()));
    const collection = {
      count: vi.fn().mockResolvedValue(1),
      query: vi.fn().mockResolvedValue({
        documents: [["function calcPropertyValue() {\n  return 42;\n}"]],
        metadatas: [[{
          name: "calcPropertyValue",
          filePath: "services/property/calc.ts",
          lineStart: 142,
          lineEnd: 189,
          language: "typescript"
        }]],
        distances: [[0.06]]
      })
    };

    const output = await runSemanticCodeSearch(
      {
        codebasePath: "/code",
        ollamaHost: "http://ollama.test",
        chromaClient: fakeClient(collection)
      },
      "price calculation logic",
      "typescript",
      3
    );

    expect(output).toBe(
      "[1] calcPropertyValue() — services/property/calc.ts:142-189 (score: 0.94)\nfunction calcPropertyValue() {\n  return 42;\n}"
    );
    expect(collection.query).toHaveBeenCalledWith({
      queryEmbeddings: [[0.1, 0.2, 0.3]],
      nResults: 3,
      include: ["documents", "metadatas", "distances"],
      where: { language: { $eq: "typescript" } }
    });
  });

  it("keeps scores nonzero for Chroma distances above one", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(embeddingResponse()));
    const collection = {
      count: vi.fn().mockResolvedValue(1),
      query: vi.fn().mockResolvedValue({
        documents: [["export function findContextLayer() {}"]],
        metadatas: [[{
          name: "findContextLayer",
          filePath: "src/context.ts",
          lineStart: 1,
          lineEnd: 1,
          language: "typescript"
        }]],
        distances: [[2]]
      })
    };

    const output = await runSemanticCodeSearch(
      {
        codebasePath: "/code",
        ollamaHost: "http://ollama.test",
        chromaClient: fakeClient(collection)
      },
      "context layer",
      undefined,
      1
    );

    expect(output).toContain("score: 0.48");
  });

  it("returns the not configured message", async () => {
    const collection = {
      count: vi.fn(),
      query: vi.fn()
    };

    const output = await runSemanticCodeSearch(
      { codebasePath: null, chromaClient: fakeClient(collection) },
      "price calculation logic",
      undefined,
      5
    );

    expect(output).toBe("Add CODEBASE_PATH to your .env");
    expect(collection.count).not.toHaveBeenCalled();
  });

  it("returns the empty collection message", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(embeddingResponse()));
    const collection = {
      count: vi.fn().mockResolvedValue(0),
      query: vi.fn()
    };

    const output = await runSemanticCodeSearch(
      { codebasePath: "/code", chromaClient: fakeClient(collection) },
      "price calculation logic",
      undefined,
      5
    );

    expect(output).toBe("Code not indexed. Run: infimium index");
  });

  it("returns the ChromaDB unavailable message", async () => {
    const chromaClient = {
      getOrCreateCollection: vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:8000"))
    };

    const output = await runSemanticCodeSearch(
      { codebasePath: "/code", chromaClient },
      "price calculation logic",
      undefined,
      5
    );

    expect(output).toBe("Code search unavailable. Is ChromaDB running?");
  });
});
