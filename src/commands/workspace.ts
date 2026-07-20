import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import {
  WORKSPACE_FILE_NAME,
  createProjectSlug,
  findWorkspaceManifest,
  loadWorkspace
} from "../workspace/workspace.js";
import { WorkspaceGraphStore } from "../workspace/workspace-graph.js";

type WorkspaceManifestOutput = {
  schemaVersion: 1;
  name: string;
  projects: Array<{
    id: string;
    path: string;
    role: string;
    dependsOn: string[];
  }>;
};

export async function runWorkspaceCommand(
  args: string[] = process.argv.slice(3)
): Promise<void> {
  const subcommand = args[0] ?? "show";
  const subArgs = args.slice(1);

  if (subcommand === "init") {
    await initializeWorkspace(subArgs);
    return;
  }
  if (subcommand === "show" || subcommand === "validate") {
    showWorkspace(subArgs);
    return;
  }
  if (subcommand === "graph") {
    showWorkspaceGraph(subArgs);
    return;
  }

  throw new Error("Usage: infimium workspace init [project paths] | show | graph");
}

export function buildWorkspaceManifest(
  rootPath: string,
  projectPaths: string[],
  name: string
): WorkspaceManifestOutput {
  const usedIds = new Set<string>();
  return {
    schemaVersion: 1,
    name,
    projects: projectPaths.map((projectPath) => {
      const absolutePath = resolve(rootPath, projectPath);
      const baseId = createProjectSlug(basename(absolutePath));
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(id);

      const relativePath = relative(rootPath, absolutePath) || ".";
      return {
        id,
        path: relativePath.startsWith(".") ? relativePath : `./${relativePath}`,
        role: "app",
        dependsOn: []
      };
    })
  };
}

async function initializeWorkspace(args: string[]): Promise<void> {
  const parsed = parseInitArgs(args);
  const rootPath = process.cwd();
  const manifestPath = resolve(rootPath, WORKSPACE_FILE_NAME);
  if (existsSync(manifestPath) && !parsed.force) {
    throw new Error(`${WORKSPACE_FILE_NAME} already exists. Use --force to replace it.`);
  }

  const projectPaths = parsed.projectPaths.length > 0 ? parsed.projectPaths : [rootPath];
  for (const projectPath of projectPaths) {
    if (!existsSync(resolve(rootPath, projectPath))) {
      throw new Error(`Project path does not exist: ${resolve(rootPath, projectPath)}`);
    }
  }

  const manifest = buildWorkspaceManifest(rootPath, projectPaths, parsed.name);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Created ${manifestPath}`);
  console.log("Edit role and dependsOn fields, then run: infimium index");
}

function showWorkspace(args: string[]): void {
  const workspace = readWorkspaceFromArgs(args);
  console.log(
    stringifyYaml(
      {
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        manifestPath: workspace.manifestPath,
        projects: workspace.projects
      },
      { lineWidth: 0 }
    ).trimEnd()
  );
}

function showWorkspaceGraph(args: string[]): void {
  const workspace = readWorkspaceFromArgs(args);
  const store = new WorkspaceGraphStore();
  try {
    console.log(stringifyYaml(store.sync(workspace), { lineWidth: 0 }).trimEnd());
  } finally {
    store.close();
  }
}

function readWorkspaceFromArgs(args: string[]) {
  const startPath = args[0] ? resolve(args[0]) : process.cwd();
  const manifestPath = findWorkspaceManifest(startPath);
  if (!manifestPath) {
    throw new Error(`No ${WORKSPACE_FILE_NAME} found. Run: infimium workspace init`);
  }
  return loadWorkspace(manifestPath);
}

function parseInitArgs(args: string[]): {
  name: string;
  projectPaths: string[];
  force: boolean;
} {
  let name = basename(process.cwd());
  let force = false;
  const projectPaths: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--name") {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith("--")) {
        throw new Error("--name requires a value");
      }
      name = value;
      index += 1;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown workspace init argument: ${arg}`);
    }
    projectPaths.push(arg);
  }

  return { name, projectPaths, force };
}
