import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import Database from "better-sqlite3";
import { parse as parseDotenv } from "dotenv";
import { Router, type Request, type Response } from "express";
import { glob } from "glob";
import createIgnore from "ignore";
import { parse as parseYaml } from "yaml";

import { findProjectEnv, loadConfigEnvironment } from "../env.js";
import { createProjectId } from "../memory/project-overview.js";
import {
  findWorkspaceProject,
  findWorkspaceManifest,
  loadWorkspace,
  type InfimiumWorkspace
} from "../workspace/workspace.js";

type JsonRecord = Record<string, unknown>;

export type PlaygroundHealth = {
  ollama: boolean;
  mcp: boolean;
  chromadb: boolean;
  chromadbRequired: boolean;
  sqlite: boolean;
  vectorStore: "embedded-sqlite";
};

export type PlaygroundPulse = {
  projectPath: string;
  contextPath: string | null;
  currentTask: string | null;
  recentMemory: Array<{
    type: string;
    summary: string;
    createdAt: string | null;
  }>;
  workingTree: {
    dirty: boolean;
    totalChangedFiles: number;
    summary: string;
    changedFiles: Array<{ status: string; path: string }>;
  };
  index: {
    codeSymbols: number;
    codeFiles: number;
    docsFiles: number;
    docsChunks: number;
    depGraphRelationships: number;
    lastIndexedAt: string | null;
  } | null;
};

export type PlaygroundGraph = {
  name: string;
  nodes: Array<{
    id: string;
    label: string;
    type: "workspace" | "project" | "file";
    role: string | null;
  }>;
  edges: Array<{
    source: string;
    target: string;
    type: string;
    weight: number;
  }>;
};

export type PlaygroundSymbol = {
  id: string;
  name: string;
  type: string;
  language: string;
  filePath: string;
  relativePath: string;
  lineStart: number;
  lineEnd: number;
  skeleton: string;
  fullImplementation: string;
  projectId?: string;
  projectName?: string;
  projectPath?: string;
};

export type PlaygroundSymbolPage = {
  page: number;
  limit: number;
  total: number;
  items: PlaygroundSymbol[];
};

export type PlaygroundMetrics = {
  symbolCount: number;
  averageSkeletonTokens: number;
  averageFullTextTokens: number;
  observedAverageSkeletonTokens: number;
  observedAverageFullTextTokens: number;
  astFirstTokens: number;
  fullTextTokens: number;
  totalTokensSaved: number;
  savingsPercent: number;
  usdPerMillionInputTokens: number;
  estimatedUsdSaved: number;
};

export type PlaygroundLog = {
  id: string;
  type: string;
  message: string;
  details: string | null;
  createdAt: string | null;
  projectId: string;
  projectName: string;
  projectPath: string;
};

export type PlaygroundLogs = {
  projectPath: string;
  scope: PlaygroundScopeMode;
  source: "sqlite" | "context" | "empty";
  items: PlaygroundLog[];
};

export type PlaygroundIndexFiles = {
  projectPath: string;
  scope: PlaygroundScopeMode;
  indexedFiles: number;
  indexedSymbols: number;
  excludedByInfimiumIgnore: number;
  ignoreFilePresent: boolean;
  files: Array<{
    path: string;
    language: string;
    symbolCount: number;
    projectId: string;
    projectName: string;
    projectPath: string;
  }>;
};

export type PlaygroundScopeMode = "project" | "workspace";

export type PlaygroundScope = {
  mode: "single-project" | "watched-projects" | "workspace";
  workspaceName: string | null;
  activeProjectPath: string;
  projects: Array<{
    id: string;
    name: string;
    path: string;
    role: string | null;
    active: boolean;
  }>;
};

type PlaygroundPaths = {
  projectPath: string;
  graphDbPath: string | null;
  codeDbPath: string | null;
  vectorDbPath: string | null;
  contextPath: string | null;
};

type ScopedProject = PlaygroundScope["projects"][number];

