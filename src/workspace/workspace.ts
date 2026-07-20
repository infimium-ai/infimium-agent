import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const WORKSPACE_FILE_NAME = "infimium.workspace.json";

export type WorkspaceProject = {
  id: string;
  path: string;
  role: string | null;
  dependsOn: string[];
};

export type InfimiumWorkspace = {
  schemaVersion: 1;
  workspaceId: string;
  name: string;
  manifestPath: string;
  rootPath: string;
  projects: WorkspaceProject[];
};

type WorkspaceProjectInput = {
  id: string;
  path: string;
  role?: string;
  dependsOn?: string[];
};

export function findWorkspaceManifest(startPath: string): string | null {
  const configuredPath = process.env.INFIMIUM_WORKSPACE_FILE?.trim();
  if (configuredPath) {
    const resolvedPath = resolve(configuredPath);
    return existsSync(resolvedPath) ? resolvedPath : null;
  }

  let currentPath = resolve(startPath);
  if (existsSync(currentPath) && !statSync(currentPath).isDirectory()) {
    currentPath = dirname(currentPath);
  }

  while (true) {
    const candidate = resolve(currentPath, WORKSPACE_FILE_NAME);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    currentPath = parentPath;
  }
}

export function loadWorkspace(manifestPath: string): InfimiumWorkspace {
  const resolvedManifestPath = resolve(manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedManifestPath, "utf8")) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${WORKSPACE_FILE_NAME}: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid ${WORKSPACE_FILE_NAME}: expected a JSON object`);
  }

  const schemaVersion = parsed.schemaVersion ?? 1;
  if (schemaVersion !== 1) {
    throw new Error(`Invalid ${WORKSPACE_FILE_NAME}: schemaVersion must be 1`);
  }

  const name = readRequiredString(parsed.name, "name");
  if (!Array.isArray(parsed.projects) || parsed.projects.length === 0) {
    throw new Error(`Invalid ${WORKSPACE_FILE_NAME}: projects must contain at least one project`);
  }

  const rootPath = dirname(resolvedManifestPath);
  const projects = parsed.projects.map((value, index) =>
    parseProject(value, index, rootPath)
  );
  validateProjectRelationships(projects);

  return {
    schemaVersion: 1,
    workspaceId: createWorkspaceId(resolvedManifestPath),
    name,
    manifestPath: resolvedManifestPath,
    rootPath,
    projects
  };
}

export function loadWorkspaceForProject(projectPath: string): InfimiumWorkspace | null {
  const manifestPath = findWorkspaceManifest(projectPath);
  if (!manifestPath) {
    return null;
  }

  const workspace = loadWorkspace(manifestPath);
  return findWorkspaceProject(workspace, projectPath) ? workspace : null;
}

export function findWorkspaceProject(
  workspace: InfimiumWorkspace,
  projectPath: string
): WorkspaceProject | null {
  const resolvedProjectPath = resolve(projectPath);
  return [...workspace.projects]
    .sort((a, b) => b.path.length - a.path.length)
    .find((project) => isPathWithin(resolvedProjectPath, project.path)) ?? null;
}

export function createWorkspaceId(manifestPath: string): string {
  return createHash("sha256").update(resolve(manifestPath)).digest("hex").slice(0, 12);
}

export function createProjectSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

export function isPathWithin(filePath: string, rootPath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(filePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function parseProject(value: unknown, index: number, rootPath: string): WorkspaceProject {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${WORKSPACE_FILE_NAME}: projects[${index}] must be an object`);
  }

  const input: WorkspaceProjectInput = {
    id: readRequiredString(value.id, `projects[${index}].id`),
    path: readRequiredString(value.path, `projects[${index}].path`),
    role: readOptionalString(value.role, `projects[${index}].role`) ?? undefined,
    dependsOn: readStringArray(value.dependsOn, `projects[${index}].dependsOn`)
  };
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(input.id)) {
    throw new Error(
      `Invalid ${WORKSPACE_FILE_NAME}: projects[${index}].id must use letters, numbers, _ or -`
    );
  }

  const projectPath = resolve(rootPath, input.path);
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new Error(
      `Invalid ${WORKSPACE_FILE_NAME}: project path does not exist: ${projectPath}`
    );
  }

  return {
    id: input.id,
    path: projectPath,
    role: input.role?.trim() || null,
    dependsOn: input.dependsOn ?? []
  };
}

function validateProjectRelationships(projects: WorkspaceProject[]): void {
  const ids = new Set<string>();
  for (const project of projects) {
    if (ids.has(project.id)) {
      throw new Error(`Invalid ${WORKSPACE_FILE_NAME}: duplicate project id ${project.id}`);
    }
    ids.add(project.id);
  }

  for (const project of projects) {
    for (const targetId of project.dependsOn) {
      if (targetId === project.id) {
        throw new Error(
          `Invalid ${WORKSPACE_FILE_NAME}: project ${project.id} cannot depend on itself`
        );
      }
      if (!ids.has(targetId)) {
        throw new Error(
          `Invalid ${WORKSPACE_FILE_NAME}: project ${project.id} depends on unknown project ${targetId}`
        );
      }
    }
  }

  for (let leftIndex = 0; leftIndex < projects.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < projects.length; rightIndex += 1) {
      const left = projects[leftIndex];
      const right = projects[rightIndex];
      if (isPathWithin(left.path, right.path) || isPathWithin(right.path, left.path)) {
        throw new Error(
          `Invalid ${WORKSPACE_FILE_NAME}: project roots overlap (${left.id}, ${right.id})`
        );
      }
    }
  }
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${WORKSPACE_FILE_NAME}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return readRequiredString(value, field);
}

function readStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`Invalid ${WORKSPACE_FILE_NAME}: ${field} must be an array of strings`);
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
