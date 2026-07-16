import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DepGraphBuilder } from "../src/indexer/dep-graph.js";
import { DepGraphTool } from "../src/tools/dep-graph.js";

const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "property");
const calcFilePath = join(fixturesPath, "services", "property", "calc.ts");

function fakeClient() {
  return {
    getOrCreateCollection: vi.fn().mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        metadatas: [
          {
            name: "calcPropertyValue",
            filePath: calcFilePath,
            lineStart: 1
          }
        ]
      })
    })
  };
}

describe("dep graph", () => {
  let tempDir: string;
  let sqlitePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "infimium-dep-graph-"));
    sqlitePath = join(tempDir, "infimium.db");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("finds files that import a symbol definition", async () => {
    const builder = new DepGraphBuilder(fakeClient(), sqlitePath);
    await builder.buildGraph(fixturesPath);
    builder.close();

    const tool = new DepGraphTool({ sqlitePath, codebasePath: fixturesPath });
    const result = tool.query("calcPropertyValue");
    tool.close();

    expect(result.definedIn).toBe(calcFilePath);
    expect(result.importedBy.some((filePath) => filePath.endsWith("api/routes/listing.ts"))).toBe(true);
    expect(result.importedBy.some((filePath) => filePath.endsWith("utils/tax.ts"))).toBe(true);
  });

  it("returns an empty graph for unknown symbols", async () => {
    const builder = new DepGraphBuilder(fakeClient(), sqlitePath);
    await builder.buildGraph(fixturesPath);
    builder.close();

    const tool = new DepGraphTool({ sqlitePath, codebasePath: fixturesPath });
    const result = tool.query("unknownSymbol");
    tool.close();

    expect(result).toEqual({
      symbol: "unknownSymbol",
      definedIn: null,
      importedBy: [],
      imports: []
    });
  });
});
