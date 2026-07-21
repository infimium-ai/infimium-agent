import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import { WORKSPACE_FILE_NAME, createProjectSlug } from "./workspace.js";

const IGNORED_DIRECTORIES = new Set([
  ".dart_tool",
  ".git",
  ".idea",
  ".next",
  ".nuxt",
  ".turbo",
  ".vscode",
  "android",
  "assets",
  "build",
  "coverage",
  "dist",
  "docs",
  "ios",
  "lib",
  "linux",
  "macos",
  "node_modules",
  "public",
  "src",
  "test",
  "tests",
  "web",
  "windows"
]);

export type DetectedProjectKind =
  | "flutter"
  | "node"
  | "supabase"
  | "rust"
  | "go"
  | "python";

export type DetectedWorkspaceProject = {
  id: string;
  name: string;
  path: string;
  kind: DetectedProjectKind;
  role: string;
  dependsOn: string[];
};

export type WorkspaceDiscovery = {
  rootPath: string;
  name: string;
  projects: DetectedWorkspaceProject[];
};

export type DetectedWorkspaceManifest = {
  schemaVersion: 1;
  name: string;
  projects: Array<{
    id: string;
    path: string;
    role: string;
    dependsOn: string[];
  }>;
};

type ProjectSignals = {
  kind: DetectedProjectKind;
  packageName: string | null;
  localDependencyPaths: string[];
  usesSupabase: boolean;
  dependencyNames: string[];
};

type DetectedProjectWithSignals = DetectedWorkspaceProject & ProjectSignals;

export async function detectMultiProjectWorkspace(
  startPath: string
): Promise<WorkspaceDiscovery | null> {
  const resolvedStartPath = resolve(startPath);
  const startDirectory = await resolveDirectory(resolvedStartPath);
  const candidates = [startDirectory];
  if (await detectProjectSignals(startDirectory)) {
    candidates.push(dirname(startDirectory));
  }

  for (const rootPath of [...new Set(candidates)]) {
    const projects = await detectDirectProjects(rootPath);
    if (projects.length >= 2) {
      return {
        rootPath,
        name: formatWorkspaceName(basename(rootPath)),
        projects: inferDependencies(projects)
      };
    }
  }

  return null;
}

export function buildDetectedWorkspaceManifest(
  discovery: WorkspaceDiscovery
): DetectedWorkspaceManifest {
  return {
    schemaVersion: 1,
    name: discovery.name,
    projects: discovery.projects.map((project) => ({
      id: project.id,
      path: toRelativeManifestPath(discovery.rootPath, project.path),
      role: project.role,
      dependsOn: project.dependsOn
    }))
  };
}

export async function writeDetectedWorkspaceManifest(
  discovery: WorkspaceDiscovery
): Promise<string> {
  const manifestPath = resolve(discovery.rootPath, WORKSPACE_FILE_NAME);
  if (existsSync(manifestPath)) {
    throw new Error(`${WORKSPACE_FILE_NAME} already exists at ${manifestPath}`);
  }

  await writeFile(
    manifestPath,
    `${JSON.stringify(buildDetectedWorkspaceManifest(discovery), null, 2)}\n`,
    "utf8"
  );
  return manifestPath;
}

async function detectDirectProjects(rootPath: string): Promise<DetectedProjectWithSignals[]> {
  const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => []);
  const usedIds = new Set<string>();
  const projects: DetectedProjectWithSignals[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || shouldIgnoreDirectory(entry.name)) {
      continue;
    }

    const projectPath = resolve(rootPath, entry.name);
    const signals = await detectProjectSignals(projectPath);
    if (!signals) {
      continue;
    }

    const id = uniqueProjectId(signals.packageName ?? entry.name, usedIds);
    projects.push({
      id,
      name: entry.name,
      path: projectPath,
      role: inferRole(entry.name, signals),
      dependsOn: [],
      ...signals
    });
  }

  return projects;
}

function inferDependencies(
  projects: DetectedProjectWithSignals[]
): DetectedWorkspaceProject[] {
  const projectByPath = new Map(projects.map((project) => [resolve(project.path), project]));
  const supabaseProject = projects.find((project) => project.kind === "supabase") ?? null;

  return projects.map((project) => {
    const signals = project;
    const dependencies = new Set<string>();

    for (const dependencyPath of signals.localDependencyPaths ?? []) {
      const dependency = projectByPath.get(resolve(project.path, dependencyPath));
      if (dependency && dependency.id !== project.id) {
        dependencies.add(dependency.id);
      }
    }

    if (signals.usesSupabase && supabaseProject && supabaseProject.id !== project.id) {
      dependencies.add(supabaseProject.id);
    }

    const {
      packageName: _packageName,
      localDependencyPaths: _paths,
      usesSupabase: _uses,
      dependencyNames: _dependencyNames,
      ...clean
    } = signals;
    return {
      ...clean,
      dependsOn: [...dependencies].sort()
    };
  });
}