export function createPlaygroundRouter(projectPath: string = process.cwd()): Router {
  const rootPath = resolve(projectPath);
  const router = Router();

  router.get("/health", async (request: Request, response: Response) => {
    response.json(await readPlaygroundHealth(readRequestedProjectPath(request, rootPath)));
  });

  router.get("/pulse", (request: Request, response: Response) => {
    response.json(readPlaygroundPulse(readRequestedProjectPath(request, rootPath)));
  });

  router.get("/workspace", (request: Request, response: Response) => {
    response.json(readPlaygroundWorkspace(readRequestedProjectPath(request, rootPath)));
  });

  router.get("/scope", (_request: Request, response: Response) => {
    response.json(readPlaygroundScope(rootPath));
  });

  router.get("/index/symbols", (request: Request, response: Response) => {
    const page = readPositiveInteger(request.query.page, 1, 10_000);
    const limit = readPositiveInteger(request.query.limit, 25, 100);
    const query = typeof request.query.query === "string" ? request.query.query.trim() : "";
    response.json(readPlaygroundSymbols(
      readRequestedProjectPath(request, rootPath),
      page,
      limit,
      query,
      readScopeMode(request)
    ));
  });

  router.get("/index/files", async (request: Request, response: Response) => {
    response.json(await readPlaygroundIndexFiles(
      readRequestedProjectPath(request, rootPath),
      readScopeMode(request)
    ));
  });

  router.get("/metrics", (request: Request, response: Response) => {
    response.json(readPlaygroundMetrics(readRequestedProjectPath(request, rootPath)));
  });

  router.get("/logs", (request: Request, response: Response) => {
    const limit = readPositiveInteger(request.query.limit, 60, 200);
    response.json(readPlaygroundLogs(
      readRequestedProjectPath(request, rootPath),
      limit,
      readScopeMode(request)
    ));
  });

  return router;
}

export async function readPlaygroundHealth(
  projectPath: string = process.cwd()
): Promise<PlaygroundHealth> {
  const paths = resolvePlaygroundPaths(projectPath);
  const ollamaHost = process.env.OLLAMA_HOST?.trim() || "http://localhost:11434";
  const ollama = await canFetch(`${ollamaHost.replace(/\/$/, "")}/api/tags`);
  const sqlite = [paths.graphDbPath, paths.codeDbPath, paths.vectorDbPath]
    .filter((value): value is string => value !== null)
    .some(canOpenReadOnly);

  return {
    ollama,
    mcp: sqlite && (paths.contextPath !== null || readAllSymbols(paths).length > 0),
    chromadb: false,
    chromadbRequired: false,
    sqlite,
    vectorStore: "embedded-sqlite"
  };
}

export function readPlaygroundPulse(
  projectPath: string = process.cwd()
): PlaygroundPulse {
  const paths = resolvePlaygroundPaths(projectPath);
  const snapshot = readContextSnapshot(paths);
  const workingTree = readRecord(snapshot?.workingTree);
  const changedFiles = readChangedFiles(workingTree?.changedFiles);
  const totalChangedFiles = readNumber(workingTree?.totalChangedFiles) ?? changedFiles.length;
  const index = readLiveIndex(paths, readIndex(snapshot?.index));

  return {
    projectPath: paths.projectPath,
    contextPath: paths.contextPath,
    currentTask: readString(snapshot?.currentTask),
    recentMemory: readMemory(snapshot?.recentMemory),
    workingTree: {
      dirty: readBoolean(workingTree?.dirty) ?? totalChangedFiles > 0,
      totalChangedFiles,
      summary:
        readString(workingTree?.summary) ??
        (totalChangedFiles === 0
          ? "Working tree is clean"
          : `${totalChangedFiles} changed file${totalChangedFiles === 1 ? "" : "s"}`),
      changedFiles
    },
    index
  };
}

export function readPlaygroundWorkspace(
  projectPath: string = process.cwd()
): PlaygroundGraph {
  const paths = resolvePlaygroundPaths(projectPath);
  const manifestPath = findWorkspaceManifest(paths.projectPath);
  if (manifestPath) {
    try {
      return readFederatedWorkspace(loadWorkspace(manifestPath), paths.graphDbPath);
    } catch {
      // Fall through to the file graph when a workspace manifest is incomplete.
    }
  }

  return readFileGraph(paths.projectPath, paths.graphDbPath);
}

export function readPlaygroundScope(
  projectPath: string = process.cwd()
): PlaygroundScope {
  const resolvedPath = canonicalPath(projectPath);
  const workspace = readWorkspace(resolvedPath);
  if (!workspace) {
    const paths = resolvePlaygroundPaths(resolvedPath);
    const watchedPaths = readWatchedProjectPaths(paths.graphDbPath, resolvedPath);
    const projects = watchedPaths.map((path) => ({
      id: createProjectId(path),
      name: basename(path),
      path,
      role: path === resolvedPath ? "active" : "watched",
      active: path === resolvedPath
    }));
    return {
      mode: projects.length > 1 ? "watched-projects" : "single-project",
      workspaceName: null,
      activeProjectPath: resolvedPath,
      projects
    };
  }

  const activeProject =
    findWorkspaceProject(workspace, resolvedPath) ??
    workspace.projects.find((project) => project.role === "active") ??
    workspace.projects[0];
  return {
    mode: "workspace",
    workspaceName: workspace.name,
    activeProjectPath: activeProject.path,
    projects: workspace.projects.map((project) => ({
      id: project.id,
      name: project.id,
      path: project.path,
      role: project.role,
      active: project.path === activeProject.path
    }))
  };
}

