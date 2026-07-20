import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProjectFilePolicy } from "../src/indexer/project-files.js";

describe("project file policy", () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), "infimium-policy-"));
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it("detects Flutter and blocks generated platform artifacts", async () => {
    await writeFile(join(projectPath, "pubspec.yaml"), "name: sample\n", "utf8");
    const policy = await createProjectFilePolicy(projectPath);

    expect(policy.kind).toBe("flutter");
    expect(policy.isIgnored(join(projectPath, "lib", "main.dart"))).toBe(false);
    expect(policy.isIgnored(join(projectPath, "build", "ios", "Runner.app", "Info.plist"))).toBe(true);
    expect(policy.isIgnored(join(projectPath, "ios", "Pods", "Razorpay.framework", "Razorpay"))).toBe(true);
    expect(policy.isIgnored(join(projectPath, ".dart_tool", "package_config.json"))).toBe(true);
    expect(policy.isIgnored(join(projectPath, "pubspec.lock"))).toBe(true);
  });

  it("combines gitignore and infimium-specific rules", async () => {
    await mkdir(join(projectPath, "generated"), { recursive: true });
    await writeFile(join(projectPath, ".gitignore"), "cache/\n", "utf8");
    await writeFile(join(projectPath, ".infimiumignore"), "generated/\n", "utf8");
    const policy = await createProjectFilePolicy(projectPath);

    expect(policy.isIgnored(join(projectPath, "cache", "state.txt"))).toBe(true);
    expect(policy.isIgnored(join(projectPath, "generated", "client.ts"))).toBe(true);
    expect(policy.isIgnored(join(projectPath, "src", "client.ts"))).toBe(false);
  });
});
