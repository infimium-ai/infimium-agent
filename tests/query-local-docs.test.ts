import { afterEach, describe, expect, it, vi } from "vitest";

import { runQueryLocalDocs } from "../src/tools/query-local-docs.js";

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

describe("LocalDocsSearch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("formats ChromaDB results", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(embeddingResponse()));
    const collection = {
      count: vi.fn().mockResolvedValue(2),
      query: vi.fn().mockResolvedValue({
        documents: [["The setup guide content"]],
        metadatas: [[{ filePath: "/docs/setup.md", chunkIndex: 3 }]],
        distances: [[0.08]]
      })
    };

    const chromaClient = fakeClient(collection);
    const output = await runQueryLocalDocs(
      { localDocsPath: "/docs", chromaClient },
      "setup",
      1
    );

    expect(output).toBe(
      "[1] /docs/setup.md (chunk 3 · score 0.93)\nThe setup guide content"
    );
    expect(collection.query).toHaveBeenCalledWith({
      queryEmbeddings: [[0.1, 0.2, 0.3]],
      nResults: 2,
      include: ["documents", "metadatas", "distances"],
      where: { projectPath: { $eq: "/docs" } }
    });
    expect(chromaClient.getOrCreateCollection).toHaveBeenCalledWith({
      name: "infimium_docs",
      embeddingFunction: null
    });
  });

  it("deduplicates adjacent chunks by keeping the higher score", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(embeddingResponse()));
    const collection = {
      count: vi.fn().mockResolvedValue(3),
      query: vi.fn().mockResolvedValue({
        documents: [["Lower score", "Higher score", "Other file"]],
        metadatas: [[
          { filePath: "/docs/a.md", chunkIndex: 2 },
          { filePath: "/docs/a.md", chunkIndex: 3 },
          { filePath: "/docs/b.md", chunkIndex: 1 }
        ]],
        distances: [[0.2, 0.05, 0.1]]
      })
    };

    const output = await runQueryLocalDocs(
      { localDocsPath: "/docs", chromaClient: fakeClient(collection) },
      "topic",
      5
    );

    expect(output).toContain("Higher score");
    expect(output).not.toContain("Lower score");
    expect(output).toContain("Other file");
  });

  it("returns the empty collection message", async () => {
    const collection = {
      count: vi.fn().mockResolvedValue(0),
      query: vi.fn()
    };

    const output = await runQueryLocalDocs(
      { localDocsPath: "/docs", chromaClient: fakeClient(collection) },
      "setup",
      5
    );

    expect(output).toBe("No docs indexed. Run: infimium index");
  });

  it("returns the not configured message", async () => {
    const collection = {
      count: vi.fn(),
      query: vi.fn()
    };

    const output = await runQueryLocalDocs(
      { localDocsPath: null, chromaClient: fakeClient(collection) },
      "setup",
      5
    );

    expect(output).toBe("Add LOCAL_DOCS_PATH to your .env");
    expect(collection.count).not.toHaveBeenCalled();
  });

  it("returns the ChromaDB unavailable message", async () => {
    const chromaClient = {
      getOrCreateCollection: vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:8000"))
    };

    const output = await runQueryLocalDocs(
      { localDocsPath: "/docs", chromaClient },
      "setup",
      5
    );

    expect(output).toBe("Local docs unavailable. Is ChromaDB running?");
  });

  it("returns the ChromaDB unavailable message when collection operations fail", async () => {
    const collection = {
      count: vi.fn().mockRejectedValue(new Error("connection refused")),
      query: vi.fn()
    };

    const output = await runQueryLocalDocs(
      { localDocsPath: "/docs", chromaClient: fakeClient(collection) },
      "setup",
      5
    );

    expect(output).toBe("Local docs unavailable. Is ChromaDB running?");
  });
});