export function readPlaygroundSymbols(
  projectPath: string = process.cwd(),
  page: number = 1,
  limit: number = 25,
  query: string = "",
  scope: PlaygroundScopeMode = "project"
): PlaygroundSymbolPage {
  const symbols = resolveScopedProjects(projectPath, scope).flatMap((project) =>
    readAllSymbols(resolvePlaygroundPaths(project.path)).map((symbol) => ({
      ...symbol,
      id: `${project.id}:${symbol.id}`,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path
    }))
  );
  const normalizedQuery = query.toLowerCase();
  const filtered = normalizedQuery
    ? symbols.filter((symbol) =>
        `${symbol.projectId} ${symbol.projectName} ${symbol.name} ${symbol.type} ${symbol.language} ${symbol.relativePath}`
          .toLowerCase()
          .includes(normalizedQuery)
      )
    : symbols;
  const safePage = Math.max(1, Math.floor(page));
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const start = (safePage - 1) * safeLimit;

  return {
    page: safePage,
    limit: safeLimit,
    total: filtered.length,
    items: filtered.slice(start, start + safeLimit)
  };
}

export function readPlaygroundMetrics(
  projectPath: string = process.cwd()
): PlaygroundMetrics {
  const paths = resolvePlaygroundPaths(projectPath);
  const allSymbols = readAllSymbols(paths);
  const observedSkeletonTokens = allSymbols.reduce(
    (total, symbol) => total + estimateTokens(symbol.skeleton),
    0
  );
  const observedFullTextTokens = allSymbols.reduce(
    (total, symbol) => total + estimateTokens(symbol.fullImplementation),
    0
  );
  const observedAverageSkeletonTokens = allSymbols.length > 0
    ? Math.max(1, Math.round(observedSkeletonTokens / allSymbols.length))
    : 0;
  const observedAverageFullTextTokens = allSymbols.length > 0
    ? Math.max(1, Math.round(observedFullTextTokens / allSymbols.length))
    : 0;
  if (allSymbols.length === 0) {
    const indexedCount = readPlaygroundPulse(projectPath).index?.codeSymbols ?? 0;
    return buildMetrics(indexedCount, 0, 0);
  }

  return buildMetrics(
    allSymbols.length,
    observedAverageSkeletonTokens,
    observedAverageFullTextTokens
  );
}

export function readPlaygroundLogs(
  projectPath: string = process.cwd(),
  limit: number = 60,
  scope: PlaygroundScopeMode = "project"
): PlaygroundLogs {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const projects = resolveScopedProjects(projectPath, scope);
  const projectLogs = projects.flatMap((project) => readProjectLogs(project, safeLimit));
  const items = projectLogs
    .sort((left, right) => timestampValue(right.createdAt) - timestampValue(left.createdAt))
    .slice(0, safeLimit)
    .reverse();
  const source = items.some((item) => item.id.startsWith("sqlite:"))
    ? "sqlite"
    : items.length > 0 ? "context" : "empty";

  return {
    projectPath: resolve(projectPath),
    scope,
    source,
    items
  };
}

function readProjectLogs(project: ScopedProject, limit: number): PlaygroundLog[] {
  const paths = resolvePlaygroundPaths(project.path);
  if (paths.graphDbPath) {
    const rows = withReadOnlyDatabase(paths.graphDbPath, (db) => {
      if (!tableExists(db, "project_changes")) return [];
      return db
        .prepare(
          `SELECT rowid, project_path, event_type, summary, details, created_at
           FROM project_changes
           ORDER BY COALESCE(created_at, 0) DESC, rowid DESC`
        )
        .all() as Array<JsonRecord>;
    });
    const items = rows
      .filter((row) => {
        const storedPath = readString(row.project_path);
        return storedPath !== null && canonicalPath(storedPath) === canonicalPath(paths.projectPath);
      })
      .slice(0, limit)
      .flatMap((row): PlaygroundLog[] => {
      const message = readString(row.summary);
      if (!message) return [];
      const createdAt = readNumber(row.created_at);
      return [{
        id: `sqlite:${project.id}:${String(readNumber(row.rowid) ?? `${createdAt ?? 0}:${message}`)}`,
        type: readString(row.event_type) ?? "event",
        message,
        details: readString(row.details),
        createdAt: createdAt === null ? null : new Date(createdAt).toISOString(),
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path
      }];
      });
    if (items.length > 0) return items;
  }

  const contextItems = readPlaygroundPulse(paths.projectPath).recentMemory
    .slice(0, limit)
    .map((memory, index) => ({
      id: `context:${project.id}:${index}:${memory.createdAt ?? "unknown"}`,
      type: memory.type,
      message: memory.summary,
      details: null,
      createdAt: memory.createdAt,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path
    }));
  return contextItems;
}

