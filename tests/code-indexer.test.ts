import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodeIndexer } from "../src/indexer/code-indexer.js";

type FakeCollection = {
  delete: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
};

type UpsertArgs = {
  ids: string[];
  documents: string[];
  metadatas: Array<{ name: string; signature: string }>;
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

describe("CodeIndexer", () => {
  let tempDir: string;
  let sqlitePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "infimium-code-indexer-"));
    sqlitePath = join(tempDir, "code-index.db");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(embeddingResponse()));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("embeds and inserts parsed symbols into ChromaDB", async () => {
    const filePath = join(tempDir, "sample.ts");
    await writeFile(
      filePath,
      [
        "export function first(): void {}",
        "const second = () => 'ok';",
        "class Third {}"
      ].join("\n"),
      "utf8"
    );
    const collection = {
      delete: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({
        metadatas: [
          {
            name: "first",
            filePath,
            lineStart: 1
          },
          {
            name: "second",
            filePath,
            lineStart: 2
          },
          {
            name: "Third",
            filePath,
            lineStart: 3
          }
        ]
      }),
      upsert: vi.fn().mockResolvedValue(undefined)
    };

    const indexer = new CodeIndexer(
      { ollamaHost: "http://ollama.test" },
      fakeClient(collection),
      undefined,
      sqlitePath,
      join(tempDir, "dep-graph.db")
    );
    const stats = await indexer.indexCodebase(tempDir);
    indexer.close();

    expect(stats).toEqual({
      filesProcessed: 1,
      symbolsIndexed: 3,
      filesSkipped: 0,
      filesPruned: 0
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(collection.delete).toHaveBeenCalledWith({ where: { filePath } });
    expect(collection.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = collection.upsert.mock.calls[0]?.[0] as UpsertArgs;
    expect(upsertArgs.ids).toHaveLength(3);
    expect(upsertArgs.documents).toHaveLength(3);
    expect(upsertArgs.metadatas.map((metadata) => metadata.name)).toEqual([
      "first",
      "second",
      "Third"
    ]);
    expect(upsertArgs.metadatas[0]?.signature).toContain("function first");
  });

  it("skips unchanged files without re-embedding symbols", async () => {
    await writeFile(
      join(tempDir, "sample.ts"),
      [
        "function first(): void {}",
        "const second = () => 'ok';",
        "class Third {}"
      ].join("\n"),
      "utf8"
    );
    const collection = {
      delete: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({
        metadatas: [
          {
            name: "first",
            filePath: join(tempDir, "sample.ts"),
            lineStart: 1
          },
          {
            name: "second",
            filePath: join(tempDir, "sample.ts"),
            lineStart: 2
          },
          {
            name: "Third",
            filePath: join(tempDir, "sample.ts"),
            lineStart: 3
          }
        ]
      }),
      upsert: vi.fn().mockResolvedValue(undefined)
    };
    const chromaClient = fakeClient(collection);

    const firstIndexer = new CodeIndexer(
      { ollamaHost: "http://ollama.test" },
      chromaClient,
      undefined,
      sqlitePath,
      join(tempDir, "dep-graph.db")
    );
    await firstIndexer.indexCodebase(tempDir);
    firstIndexer.close();

    const secondIndexer = new CodeIndexer(
      { ollamaHost: "http://ollama.test" },
      chromaClient,
      undefined,
      sqlitePath,
      join(tempDir, "dep-graph.db")
    );
    const secondStats = await secondIndexer.indexCodebase(tempDir);
    secondIndexer.close();

    expect(secondStats).toEqual({
      filesProcessed: 0,
      symbolsIndexed: 0,
      filesSkipped: 1,
      filesPruned: 0
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(collection.delete).toHaveBeenCalledTimes(1);
    expect(collection.upsert).toHaveBeenCalledTimes(1);
  });

  it("prunes deleted files from SQLite and ChromaDB", async () => {
    const filePath = join(tempDir, "deleted.ts");
    await writeFile(filePath, "export function removed(): void {}\n", "utf8");
    const collection = {
      delete: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ metadatas: [] }),
      upsert: vi.fn().mockResolvedValue(undefined)
    };
    const chromaClient = fakeClient(collection);
    const firstIndexer = new CodeIndexer(
      { ollamaHost: "http://ollama.test" },
      chromaClient,
      undefined,
      sqlitePath,
      join(tempDir, "dep-graph.db")
    );
    await firstIndexer.indexCodebase(tempDir);
    firstIndexer.close();

    await unlink(filePath);
    const secondIndexer = new CodeIndexer(
      { ollamaHost: "http://ollama.test" },
      chromaClient,
      undefined,
      sqlitePath,
      join(tempDir, "dep-graph.db")
    );
    const stats = await secondIndexer.indexCodebase(tempDir);
    secondIndexer.close();

    expect(stats.filesPruned).toBe(1);
    expect(collection.delete).toHaveBeenLastCalledWith({ where: { filePath } });
  });
});
