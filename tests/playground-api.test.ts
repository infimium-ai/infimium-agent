import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  readPlaygroundHealth,
  readPlaygroundIndexFiles,
  readPlaygroundLogs,
  readPlaygroundMetrics,
  readPlaygroundPulse,
  readPlaygroundScope,
  readPlaygroundSymbols,
  readPlaygroundWorkspace
} from "../src/playground/api.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((filePath) => rm(filePath, { recursive: true, force: true }))
  );
});

describe("playground read-only data API", () => {
  it("reads the project context snapshot without requiring the new global layout", async () => {
    const projectPath = await createProject();
    await mkdir(join(projectPath, "context"), { recursive: true });
    await writeFile(
      join(projectPath, "context", "layer.md"),
      `schemaVersion: 3
currentTask: Ship the playground
index:
  codeSymbols: 12
  codeFiles: 3
  docsFiles: 1
  docsChunks: 4
  depGraphRelationships: 8
  lastIndexedAt: 2026-07-20T12:00:00.000Z
recentMemory:
  - type: progress
    summary: API routes are wired
    createdAt: 2026-07-20T12:01:00.000Z
workingTree:
  dirty: true
  totalChangedFiles: 1
  summary: 1 source file changed
  changedFiles:
    - status: M
      path: src/index.ts
`,
      "utf8"
    );

    const pulse = readPlaygroundPulse(projectPath);

    expect(pulse.currentTask).toBe("Ship the playground");
    expect(pulse.index?.codeSymbols).toBe(12);
    expect(pulse.recentMemory[0]?.summary).toBe("API routes are wired");
    expect(pulse.workingTree.changedFiles).toEqual([{ status: "M", path: "src/index.ts" }]);
  });

  it("reads symbols and graph edges from SQLite without writing to it", async () => {
    const projectPath = await createProject();
    const sourcePath = join(projectPath, "src", "alpha.ts");
    const importedPath = join(projectPath, "src", "beta.ts");
    const ignoredPath = join(projectPath, "generated", "client.ts");
    const escapedPath = join(projectPath, "..", `outside-${Date.now()}.ts`);
    temporaryPaths.push(escapedPath);
    await mkdir(join(projectPath, "src"), { recursive: true });
    await mkdir(join(projectPath, "generated"), { recursive: true });
    await writeFile(sourcePath, "export function alpha(): number {\n  return beta();\n}\n", "utf8");
    await writeFile(importedPath, "export function beta(): number {\n  return 2;\n}\n", "utf8");
    await writeFile(ignoredPath, "export const generated = true;\n", "utf8");
    await writeFile(escapedPath, "export const outside = true;\n", "utf8");
    await writeFile(join(projectPath, ".infimiumignore"), "generated/\n", "utf8");

    await mkdir(join(projectPath, ".infimium"), { recursive: true });
    const db = new Database(join(projectPath, ".infimium", "infimium.db"));
    db.exec(`
      CREATE TABLE symbol_locations (
        symbol_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line_start INTEGER,
        PRIMARY KEY (symbol_name, file_path)
      );
      CREATE TABLE file_imports (
        source_file TEXT NOT NULL,
        imported_file TEXT NOT NULL,
        PRIMARY KEY (source_file, imported_file)
      );
      CREATE TABLE project_changes (
        project_path TEXT NOT NULL,
        event_type TEXT,
        summary TEXT,
        details TEXT,
        created_at INTEGER
      );
    `);
    db.prepare("INSERT INTO symbol_locations VALUES (?, ?, ?)").run("alpha", sourcePath, 1);
    db.prepare("INSERT INTO symbol_locations VALUES (?, ?, ?)").run(
      "alpha",
      `${projectPath}/src/../src/alpha.ts`,
      1
    );
    db.prepare("INSERT INTO symbol_locations VALUES (?, ?, ?)").run("beta", importedPath, 1);
    db.prepare("INSERT INTO symbol_locations VALUES (?, ?, ?)").run(
      "outside",
      `${projectPath}/../${escapedPath.split("/").at(-1)}`,
      1
    );
    db.prepare("INSERT INTO file_imports VALUES (?, ?)").run(sourcePath, importedPath);
    db.prepare("INSERT INTO project_changes VALUES (?, ?, ?, ?, ?)").run(
      projectPath,
      "index",
      "Indexed 2 symbols",
      null,
      1_721_476_800_000
    );
    db.close();

    const symbols = readPlaygroundSymbols(projectPath, 1, 25);
    const graph = readPlaygroundWorkspace(projectPath);
    const metrics = readPlaygroundMetrics(projectPath);
    const pulse = readPlaygroundPulse(projectPath);
    const logs = readPlaygroundLogs(projectPath);
    const indexFiles = await readPlaygroundIndexFiles(projectPath);
    const health = await readPlaygroundHealth(projectPath);

    expect(symbols.total).toBe(2);
    expect(symbols.items[0]?.skeleton).toContain("function alpha");
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges.some((edge) => edge.type === "imports")).toBe(true);
    expect(metrics.symbolCount).toBe(2);
    expect(metrics.averageSkeletonTokens).toBe(8);
    expect(metrics.averageFullTextTokens).toBe(1460);
    expect(metrics.totalTokensSaved).toBeGreaterThan(0);
    expect(metrics.estimatedUsdSaved).toBeGreaterThan(0);
    expect(pulse.index?.codeSymbols).toBe(2);
    expect(pulse.index?.codeFiles).toBe(2);
    expect(pulse.index?.depGraphRelationships).toBe(1);
    expect(logs.source).toBe("sqlite");
    expect(logs.items[0]?.message).toBe("Indexed 2 symbols");
    expect(indexFiles.indexedFiles).toBe(2);
    expect(indexFiles.files.every((file) => !file.path.startsWith(".."))).toBe(true);
    expect(indexFiles.excludedByInfimiumIgnore).toBe(1);
    expect(health.sqlite).toBe(true);
    expect(health.mcp).toBe(true);
  });

  it("exposes independently watched projects without requiring a workspace manifest", async () => {
    const projectPath = await createProject();
    const secondProjectPath = await createProject();
    await mkdir(join(projectPath, ".infimium"), { recursive: true });
    const db = new Database(join(projectPath, ".infimium", "infimium.db"));
    db.exec("CREATE TABLE project_state (project_path TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO project_state VALUES (?)").run(projectPath);
    db.prepare("INSERT INTO project_state VALUES (?)").run(secondProjectPath);
    db.close();

    const scope = readPlaygroundScope(projectPath);
    const currentCanonicalPath = await realpath(projectPath);
    const expectedPaths = [currentCanonicalPath, await realpath(secondProjectPath)];

    expect(scope.mode).toBe("watched-projects");
    expect(scope.projects.map((project) => project.path).sort()).toEqual(
      expectedPaths.sort()
    );
    expect(scope.projects.find((project) => project.active)?.path).toBe(currentCanonicalPath);
  });

  it("keeps project data isolated while preserving project identity in workspace scope", async () => {
    const workspacePath = await createProject();
    const frontendPath = join(workspacePath, "frontend");
    const backendPath = join(workspacePath, "backend");
    await mkdir(join(frontendPath, "src"), { recursive: true });
    await mkdir(join(backendPath, "src"), { recursive: true });
    await writeFile(
      join(workspacePath, "infimium.workspace.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "Product workspace",
        projects: [
          { id: "frontend", path: "./frontend", role: "active" },
          { id: "backend", path: "./backend", dependsOn: ["frontend"] }
        ]
      }),
      "utf8"
    );
    await createIndexedProject(frontendPath, "renderApp", "frontend indexed", 100);
    await createIndexedProject(backendPath, "serveApi", "backend indexed", 200);

    const scope = readPlaygroundScope(frontendPath);
    const projectSymbols = readPlaygroundSymbols(frontendPath, 1, 25, "", "project");
    const workspaceSymbols = readPlaygroundSymbols(frontendPath, 1, 25, "", "workspace");
    const workspaceFiles = await readPlaygroundIndexFiles(frontendPath, "workspace");
    const workspaceLogs = readPlaygroundLogs(frontendPath, 20, "workspace");

    expect(scope.workspaceName).toBe("Product workspace");
    expect(scope.projects).toHaveLength(2);
    expect(projectSymbols.items.map((symbol) => symbol.name)).toEqual(["renderApp"]);
    expect(workspaceSymbols.items.map((symbol) => symbol.projectId).sort()).toEqual([
      "backend",
      "frontend"
    ]);
    expect(workspaceFiles.files.map((file) => file.projectName).sort()).toEqual([
      "backend",
      "frontend"
    ]);
    expect(workspaceLogs.items.map((item) => item.projectId).sort()).toEqual([
      "backend",
      "frontend"
    ]);
  });
});

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "infimium-playground-"));
  temporaryPaths.push(projectPath);
  return projectPath;
}

async function createIndexedProject(
  projectPath: string,
  symbolName: string,
  logMessage: string,
  createdAt: number
): Promise<void> {
  const sourcePath = join(projectPath, "src", "index.ts");
  await mkdir(join(projectPath, ".infimium"), { recursive: true });
  await writeFile(
    sourcePath,
    `export function ${symbolName}(): string {\n  return "${symbolName}";\n}\n`,
    "utf8"
  );
  const db = new Database(join(projectPath, ".infimium", "infimium.db"));
  db.exec(`
    CREATE TABLE symbol_locations (
      symbol_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_start INTEGER,
      PRIMARY KEY (symbol_name, file_path)
    );
    CREATE TABLE project_changes (
      project_path TEXT NOT NULL,
      event_type TEXT,
      summary TEXT,
      details TEXT,
      created_at INTEGER
    );
  `);
  db.prepare("INSERT INTO symbol_locations VALUES (?, ?, ?)").run(symbolName, sourcePath, 1);
  db.prepare("INSERT INTO project_changes VALUES (?, ?, ?, ?, ?)").run(
    projectPath,
    "index",
    logMessage,
    null,
    createdAt
  );
  db.close();
}