export async function readPlaygroundIndexFiles(
  projectPath: string = process.cwd(),
  scope: PlaygroundScopeMode = "project"
): Promise<PlaygroundIndexFiles> {
  const projects = resolveScopedProjects(projectPath, scope);
  const projectResults = await Promise.all(projects.map(async (project) => {
    const paths = resolvePlaygroundPaths(project.path);
    const symbols = readAllSymbols(paths);
    const fileMap = new Map<string, { language: string; symbolCount: number }>();
    for (const symbol of symbols) {
      const existing = fileMap.get(symbol.relativePath);
      if (existing) existing.symbolCount += 1;
      else fileMap.set(symbol.relativePath, { language: symbol.language, symbolCount: 1 });
    }
    const ignorePath = resolve(paths.projectPath, ".infimiumignore");
    const excluded = existsSync(ignorePath)
      ? await countCustomIgnoredFiles(paths.projectPath, readFileSync(ignorePath, "utf8"))
      : 0;
    return {
      project,
      excluded,
      ignoreFilePresent: existsSync(ignorePath),
      symbols: symbols.length,
      files: [...fileMap.entries()].map(([path, value]) => ({
        path,
        ...value,
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path
      }))
    };
  }));
  const files = projectResults.flatMap((result) => result.files);

  return {
    projectPath: resolve(projectPath),
    scope,
    indexedFiles: files.length,
    indexedSymbols: projectResults.reduce((total, result) => total + result.symbols, 0),
    excludedByInfimiumIgnore: projectResults.reduce((total, result) => total + result.excluded, 0),
    ignoreFilePresent: projectResults.some((result) => result.ignoreFilePresent),
    files: files.sort((left, right) =>
      left.projectName.localeCompare(right.projectName) || left.path.localeCompare(right.path)
    )
  };
}

function readAllSymbols(paths: PlaygroundPaths): PlaygroundSymbol[] {
  const vectorSymbols = paths.vectorDbPath
    ? readVectorSymbols(paths.vectorDbPath, paths.projectPath)
    : [];
  const symbols = vectorSymbols.length > 0
    ? vectorSymbols
    : readLegacySymbols(paths.graphDbPath, paths.projectPath);
  const unique = new Map<string, PlaygroundSymbol>();
  for (const symbol of symbols) {
    const key = `${symbol.filePath}\u0000${symbol.name}\u0000${symbol.lineStart}`;
    if (!unique.has(key)) unique.set(key, symbol);
  }
  return [...unique.values()];
}

function resolvePlaygroundPaths(projectPath: string): PlaygroundPaths {
  loadConfigEnvironment(projectPath);
  const rootPath = resolve(projectPath);
  const projectId = createProjectId(rootPath);
  const projectDataPath = resolveProjectDataPath(rootPath);

  return {
    projectPath: rootPath,
    graphDbPath: firstExistingFile([
      resolve(rootPath, ".infimium", "infimium.db"),
      resolve(projectDataPath, "infimium.db"),
      resolve(rootPath, "infimium.db")
    ]),
    codeDbPath: firstExistingFile([
      resolve(rootPath, ".infimium", "infimium_code.db"),
      resolve(projectDataPath, "infimium_code.db"),
      resolve(rootPath, "infimium_code.db")
    ]),
    vectorDbPath: firstExistingFile([
      resolve(rootPath, ".infimium", "vectors.db"),
      resolve(projectDataPath, "vectors.db"),
      resolve(rootPath, "vectors.db")
    ]),
    contextPath: firstExistingFile([
      resolve(rootPath, ".infimium", "context", "layer.md"),
      resolve(projectDataPath, "context", projectId, "layer.md"),
      resolve(rootPath, "context", "layer.md")
    ])
  };
}

