import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { Language, Parser } from "web-tree-sitter";

export type DynamicGrammarName = "go" | "rust" | "java";

export type DynamicGrammarOptions = {
  cacheDir?: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
};

const GRAMMAR_PACKAGE_VERSION = "0.1.17";
const DEFAULT_BASE_URL = `https://unpkg.com/@repomix/tree-sitter-wasms@${GRAMMAR_PACKAGE_VERSION}/out`;
const MAX_GRAMMAR_BYTES = 8 * 1024 * 1024;
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const require = createRequire(import.meta.url);

let runtimePromise: Promise<void> | null = null;

export class DynamicGrammarLoader {
  private readonly cacheDir: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly languageCache = new Map<DynamicGrammarName, Promise<Language>>();

  constructor(options: DynamicGrammarOptions = {}) {
    this.cacheDir = resolve(
      options.cacheDir ??
        process.env.INFIMIUM_GRAMMAR_DIR?.trim() ??
        resolve(homedir(), ".infimium", "grammars")
    );
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  async load(name: DynamicGrammarName): Promise<Language> {
    const cached = this.languageCache.get(name);
    if (cached) {
      return cached;
    }

    const pending = this.loadUncached(name);
    this.languageCache.set(name, pending);
    try {
      return await pending;
    } catch (error: unknown) {
      this.languageCache.delete(name);
      throw error;
    }
  }

  async ensureGrammar(name: DynamicGrammarName): Promise<string> {
    const grammarPath = resolve(this.cacheDir, `tree-sitter-${name}.wasm`);
    if (existsSync(grammarPath)) {
      const existing = await readFile(grammarPath);
      if (isValidWasm(existing)) {
        return grammarPath;
      }
      await unlink(grammarPath);
    }

    await mkdir(this.cacheDir, { recursive: true });
    const response = await this.fetcher(`${this.baseUrl}/tree-sitter-${name}.wasm`);
    if (!response.ok) {
      throw new Error(`Failed to download ${name} grammar: HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_GRAMMAR_BYTES) {
      throw new Error(`${name} grammar exceeds the ${MAX_GRAMMAR_BYTES} byte safety limit`);
    }
    if (!isValidWasm(bytes)) {
      throw new Error(`Downloaded ${name} grammar is not valid WebAssembly`);
    }

    const temporaryPath = `${grammarPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, bytes, { mode: 0o600 });
    await rename(temporaryPath, grammarPath);
    return grammarPath;
  }

  private async loadUncached(name: DynamicGrammarName): Promise<Language> {
    await initializeRuntime();
    const grammarPath = await this.ensureGrammar(name);
    return Language.load(new Uint8Array(await readFile(grammarPath)));
  }
}

function initializeRuntime(): Promise<void> {
  if (!runtimePromise) {
    const runtimePath = require.resolve("web-tree-sitter/tree-sitter.wasm");
    runtimePromise = Parser.init({
      locateFile: () => runtimePath
    });
  }
  return runtimePromise;
}

function isValidWasm(bytes: Uint8Array): boolean {
  return bytes.byteLength >= WASM_MAGIC.length &&
    WASM_MAGIC.every((value, index) => bytes[index] === value);
}
