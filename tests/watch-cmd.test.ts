import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runIndexForPathsMock = vi.fn();
const runIndexForProjectMock = vi.fn();

vi.mock("../src/cli/index-cmd.js", () => ({
  runIndexForPaths: runIndexForPathsMock,
  runIndexForProject: runIndexForProjectMock
}));

describe("auto-index watcher", () => {
  let tempDir: string;
  let codebasePath: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    tempDir = await mkdtemp(join(tmpdir(), "infimium-watch-"));
    codebasePath = join(tempDir, "repo");
    await mkdir(codebasePath, { recursive: true });
    await writeFile(join(codebasePath, "index.ts"), "export const one = 1;\n", "utf8");
    process.env = {
      ...savedEnv,
      CODEBASE_PATH: codebasePath,
      LOCAL_DOCS_PATH: "",
      OLLAMA_HOST: "http://localhost:11434"
    };
  });

  afterEach(async () => {
    vi.useRealTimers();
    process.env = { ...savedEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs index after a new indexable file appears", async () => {
    vi.useRealTimers();
    const { startAutoIndex } = await import("../src/cli/watch-cmd.js");
    const handle = await startAutoIndex({
      scanIntervalMs: 50,
      debounceMs: 25
    });

    await writeFile(join(codebasePath, "new-file.ts"), "export const two = 2;\n", "utf8");
    await delay(250);

    expect(runIndexForPathsMock).toHaveBeenCalledOnce();
    handle.stop();
  });

  it("supports manual runNow", async () => {
    const { startAutoIndex } = await import("../src/cli/watch-cmd.js");
    const handle = await startAutoIndex({
      scanIntervalMs: 10_000
    });

    await handle.runNow();

    expect(runIndexForPathsMock).toHaveBeenCalledOnce();
    handle.stop();
  });
});