function readWorkspace(projectPath: string): InfimiumWorkspace | null {
  const manifestPath = findWorkspaceManifest(projectPath);
  if (!manifestPath) return null;
  try {
    return loadWorkspace(manifestPath);
  } catch {
    return null;
  }
}

function resolveScopedProjects(
  projectPath: string,
  scope: PlaygroundScopeMode
): ScopedProject[] {
  const scopeInfo = readPlaygroundScope(projectPath);
  if (scope === "workspace" && scopeInfo.mode === "workspace") {
    return scopeInfo.projects;
  }
  return [
    scopeInfo.projects.find((project) => project.active) ?? scopeInfo.projects[0]
  ];
}

function readContextSnapshot(paths: PlaygroundPaths): JsonRecord | null {
  if (paths.contextPath) {
    try {
      return readRecord(parseYaml(readFileSync(paths.contextPath, "utf8")));
    } catch {
      return null;
    }
  }

  if (!paths.graphDbPath) return null;
  return withReadOnlyDatabase(paths.graphDbPath, (db) => {
    if (!tableExists(db, "context_snapshots")) return null;
    const rows = db
      .prepare(
        `SELECT project_path, snapshot_json FROM context_snapshots
         ORDER BY updated_at DESC`
      )
      .all() as Array<{ project_path?: unknown; snapshot_json?: unknown }>;
    const row = rows.find((candidate) =>
      typeof candidate.project_path === "string" &&
      canonicalPath(candidate.project_path) === canonicalPath(paths.projectPath)
    );
    if (typeof row?.snapshot_json !== "string") return null;
    try {
      return readRecord(parseYaml(row.snapshot_json));
    } catch {
      return null;
    }
  });
}

function readFederatedWorkspace(
  workspace: InfimiumWorkspace,
  graphDbPath: string | null
): PlaygroundGraph {
  const nodes: PlaygroundGraph["nodes"] = [
    {
      id: `workspace:${workspace.workspaceId}`,
      label: workspace.name,
      type: "workspace",
      role: null
    },
    ...workspace.projects.map((project) => ({
      id: project.id,
      label: project.id,
      type: "project" as const,
      role: project.role
    }))
  ];
  const edges: PlaygroundGraph["edges"] = workspace.projects.flatMap((project) => [
    {
      source: `workspace:${workspace.workspaceId}`,
      target: project.id,
      type: "contains",
      weight: 1
    },
    ...project.dependsOn.map((target) => ({
      source: project.id,
      target,
      type: "depends_on",
      weight: 1
    }))
  ]);

  if (graphDbPath) {
    const stored = withReadOnlyDatabase(graphDbPath, (db) => {
      if (!tableExists(db, "workspace_relationships")) return [];
      return db
        .prepare(
          `SELECT source_project_id, target_project_id, relationship_type, weight
           FROM workspace_relationships WHERE workspace_id = ?`
        )
        .all(workspace.workspaceId) as Array<JsonRecord>;
    });
    for (const row of stored) {
      const source = readString(row.source_project_id);
      const target = readString(row.target_project_id);
      if (!source || !target) continue;
      edges.push({
        source,
        target,
        type: readString(row.relationship_type) ?? "imports",
        weight: readNumber(row.weight) ?? 1
      });
    }
  }

  return { name: workspace.name, nodes, edges: uniqueEdges(edges) };
}

function readFileGraph(projectPath: string, graphDbPath: string | null): PlaygroundGraph {
  const rootId = `project:${projectPath}`;
  const graph: PlaygroundGraph = {
    name: basename(projectPath),
    nodes: [{ id: rootId, label: basename(projectPath), type: "project", role: "active" }],
    edges: []
  };
  if (!graphDbPath) return graph;

  const rows = withReadOnlyDatabase(graphDbPath, (db) => {
    if (!tableExists(db, "file_imports")) return [];
    return db
      .prepare(
        `SELECT source_file, imported_file FROM file_imports
         ORDER BY source_file`
      )
      .all() as Array<JsonRecord>;
  });
  const seen = new Set([rootId]);
  for (const row of rows) {
    if (graph.edges.length >= 80) break;
    const sourcePath = readString(row.source_file);
    const targetPath = readString(row.imported_file);
    if (!sourcePath || !targetPath) continue;
    const source = projectRelativeFile(projectPath, sourcePath);
    const target = projectRelativeFile(projectPath, targetPath);
    if (!source || !target) continue;
    for (const file of [source, target]) {
      if (seen.has(file.filePath)) continue;
      seen.add(file.filePath);
      graph.nodes.push({
        id: file.filePath,
        label: file.relativePath || basename(file.filePath),
        type: "file",
        role: null
      });
      graph.edges.push({ source: rootId, target: file.filePath, type: "contains", weight: 1 });
    }
    graph.edges.push({
      source: source.filePath,
      target: target.filePath,
      type: "imports",
      weight: 1
    });
  }
  return graph;
}

