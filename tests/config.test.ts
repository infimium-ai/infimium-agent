import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { initEnv } from "../src/cli/init.js";
import { findProjectEnv } from "../src/env.js";

describe("zero-config setup", () => {
  it("does not require a project-local .env", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "infimium-no-env-"));

    expect(findProjectEnv(projectPath)).toBeNull();
  });

  it("creates one global-style config with safe defaults", async () => {
    const configPath = await mkdtemp(join(tmpdir(), "infimium-config-"));
    const installPath = join(configPath, "install.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await initEnv(configPath, { telemetryInstallPath: installPath });

    const envPath = join(configPath, ".env");
    await expect(access(envPath)).resolves.toBeUndefined();
    const content = await readFile(envPath, "utf8");
    expect(content).toContain("OLLAMA_HOST=http://localhost:11434");
    expect(content).toContain("INFIMIUM_AUTO_INDEX=true");
    expect(content).toContain("INFIMIUM_TELEMETRY=true");
    expect(content).not.toContain("CHROMADB_HOST");
    log.mockRestore();
  });

  it("can create config with telemetry disabled", async () => {
    const configPath = await mkdtemp(join(tmpdir(), "infimium-config-"));
    const installPath = join(configPath, "install.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await initEnv(configPath, { telemetryEnabled: false, telemetryInstallPath: installPath });

    const content = await readFile(join(configPath, ".env"), "utf8");
    expect(content).toContain("INFIMIUM_TELEMETRY=false");
    log.mockRestore();
  });
});
