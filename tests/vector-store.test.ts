import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { EmbeddedVectorClient } from "../src/vector-store.js";

describe("EmbeddedVectorClient", () => {
  it("stores, filters, ranks, and deletes vectors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "infimium-vectors-"));
    const client = new EmbeddedVectorClient(join(directory, "vectors.db"));
    const collection = await client.getOrCreateCollection({ name: "code" });

    await collection.upsert({
      ids: ["one", "two", "three"],
      embeddings: [[1, 0], [0.8, 0.2], [0, 1]],
      documents: ["alpha", "near alpha", "beta"],
      metadatas: [
        { projectPath: "/one", language: "typescript" },
        { projectPath: "/one", language: "python" },
        { projectPath: "/two", language: "typescript" }
      ]
    });

    const result = await collection.query({
      queryEmbeddings: [[1, 0]],
      nResults: 5,
      where: {
        $and: [
          { projectPath: { $eq: "/one" } },
          { language: { $eq: "typescript" } }
        ]
      }
    });

    expect(result.ids[0]).toEqual(["one"]);
    expect(result.distances[0][0]).toBeCloseTo(0, 5);
    expect(await collection.count()).toBe(3);

    await collection.delete({ where: { projectPath: "/one" } });
    expect(await collection.count()).toBe(1);
  });
});