function readVectorSymbols(vectorDbPath: string, projectPath: string): PlaygroundSymbol[] {
  if (!canOpenReadOnly(vectorDbPath)) {
    return [];
  }

  return withReadOnlyDatabase(vectorDbPath, (db) => {
    if (!tableExists(db, "vector_entries")) return [];
    const rows = db
      .prepare(
        `SELECT id, document, metadata_json FROM vector_entries
         WHERE collection = 'infimium_code' ORDER BY id`
      )
      .all() as Array<{ id: string; document: string; metadata_json: string }>;

    return rows.flatMap((row): PlaygroundSymbol[] => {
      let metadata: JsonRecord | null = null;
      try {
        metadata = readRecord(JSON.parse(row.metadata_json));
      } catch {
        return [];
      }
      const filePath = readString(metadata?.filePath);
      if (!filePath) return [];
      const projectFile = projectRelativeFile(projectPath, filePath);
      if (!projectFile) return [];
      const lineStart = readNumber(metadata?.lineStart) ?? 1;
      const lineEnd = readNumber(metadata?.lineEnd) ?? lineStart;
      const name = readString(metadata?.name) ?? "anonymous";
      return [{
        id: row.id,
        name,
        type: readString(metadata?.type) ?? "symbol",
        language: readString(metadata?.language) ?? "unknown",
        filePath: projectFile.filePath,
        relativePath: projectFile.relativePath,
        lineStart,
        lineEnd,
        skeleton: readString(metadata?.signature) ?? deriveSkeleton(row.document),
        fullImplementation: row.document
      }];
    });
  });
}

function readLegacySymbols(
  graphDbPath: string | null,
  projectPath: string
): PlaygroundSymbol[] {
  if (!graphDbPath) return [];
  return withReadOnlyDatabase(graphDbPath, (db) => {
    if (!tableExists(db, "symbol_locations")) return [];
    const rows = db
      .prepare(
        `SELECT symbol_name, file_path, line_start FROM symbol_locations
         ORDER BY file_path, line_start`
      )
      .all() as Array<JsonRecord>;

    return rows.flatMap((row, index): PlaygroundSymbol[] => {
      const filePath = readString(row.file_path);
      const name = readString(row.symbol_name);
      const lineStart = readNumber(row.line_start);
      if (!filePath || !name || lineStart === null || !existsSync(filePath)) return [];
      const projectFile = projectRelativeFile(projectPath, filePath);
      if (!projectFile) return [];
      const nextRow = rows[index + 1];
      const nextLine =
        readString(nextRow?.file_path) === filePath ? readNumber(nextRow?.line_start) : null;
      const lines = readFileSync(projectFile.filePath, "utf8").split(/\r?\n/);
      const lineEnd = Math.max(lineStart, Math.min(lines.length, (nextLine ?? lineStart + 40) - 1));
      const implementation = lines.slice(lineStart - 1, lineEnd).join("\n");
      return [{
        id: `${filePath}:${name}:${lineStart}`,
        name,
        type: "symbol",
        language: languageFromPath(filePath),
        filePath: projectFile.filePath,
        relativePath: projectFile.relativePath,
        lineStart,
        lineEnd,
        skeleton: deriveSkeleton(implementation),
        fullImplementation: implementation
      }];
    });
  });
}

function buildMetrics(
  symbolCount: number,
  observedAverageSkeletonTokens: number,
  observedAverageFullTextTokens: number
): PlaygroundMetrics {
  const averageSkeletonTokens = symbolCount > 0 ? 8 : 0;
  const averageFullTextTokens = symbolCount > 0 ? 1460 : 0;
  const astFirstTokens = symbolCount * averageSkeletonTokens;
  const fullTextTokens = symbolCount * averageFullTextTokens;
  const totalTokensSaved = Math.max(0, fullTextTokens - astFirstTokens);
  const configuredRate = Number.parseFloat(
    process.env.INFIMIUM_USD_PER_MILLION_INPUT_TOKENS?.trim() ?? "3"
  );
  const usdPerMillionInputTokens = Number.isFinite(configuredRate) && configuredRate >= 0
    ? configuredRate
    : 3;
  return {
    symbolCount,
    averageSkeletonTokens,
    averageFullTextTokens,
    observedAverageSkeletonTokens,
    observedAverageFullTextTokens,
    astFirstTokens,
    fullTextTokens,
    totalTokensSaved,
    savingsPercent: fullTextTokens > 0
      ? Math.round((totalTokensSaved / fullTextTokens) * 1000) / 10
      : 0,
    usdPerMillionInputTokens,
    estimatedUsdSaved: Math.round(
      (totalTokensSaved / 1_000_000) * usdPerMillionInputTokens * 10_000
    ) / 10_000
  };
}

