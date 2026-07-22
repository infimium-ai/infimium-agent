import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readPlaygroundHealth,
  readPlaygroundIndexFiles,
  readPlaygroundLogs,
  readPlaygroundMemory,
  readPlaygroundMetrics,
  readPlaygroundPulse,
  readPlaygroundScope,
  readPlaygroundSymbols,
  readPlaygroundWorkspace
} from "../src/playground/api.js";

const temporaryPaths: string[] = [];
let previousDataDir: string | undefined;

beforeEach(async () => {
  previousDataDir = process.env.INFIMIUM_DATA_DIR;
  const dataDir = await mkdtemp(join(tmpdir(), "infimium-playground-data-"));
  temporaryPaths.push(dataDir);
  process.env.INFIMIUM_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (previousDataDir === undefined) {
    delete process.env.INFIMIUM_DATA_DIR;
  } else {
    process.env.INFIMIUM_DATA_DIR = previousDataDir;
  }
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

  it("reads tri-zonal context v4 snapshots", async () => {
    const projectPath = await createProject();
    await mkdir(join(projectPath, "context"), { recursive: true });
    await writeFile(
      join(projectPath, "context", "layer.md"),
      `schemaVersion: 4
dynamicState:
  indexHealth:
    codeSymbols: 20
    codeFiles: 4
    docsFiles: 0
    docsChunks: 0
    depGraphRelationships: 7
    lastIndexedAt: 2026-07-20T12:00:00.000Z
  workingTree:
    dirty: true
    totalChangedFiles: 1
    summary: 1 changed file
    changedFiles:
      - status: M
        path: src/memory.ts
activeExecution:
  currentTask: Compact project memory
  activeScratchpad:
    - type: progress
      summary: Added memory sessions
      createdAt: 2026-07-20T12:01:00.000Z
`,
      "utf8"
    );

    const pulse = readPlaygroundPulse(projectPath);
    expect(pulse.currentTask).toBe("Compact project memory");
    expect(pulse.recentMemory[0]?.summary).toBe("Added memory sessions");
    expect(pulse.index?.codeSymbols).toBe(20);
    expect(pulse.workingTree.changedFiles[0]?.path).toBe("src/memory.ts");
  });

  it("reads three-tier memory in read-only observer mode", async () => {
    const projectPath = await createProject();
    await mkdir(join(projectPath, ".infimium"), { recursive: true });
    const db = new Database(join(projectPath, ".infimium", "infimium.db"));
    db.exec(`
      CREATE TABLE memory_sessions (
        id TEXT PRIMARY KEY, project_path TEXT, task TEXT, status TEXT,
        started_at INTEGER, completed_at INTEGER, compacted_at INTEGER
      );
      CREATE TABLE memory_scratchpad (
        id INTEGER PRIMARY KEY, session_id TEXT, project_path TEXT, event_type TEXT,
        summary TEXT, details TEXT, created_at INTEGER, compacted_at INTEGER
      );
      CREATE TABLE memory_archive (
        id INTEGER PRIMARY KEY, session_id TEXT, project_path TEXT, milestone TEXT,
        summary TEXT, files_json TEXT, blockers_json TEXT, completed_at INTEGER
      );
      CREATE TABLE memory_ledger (
        id INTEGER PRIMARY KEY, project_path TEXT, category TEXT, memory_key TEXT,
        value TEXT, status TEXT, source_session_id TEXT, confidence REAL,
        created_at INTEGER, updated_at INTEGER, superseded_by INTEGER
      );
    `);
    db.prepare("INSERT INTO memory_sessions VALUES (?, ?, ?, 'active', ?, NULL, NULL)")
      .run("session-1", projectPath, "Ship memory", 1_000);
    db.prepare("INSERT INTO memory_scratchpad VALUES (1, ?, ?, 'progress', ?, NULL, ?, NULL)")
      .run("session-1", projectPath, "Added schema", 1_100);
    for (let id = 2; id <= 7; id += 1) {
      db.prepare("INSERT INTO memory_scratchpad VALUES (?, ?, ?, 'progress', ?, NULL, ?, NULL)")
        .run(id, "session-1", projectPath, `Event ${id}`, 1_100 + id);
    }
    db.prepare("INSERT INTO memory_archive VALUES (1, 'old', ?, 'Previous release', ?, '[]', '[]', ?)")
      .run(projectPath, "Shipped context v4", 900);
    db.prepare("INSERT INTO memory_ledger VALUES (1, ?, 'rule', 'context-network', ?, 'active', NULL, 1, ?, ?, NULL)")
      .run(projectPath, "get_context stays network-free", 800, 1_200);
    db.close();

    const memory = readPlaygroundMemory(projectPath);
    expect(memory.activeSession?.task).toBe("Ship memory");
    expect(memory.activeSession?.eventCount).toBe(7);
    expect(memory.scratchpad).toHaveLength(5);
    expect(memory.scratchpad[0]?.summary).toBe("Event 7");
    expect(memory.recentMilestones[0]?.milestone).toBe("Previous release");
    expect(memory.ledger[0]?.key).toBe("context-network");
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

  it("exposes globally registered workspaces separately from their projects", async () => {
    const dataDir = await createProject();
    process.env.INFIMIUM_DATA_DIR = dataDir;

    const codexRoot = await createProject();
    const infimiumPath = join(codexRoot, "infimium");
    const starterPath = join(codexRoot, "vite-react-typescript-starter");
    const klubeatsRoot = await createProject();
    const userAppPath = join(klubeatsRoot, "UserApp");
    const brandAppPath = join(klubeatsRoot, "BrandApp");
    const adminAppPath = join(klubeatsRoot, "AdminApp");
    await Promise.all([
      mkdir(infimiumPath, { recursive: true }),
      mkdir(starterPath, { recursive: true }),
      mkdir(userAppPath, { recursive: true }),
      mkdir(brandAppPath, { recursive: true }),
      mkdir(adminAppPath, { recursive: true })
    ]);

    const db = new Database(join(dataDir, "infimium.db"));
    db.exec(`
      CREATE TABLE workspaces (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        manifest_path TEXT NOT NULL UNIQUE,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE workspace_projects (
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        role TEXT,
        PRIMARY KEY (workspace_id, project_id)
      );
      CREATE TABLE workspace_relationships (
        workspace_id TEXT NOT NULL,
        source_project_id TEXT NOT NULL,
        target_project_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        weight INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (workspace_id, source_project_id, target_project_id, relationship_type)
      );
    `);
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?)").run(
      "codex",
      "Codex",
      join(codexRoot, "infimium.workspace.json"),
      200
    );
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?)").run(
      "klubeats",
      "Klubeats",
      join(klubeatsRoot, "infimium.workspace.json"),
      100
    );
    const insertProject = db.prepare("INSERT INTO workspace_projects VALUES (?, ?, ?, ?)");
    insertProject.run("codex", "infimium", infimiumPath, "active");
    insertProject.run("codex", "vite-react-typescript-starter", starterPath, null);
    insertProject.run("klubeats", "UserApp", userAppPath, "active");
    insertProject.run("klubeats", "BrandApp", brandAppPath, null);
    insertProject.run("klubeats", "AdminApp", adminAppPath, null);
    db.close();

    const scope = readPlaygroundScope(infimiumPath);
    const klubeats = scope.workspaces.find((workspace) => workspace.id === "klubeats");

    expect(scope.workspaces.map((workspace) => workspace.name).sort()).toEqual([
      "Codex",
      "Klubeats"
    ]);
    expect(scope.projects.map((project) => project.name).sort()).toEqual([
      "infimium",
      "vite-react-typescript-starter"
    ]);
    expect(klubeats?.projects.map((project) => project.name).sort()).toEqual([
      "AdminApp",
      "BrandApp",
      "UserApp"
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
