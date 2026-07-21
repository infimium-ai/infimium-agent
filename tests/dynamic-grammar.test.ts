import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DynamicGrammarLoader } from "../src/indexer/dynamic-grammar.js";

const VALID_WASM_PREFIX = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01]);

describe("DynamicGrammarLoader", () => {
  it("downloads a grammar once and reuses the validated cache", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "infimium-grammar-"));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(VALID_WASM_PREFIX, { status: 200 })
    );
    const loader = new DynamicGrammarLoader({
      cacheDir,
      baseUrl: "https://grammars.test",
      fetcher
    });

    const first = await loader.ensureGrammar("go");
    const second = await loader.ensureGrammar("go");

    expect(first).toBe(second);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await readFile(first)).toEqual(Buffer.from(VALID_WASM_PREFIX));
  });

  it("replaces a corrupt cached grammar", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "infimium-grammar-"));
    await writeFile(join(cacheDir, "tree-sitter-rust.wasm"), "not wasm");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(VALID_WASM_PREFIX, { status: 200 })
    );
    const loader = new DynamicGrammarLoader({ cacheDir, fetcher });

    const grammarPath = await loader.ensureGrammar("rust");

    expect(fetcher).toHaveBeenCalledOnce();
    expect(await readFile(grammarPath)).toEqual(Buffer.from(VALID_WASM_PREFIX));
  });

  it("rejects a non-WASM response", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "infimium-grammar-"));
    const loader = new DynamicGrammarLoader({
      cacheDir,
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response("not wasm"))
    });

    await expect(loader.ensureGrammar("java")).rejects.toThrow("not valid WebAssembly");
  });
});