async function countCustomIgnoredFiles(
  projectPath: string,
  ignoreContents: string
): Promise<number> {
  const matcher = createIgnore().add(ignoreContents);
  const candidates = await glob("**/*", {
    cwd: projectPath,
    nodir: true,
    dot: true,
    ignore: [".git/**", "node_modules/**", "dist/**"]
  });
  return candidates.filter((filePath) => matcher.ignores(filePath)).length;
}

function readIndex(value: unknown): PlaygroundPulse["index"] {
  const index = readRecord(value);
  if (!index) return null;
  return {
    codeSymbols: readNumber(index.codeSymbols) ?? 0,
    codeFiles: readNumber(index.codeFiles) ?? 0,
    docsFiles: readNumber(index.docsFiles) ?? 0,
    docsChunks: readNumber(index.docsChunks) ?? 0,
    depGraphRelationships: readNumber(index.depGraphRelationships) ?? 0,
    lastIndexedAt: readString(index.lastIndexedAt)
  };
}

function readLiveIndex(
  paths: PlaygroundPaths,
  fallback: PlaygroundPulse["index"]
): PlaygroundPulse["index"] {
  const symbols = readAllSymbols(paths);
  const hasIndexDatabase = Boolean(
    paths.graphDbPath || paths.codeDbPath || paths.vectorDbPath
  );
  if (!hasIndexDatabase && symbols.length === 0) return fallback;

  const indexedFiles = new Set(symbols.map((symbol) => symbol.filePath)).size;
  const relationships = paths.graphDbPath
    ? withReadOnlyDatabase(paths.graphDbPath, (db) => {
        if (!tableExists(db, "file_imports")) return null;
        const rows = db.prepare("SELECT source_file FROM file_imports").all() as JsonRecord[];
        return rows.filter((row) => {
          const sourcePath = readString(row.source_file);
          return sourcePath !== null && projectRelativeFile(paths.projectPath, sourcePath) !== null;
        }).length;
      })
    : null;
  const indexedAt = paths.codeDbPath
    ? withReadOnlyDatabase(paths.codeDbPath, (db) => {
        if (!tableExists(db, "indexed_code_files")) return null;
        const rows = db
          .prepare("SELECT file_path, indexed_at FROM indexed_code_files")
          .all() as JsonRecord[];
        return rows.reduce<number | null>((latest, row) => {
          const filePath = readString(row.file_path);
          const indexedAt = readNumber(row.indexed_at);
          if (!filePath || indexedAt === null || !projectRelativeFile(paths.projectPath, filePath)) {
            return latest;
          }
          return latest === null ? indexedAt : Math.max(latest, indexedAt);
        }, null);
      })
    : null;

  return {
    codeSymbols: symbols.length > 0 ? symbols.length : fallback?.codeSymbols ?? 0,
    codeFiles: indexedFiles > 0 ? indexedFiles : fallback?.codeFiles ?? 0,
    docsFiles: fallback?.docsFiles ?? 0,
    docsChunks: fallback?.docsChunks ?? 0,
    depGraphRelationships: relationships ?? fallback?.depGraphRelationships ?? 0,
    lastIndexedAt:
      indexedAt === null
        ? fallback?.lastIndexedAt ?? null
        : new Date(indexedAt).toISOString()
  };
}

function readMemory(value: unknown): PlaygroundPulse["recentMemory"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PlaygroundPulse["recentMemory"] => {
    const record = readRecord(entry);
    const summary = readString(record?.summary);
    if (!summary) return [];
    return [{
      type: readString(record?.type) ?? "note",
      summary,
      createdAt: readString(record?.createdAt)
    }];
  });
}