async function detectProjectSignals(projectPath: string): Promise<ProjectSignals | null> {
  const pubspecPath = resolve(projectPath, "pubspec.yaml");
  if (existsSync(pubspecPath)) {
    const parsed = await readYamlRecord(pubspecPath);
    const dependencies = readRecord(parsed?.dependencies);
    return {
      kind: "flutter",
      packageName: readString(parsed?.name),
      localDependencyPaths: readDartPathDependencies(dependencies),
      usesSupabase: hasDependency(dependencies, "supabase"),
      dependencyNames: Object.keys(dependencies)
    };
  }

  const packagePath = resolve(projectPath, "package.json");
  if (existsSync(packagePath)) {
    const parsed = await readJsonRecord(packagePath);
    const dependencies = {
      ...readRecord(parsed?.dependencies),
      ...readRecord(parsed?.devDependencies)
    };
    return {
      kind: "node",
      packageName: readString(parsed?.name),
      localDependencyPaths: readNodePathDependencies(dependencies),
      usesSupabase: hasDependency(dependencies, "supabase"),
      dependencyNames: Object.keys(dependencies)
    };
  }

  if (existsSync(resolve(projectPath, "config.toml")) && basename(projectPath).toLowerCase() === "supabase") {
    return emptySignals("supabase");
  }
  if (existsSync(resolve(projectPath, "supabase", "config.toml"))) {
    return emptySignals("supabase");
  }
  if (existsSync(resolve(projectPath, "Cargo.toml"))) {
    return emptySignals("rust");
  }
  if (existsSync(resolve(projectPath, "go.mod"))) {
    return emptySignals("go");
  }
  if (
    existsSync(resolve(projectPath, "pyproject.toml")) ||
    existsSync(resolve(projectPath, "requirements.txt"))
  ) {
    return emptySignals("python");
  }

  return null;
}

function emptySignals(kind: DetectedProjectKind): ProjectSignals {
  return {
    kind,
    packageName: null,
    localDependencyPaths: [],
    usesSupabase: false,
    dependencyNames: []
  };
}

function inferRole(projectName: string, signals: ProjectSignals): string {
  const normalized = projectName.toLowerCase();
  const kind = signals.kind;
  if (kind === "flutter") {
    if (normalized.includes("admin")) return "administration Flutter application";
    if (normalized.includes("brand") || normalized.includes("merchant")) {
      return "brand and merchant Flutter application";
    }
    if (normalized.includes("user") || normalized.includes("customer")) {
      return "customer Flutter application";
    }
    return "Flutter application";
  }
  if (kind === "supabase") return "Supabase backend";
  if (kind === "node") {
    const dependencies = new Set(signals.dependencyNames);
    if (dependencies.has("firebase-functions")) return "Firebase functions backend";
    if (
      dependencies.has("express") ||
      dependencies.has("fastify") ||
      dependencies.has("@nestjs/core")
    ) {
      return "Node.js API service";
    }
    if (dependencies.has("next")) return "Next.js web application";
    if (dependencies.has("react")) return "React web application";
    return "Node.js application";
  }
  if (kind === "rust") return "Rust service";
  if (kind === "go") return "Go service";
  return "Python service";
}

function readDartPathDependencies(dependencies: Record<string, unknown>): string[] {
  return Object.values(dependencies)
    .map((value) => readString(readRecord(value).path))
    .filter((value): value is string => value !== null);
}

function readNodePathDependencies(dependencies: Record<string, unknown>): string[] {
  return Object.values(dependencies)
    .filter((value): value is string => typeof value === "string")
    .filter((value) => value.startsWith("file:"))
    .map((value) => value.slice("file:".length));
}

function hasDependency(dependencies: Record<string, unknown>, fragment: string): boolean {
  return Object.keys(dependencies).some((name) => name.toLowerCase().includes(fragment));
}

async function readYamlRecord(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return readRecord(parseYaml(await readFile(filePath, "utf8")));
  } catch {
    return null;
  }
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return readRecord(JSON.parse(await readFile(filePath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

async function resolveDirectory(candidatePath: string): Promise<string> {
  const candidateStat = await stat(candidatePath).catch(() => null);
  return candidateStat?.isFile() ? dirname(candidatePath) : candidatePath;
}

function shouldIgnoreDirectory(name: string): boolean {
  return name.startsWith(".") || IGNORED_DIRECTORIES.has(name);
}

function uniqueProjectId(value: string, usedIds: Set<string>): string {
  const baseId = createProjectSlug(value);
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function toRelativeManifestPath(rootPath: string, projectPath: string): string {
  const value = relative(rootPath, projectPath) || ".";
  return value.startsWith(".") ? value : `./${value}`;
}

function formatWorkspaceName(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
