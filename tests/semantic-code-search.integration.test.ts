import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CodeIndexer } from "../src/indexer/code-indexer.js";
import { CodeSearchTool } from "../src/tools/semantic-code-search.js";

const integrationDescribe = process.env.RUN_INTEGRATION === "true" ? describe : describe.skip;
const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "property");
const ollamaHost = process.env.OLLAMA_HOST?.trim() || "http://localhost:11434";

integrationDescribe("semantic_code_search integration", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "infimium-code-search-"));
    const indexer = new CodeIndexer(
      { ollamaHost },
      undefined,
      undefined,
      join(tempDir, "code-index.db")
    );

    try {
      await indexer.indexCodebase(fixturesPath);
    } finally {
      indexer.close();
    }
  }, 60_000);

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("finds property value calculation logic in the top results", async () => {
    const search = new CodeSearchTool({
      codebasePath: fixturesPath,
      ollamaHost
    });
    const results = await search.search("price calculation logic", "typescript", 3);
    const calcResult = results.find((result) => result.name === "calcPropertyValue");

    expect(calcResult).toBeDefined();
    expect(calcResult?.filePath.endsWith("services/property/calc.ts")).toBe(true);
    expect(calcResult?.lineStart).toBe(1);
  }, 60_000);
});
