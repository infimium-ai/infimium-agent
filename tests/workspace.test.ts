import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildWorkspaceManifest } from "../src/commands/workspace.js";
import {
  findWorkspaceManifest,
  findWorkspaceProject,
  loadWorkspace,
  loadWorkspaceForProject
} from "../src/workspace/workspace.js";

describe("Infimium workspace manifest", () => {
  let rootPath: string;
  let frontendPath: string;
  let backendPath: string;
  let manifestPath: string;

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), "infimium-workspace-"));
    frontendPath = join(rootPath, "apps", "frontend");
    backendPath = join(rootPath, "services", "backend");
    manifestPath = join(rootPath, "infimium.workspace.json");
    await mkdir(frontendPath, { recursive: true });
    await mkdir(backendPath, { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        name: "Example stack",
        projects: [
          { id: "frontend", path: "./apps/frontend", role: "client", dependsOn: ["backend"] },
          { id: "backend", path: "./services/backend", role: "api" }
        ]
      }),
      "utf8"
    );
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  it("discovers a manifest above a nested project and resolves all roots", () => {
    expect(findWorkspaceManifest(frontendPath)).toBe(manifestPath);

    const workspace = loadWorkspaceForProject(frontendPath);
    expect(workspace).toMatchObject({
      schemaVersion: 1,
      name: "Example stack"
    });
    expect(workspace?.projects).toEqual([
      { id: "frontend", path: frontendPath, role: "client", dependsOn: ["backend"] },
      { id: "backend", path: backendPath, role: "api", dependsOn: [] }
    ]);
    expect(findWorkspaceProject(workspace!, join(frontendPath, "lib"))?.id).toBe("frontend");
  });

  it("rejects relationships that point to an unknown project", async () => {
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: "Broken",
        projects: [{ id: "frontend", path: "./apps/frontend", dependsOn: ["missing"] }]
      }),
      "utf8"
    );

    expect(() => loadWorkspace(manifestPath)).toThrow("depends on unknown project missing");
  });

  it("builds a beginner-friendly manifest from project paths", () => {
    expect(
      buildWorkspaceManifest(rootPath, [frontendPath, backendPath], "Example stack")
    ).toEqual({
      schemaVersion: 1,
      name: "Example stack",
      projects: [
        { id: "frontend", path: "./apps/frontend", role: "app", dependsOn: [] },
        { id: "backend", path: "./services/backend", role: "app", dependsOn: [] }
      ]
    });
  });

  it("rejects overlapping roots so project context cannot be ambiguous", async () => {
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: "Overlapping",
        projects: [
          { id: "frontend", path: "./apps/frontend" },
          { id: "nested", path: "./apps/frontend/src" }
        ]
      }),
      "utf8"
    );
    await mkdir(join(frontendPath, "src"));

    expect(() => loadWorkspace(manifestPath)).toThrow("project roots overlap");
  });
});
