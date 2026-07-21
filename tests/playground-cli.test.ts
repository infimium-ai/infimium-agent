import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePlaygroundDirectory } from "../src/cli/playground.js";

describe("playground CLI", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "infimium-playground-cli-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("prefers the packaged playground over a caller project's dist directory", async () => {
    const packageCliDir = join(tempDir, "node_modules", "infimium", "dist", "src", "cli");
    const packagedPlayground = join(tempDir, "node_modules", "infimium", "dist", "playground-ui");
    const callerProject = join(tempDir, "AdminApp");
    const callerPlayground = join(callerProject, "dist", "playground-ui");
    await mkdir(join(packagedPlayground, "assets"), { recursive: true });
    await mkdir(join(callerPlayground, "assets"), { recursive: true });
    await mkdir(packageCliDir, { recursive: true });
    await writeFile(join(packagedPlayground, "index.html"), "packaged", "utf8");
    await writeFile(join(callerPlayground, "index.html"), "caller", "utf8");

    expect(resolvePlaygroundDirectory(packageCliDir, callerProject)).toBe(packagedPlayground);
  });

  it("falls back to the source checkout build directory", async () => {
    const sourceCliDir = join(tempDir, "src", "cli");
    const builtPlayground = join(tempDir, "dist", "playground-ui");
    await mkdir(sourceCliDir, { recursive: true });
    await mkdir(join(builtPlayground, "assets"), { recursive: true });
    await writeFile(join(builtPlayground, "index.html"), "built", "utf8");

    expect(resolvePlaygroundDirectory(sourceCliDir, tempDir)).toBe(builtPlayground);
  });
});
