import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseIndexArgs } from "../src/cli/index-options.js";
import {
  buildDetectedWorkspaceManifest,
  detectMultiProjectWorkspace,
  writeDetectedWorkspaceManifest
} from "../src/workspace/discovery.js";
import { loadWorkspace } from "../src/workspace/workspace.js";

describe("automatic workspace discovery", () => {
  let rootPath: string;

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), "infimium-discovery-"));
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  it("discovers sibling Flutter projects and ignores generated directories", async () => {
    await createFlutterProject("UserApp", "user_app");
    await createFlutterProject("BrandApp", "brand_app");
    await createFlutterProject("AdminApp", "admin_app");
    await createFlutterProject("build", "generated_app");

    const discovery = await detectMultiProjectWorkspace(join(rootPath, "UserApp"));

    expect(discovery).not.toBeNull();
    expect(discovery?.projects.map((project) => project.name)).toEqual([
      "AdminApp",
      "BrandApp",
      "UserApp"
    ]);
    expect(discovery?.projects.map((project) => project.role)).toEqual([
      "administration Flutter application",
      "brand and merchant Flutter application",
      "customer Flutter application"
    ]);
  });

  it("infers a Supabase dependency from project configuration", async () => {
    const appPath = join(rootPath, "web-app");
    const supabasePath = join(rootPath, "supabase");
    await mkdir(appPath);
    await mkdir(supabasePath);
    await writeFile(
      join(appPath, "package.json"),
      JSON.stringify({
        name: "web-app",
        dependencies: { "@supabase/supabase-js": "latest" }
      }),
      "utf8"
    );
    await writeFile(join(supabasePath, "config.toml"), "project_id = \"local\"\n", "utf8");

    const discovery = await detectMultiProjectWorkspace(rootPath);

    expect(discovery?.projects).toEqual([
      expect.objectContaining({ id: "supabase", kind: "supabase", dependsOn: [] }),
      expect.objectContaining({ id: "web-app", kind: "node", dependsOn: ["supabase"] })
    ]);
  });

  it("writes a manifest that passes workspace validation", async () => {
    await createFlutterProject("UserApp", "user_app");
    await createFlutterProject("AdminApp", "admin_app");
    const discovery = await detectMultiProjectWorkspace(rootPath);
    expect(discovery).not.toBeNull();

    const output = buildDetectedWorkspaceManifest(discovery!);
    expect(output.projects.map((project) => project.path)).toEqual([
      "./AdminApp",
      "./UserApp"
    ]);

    const manifestPath = await writeDetectedWorkspaceManifest(discovery!);
    const stored = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    expect(stored).toEqual(output);
    expect(loadWorkspace(manifestPath).projects).toHaveLength(2);
  });

  async function createFlutterProject(directory: string, packageName: string): Promise<void> {
    const projectPath = join(rootPath, directory);
    await mkdir(projectPath);
    await writeFile(
      join(projectPath, "pubspec.yaml"),
      `name: ${packageName}\ndependencies:\n  flutter:\n    sdk: flutter\n`,
      "utf8"
    );
  }
});

describe("index workspace flags", () => {
  it("supports unattended setup and explicit opt-outs", () => {
    expect(parseIndexArgs(["--yes", "--no-playground"])).toEqual({
      acceptWorkspace: true,
      detectWorkspace: true,
      openPlayground: false
    });
    expect(parseIndexArgs(["--no-workspace"])).toEqual({
      acceptWorkspace: false,
      detectWorkspace: false,
      openPlayground: true
    });
  });

  it("fails loudly for unknown flags", () => {
    expect(() => parseIndexArgs(["--silent"])).toThrow("Unknown index argument: --silent");
  });
});