function readChangedFiles(value: unknown): PlaygroundPulse["workingTree"]["changedFiles"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PlaygroundPulse["workingTree"]["changedFiles"] => {
    const record = readRecord(entry);
    const path = readString(record?.path);
    if (!path) return [];
    return [{ path, status: readString(record?.status) ?? "?" }];
  }).slice(0, 10);
}

function firstExistingFile(candidates: string[]): string | null {
  return candidates.find((candidate) => {
    try {
      return existsSync(candidate) && statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

function readRequestedProjectPath(request: Request, rootPath: string): string {
  const requestedPath = typeof request.query.project === "string"
    ? canonicalPath(request.query.project)
    : canonicalPath(rootPath);
  const scope = readPlaygroundScope(rootPath);
  return scope.projects.find((project) => canonicalPath(project.path) === requestedPath)?.path
    ?? scope.activeProjectPath;
}

function readWatchedProjectPaths(graphDbPath: string | null, currentPath: string): string[] {
  const canonicalCurrent = canonicalPath(currentPath);
  if (!graphDbPath) return [canonicalCurrent];

  const paths = withReadOnlyDatabase(graphDbPath, (db) => {
    const tables = [
      "project_changes",
      "project_state",
      "context_snapshots",
      "project_overviews",
      "active_project"
    ].filter((tableName) => tableExists(db, tableName));
    if (tables.length === 0) return [];
    const union = tables.map((tableName) => `SELECT project_path FROM ${tableName}`).join(" UNION ");
    return db.prepare(`SELECT DISTINCT project_path FROM (${union})`).all() as JsonRecord[];
  });

  const unique = new Map<string, string>();
  for (const rawPath of [currentPath, ...paths.map((row) => readString(row.project_path))]) {
    if (!rawPath) continue;
    const projectPath = canonicalPath(rawPath);
    try {
      if (!statSync(projectPath).isDirectory()) continue;
    } catch {
      continue;
    }
    unique.set(projectPath, projectPath);
  }

  return [...unique.values()].sort((left, right) => {
    if (left === canonicalCurrent) return -1;
    if (right === canonicalCurrent) return 1;
    return basename(left).localeCompare(basename(right)) || left.localeCompare(right);
  });
}

function resolveProjectDataPath(projectPath: string): string {
  const projectEnvPath = findProjectEnv(projectPath);
  const projectDataDir = projectEnvPath
    ? readDataDirectoryFromEnv(projectEnvPath)
    : null;
  if (projectDataDir) return projectDataDir;

  const globalEnvPath = resolve(homedir(), ".infimium", ".env");
  return readDataDirectoryFromEnv(globalEnvPath)
    ?? resolve(homedir(), ".infimium", "data");
}

function readDataDirectoryFromEnv(envPath: string): string | null {
  if (!existsSync(envPath)) return null;
  try {
    const configuredPath = parseDotenv(readFileSync(envPath)).INFIMIUM_DATA_DIR?.trim();
    return configuredPath ? resolve(dirname(envPath), configuredPath) : null;
  } catch {
    return null;
  }
}

function readScopeMode(request: Request): PlaygroundScopeMode {
  return request.query.scope === "workspace" ? "workspace" : "project";
}

function timestampValue(value: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function canOpenReadOnly(filePath: string): boolean {
  try {
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    db.prepare("SELECT 1").get();
    db.close();
    return true;
  } catch {
    return false;
  }
}

function withReadOnlyDatabase<T>(filePath: string, callback: (db: Database.Database) => T): T {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    return callback(db);
  } finally {
    db.close();
  }
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) !== undefined;
}

async function canFetch(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function readPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function uniqueEdges(edges: PlaygroundGraph["edges"]): PlaygroundGraph["edges"] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.source}\0${edge.target}\0${edge.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function projectRelativeFile(
  projectPath: string,
  filePath: string
): { filePath: string; relativePath: string } | null {
  const canonicalProject = canonicalPath(projectPath);
  const canonicalFile = canonicalPath(filePath);
  const relativePath = relative(canonicalProject, canonicalFile);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return {
    filePath: canonicalFile,
    relativePath: relativePath.replaceAll("\\", "/")
  };
}

function canonicalPath(filePath: string): string {
  const resolvedPath = resolve(filePath);
  try {
    return realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function deriveSkeleton(source: string): string {
  const firstLine = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.replace(/\s*\{\s*$/, "") ?? "symbol";
}

function languageFromPath(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase();
  const names: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    dart: "dart",
    go: "go",
    rs: "rust",
    java: "java"
  };
  return names[extension ?? ""] ?? "unknown";
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function readRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "bigint"
      ? Number(value)
      : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
