import { stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { glob } from "glob";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { readInfimiumStatus } from "../cli/status-cmd.js";
import { createProjectFilePolicy } from "../indexer/project-files.js";
import { dataPath } from "../paths.js";
import {
  ProjectMemoryStore,
  type ProjectMemoryEvent,
  type ProjectState
} from "./project-memory.js";
import {
  createProjectId,
  readProjectOverview,
  type ProjectOverview
} from "./project-overview.js";
import {
  findWorkspaceProject,
  loadWorkspaceForProject
} from "../workspace/workspace.js";
import {
  WorkspaceGraphStore,
  type WorkspaceGraphRelationship
} from "../workspace/workspace-graph.js";

const DEFAULT_CONTEXT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_CONTEXT_LIMIT = 8;
const DEFAULT_RECENT_FILE_LIMIT = 5;
const DEFAULT_CHANGED_FILE_LIMIT = 10;

export type ContextOutputFormat = "yaml" | "json";

type IndexSummary = {
  docsFiles: number;
  docsChunks: number;
  codeSymbols: number;
  codeFiles: number;
  depGraphRelationships: number;
  watchedProjects: number;
  lastIndexedAt: string | null;
};

type StaticProjectOverview = Omit<ProjectOverview, "generatedAt">;

type WorkspaceSummary = {
    workspaceId: string;
    name: string;
    manifestPath: string;
    currentProjectId: string;
    totalProjects: number;
    omittedProjects: number;
    projects: Array<{
      id: string;
      name: string;
      path: string;
      role: string | null;
      current: boolean;
      dependsOn: string[];
      summary: string;
    }>;
    relationships: WorkspaceGraphRelationship[];
  };

type WorkingTreeSummary = {
    isGitRepo: boolean;
    dirty: boolean;
    totalChangedFiles: number;
    omittedFiles: number;
    summary: string;
    changedFiles: Array<{
      path: string;
      status: string;
    }>;
  };

type RecentActivitySummary = {
    withinWindow: boolean;
    totalFiles: number;
    omittedFiles: number;
    summary: string;
    files: Array<{
      path: string;
      modifiedAt: string;
    }>;
  };

export type ContextLayerSnapshot = {
  schemaVersion: 4;
  staticAnchors: {
    project: StaticProjectOverview;
    codebase: {
      shape: string;
      importantAreas: string[];
      usefulCommands: string[];
    };
    workspace: WorkspaceSummary | null;
    retrieval: {
      strategy: "AST-first";
      searchTool: "semantic_code_search";
      expansionTool: "expand_symbol";
      guidance: string;
    };
  };
  dynamicState: {
    generatedAt: string;
    contextFilePath: string;
    workingTree: WorkingTreeSummary;
    recentActivity: RecentActivitySummary;
    indexHealth: (IndexSummary & { status: "fresh" | "stale" | "missing" }) | null;
  };
  activeExecution: {
    currentTask: string | null;
    lastNote: string | null;
    lastPlanPath: string | null;
    semanticLedger: Array<{
      category: string;
      key: string;
      value: string;
    }>;
    recentMilestones: Array<{
      milestone: string;
      summary: string;
      completedAt: string;
    }>;
    activeScratchpad: Array<{
      type: ProjectMemoryEvent["eventType"];
      summary: string;
      createdAt: string;
    }>;
    agentHandoff: {
      instruction: string;
      preferredTools: string[];
    };
  };
};

export type ContextLayerOptions = {
  projectPath?: string;
  filePath?: string;
  intervalMs?: number;
  limit?: number;
  recentFileLimit?: number;
  activityWindowMs?: number;
  activateProject?: boolean;
  memoryStore?: ProjectMemoryStore;
};

export type ContextLayerHandle = {
  refresh(): Promise<ContextLayerSnapshot>;
  stop(): void;
};

export class ContextLayerWriter {
  private readonly projectPath: string;
  private readonly filePath: string;
  private readonly limit: number;
  private readonly recentFileLimit: number;
  private readonly activityWindowMs: number;
  private readonly activateProject: boolean;
  private readonly ownsStore: boolean;
  private readonly memoryStore: ProjectMemoryStore;

  constructor(options: ContextLayerOptions = {}) {
    this.projectPath = resolve(options.projectPath ?? process.cwd());
    const projectId = createProjectId(this.projectPath);
    this.filePath = resolve(
      options.filePath ??
        (process.env.INFIMIUM_CONTEXT_FILE?.trim() || undefined) ??
        dataPath(`context/${projectId}/layer.md`)
    );
    this.limit = options.limit ?? DEFAULT_CONTEXT_LIMIT;
    this.recentFileLimit = options.recentFileLimit ?? DEFAULT_RECENT_FILE_LIMIT;
    this.activityWindowMs = options.activityWindowMs ?? DEFAULT_CONTEXT_INTERVAL_MS;
    this.activateProject = options.activateProject ?? true;
    this.memoryStore = options.memoryStore ?? new ProjectMemoryStore();
    this.ownsStore = options.memoryStore === undefined;
  }

  async refresh(): Promise<ContextLayerSnapshot> {
    const snapshot = await this.buildSnapshot();
    const snapshotText = serializeSnapshot(snapshot, "yaml");

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, snapshotText, "utf8");

    this.memoryStore.saveContextSnapshot({
      projectPath: this.projectPath,
      filePath: this.filePath,
      snapshotText,
      format: "yaml",
      updatedAt: Date.now(),
      activateProject: this.activateProject
    });
    this.memoryStore.saveProjectOverview({
      projectId: snapshot.staticAnchors.project.projectId,
      projectPath: this.projectPath,
      overviewJson: JSON.stringify({
        ...snapshot.staticAnchors.project,
        generatedAt: snapshot.dynamicState.generatedAt
      }),
      updatedAt: Date.now()
    });

    return snapshot;
  }

  async getContext(
    refresh: boolean = true,
    format: ContextOutputFormat = "yaml"
  ): Promise<string> {
    if (refresh) {
      return serializeSnapshot(await this.refresh(), format);
    }

    const cached = this.memoryStore.getLatestContextSnapshot(this.projectPath);
    if (cached) {
      const snapshot = parseCachedSnapshot(cached.snapshotText);
      if (snapshot) {
        return serializeSnapshot(snapshot, format);
      }
    }

    return serializeSnapshot(await this.refresh(), format);
  }

  close(): void {
    if (this.ownsStore) {
      this.memoryStore.close();
    }
  }

  private async buildSnapshot(): Promise<ContextLayerSnapshot> {
    const now = Date.now();
    const resumeContext = this.memoryStore.getResumeContext(
      this.projectPath,
      Math.min(50, Math.max(this.limit * 5, this.limit))
    );
    const [project, workspace, index, workingTree, recentActivity] = await Promise.all([
      readProjectOverview(this.projectPath),
      readWorkspaceSummary(this.projectPath, this.memoryStore),
      readIndexSummary(this.projectPath),
      readGitWorkingTree(this.projectPath),
      readRecentlyTouchedFiles(this.projectPath, now - this.activityWindowMs, this.recentFileLimit)
    ]);

    const indexHealth = buildIndexHealth(index, recentActivity);
    const { generatedAt: _overviewGeneratedAt, ...staticProject } = project;
    return {
      schemaVersion: 4,
      staticAnchors: {
        project: staticProject,
        codebase: buildCodebaseContext(project, workspace),
        workspace,
        retrieval: {
          strategy: "AST-first",
          searchTool: "semantic_code_search",
          expansionTool: "expand_symbol",
          guidance:
            "Start from compact symbol skeletons. Expand only the exact implementation needed for the task."
        }
      },
      dynamicState: {
        generatedAt: new Date(now).toISOString(),
        contextFilePath: this.filePath,
        workingTree,
        recentActivity,
        indexHealth
      },
      activeExecution: {
        currentTask: resumeContext.state.currentTask,
        lastNote: resumeContext.state.lastNote,
        lastPlanPath: resumeContext.state.lastPlanPath,
        semanticLedger: resumeContext.semanticLedger.map((entry) => ({
          category: entry.category,
          key: entry.key,
          value: entry.value
        })),
        recentMilestones: resumeContext.recentArchives.map((entry) => ({
          milestone: entry.milestone,
          summary: entry.summary,
          completedAt: new Date(entry.completedAt).toISOString()
        })),
        activeScratchpad: resumeContext.activeScratchpad.slice(-5).map((event) => ({
          type: event.eventType,
          summary: event.summary,
          createdAt: new Date(event.createdAt).toISOString()
        })),
        agentHandoff: buildAgentHandoff(
          resumeContext.state.currentTask,
          recentActivity,
          indexHealth?.status ?? "missing"
        )
      }
    };
  }
}

function buildCodebaseContext(
  project: ProjectOverview,
  workspace: WorkspaceSummary | null
): ContextLayerSnapshot["staticAnchors"]["codebase"] {
  const stack = project.frameworks.length > 0
    ? project.frameworks
    : project.languages.map((language) => language.name);
  const workspaceText = workspace
    ? ` It is part of workspace "${workspace.name}" with ${workspace.totalProjects} project(s).`
    : "";

  return {
    shape:
      `${project.name} is a ${project.kind} codebase` +
      (stack.length > 0 ? ` using ${stack.join(", ")}` : "") +
      `.${workspaceText}`,
    importantAreas: project.modules.slice(0, 10),
    usefulCommands: project.commands.slice(0, 8)
  };
}

function buildIndexHealth(
  index: IndexSummary | null,
  recentActivity: RecentActivitySummary
): ContextLayerSnapshot["dynamicState"]["indexHealth"] {
  if (!index) return null;
  if (index.codeFiles === 0 && index.docsFiles === 0) {
    return { ...index, status: "missing" };
  }
  const indexedAt = index.lastIndexedAt ? Date.parse(index.lastIndexedAt) : 0;
  const changedAfterIndex = recentActivity.files.some(
    (file) => Date.parse(file.modifiedAt) > indexedAt
  );
  return {
    ...index,
    status: !indexedAt || changedAfterIndex ? "stale" : "fresh"
  };
}

function buildAgentHandoff(
  currentTask: string | null,
  recentActivity: RecentActivitySummary,
  indexStatus: "fresh" | "stale" | "missing"
): ContextLayerSnapshot["activeExecution"]["agentHandoff"] {
  const activeFiles = recentActivity.files.slice(0, 3).map((file) => file.path);
  const task = currentTask ? `Continue the active task: ${currentTask}.` : "Confirm the next task before editing.";
  const files = activeFiles.length > 0
    ? ` Inspect ${activeFiles.join(", ")} first because they changed most recently.`
    : "";
  const index = indexStatus === "fresh"
    ? " Use semantic_code_search before expanding implementation details."
    : " Run infimium index before relying on semantic retrieval.";
  return {
    instruction: `${task}${files}${index}`,
    preferredTools: [
      "get_context",
      "project_memory",
      "semantic_code_search",
      "dep_graph",
      "query_local_docs",
      "expand_symbol",
      "plan"
    ]
  };
}

export function startContextLayerAutoWriter(
  options: ContextLayerOptions = {}
): ContextLayerHandle {
  const writer = new ContextLayerWriter(options);
  let stopped = false;

  const refresh = async (): Promise<ContextLayerSnapshot> => {
    try {
      return await writer.refresh();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Infimium context layer refresh failed: ${message}`);
      throw error;
    }
  };

  void refresh().catch(() => undefined);

  const interval = setInterval(() => {
    if (!stopped) {
      void refresh().catch(() => undefined);
    }
  }, options.intervalMs ?? DEFAULT_CONTEXT_INTERVAL_MS);
  interval.unref?.();

  return {
    refresh,
    stop(): void {
      stopped = true;
      clearInterval(interval);
      writer.close();
    }
  };
}

export async function readContextLayer(options: ContextLayerOptions & {
  refresh?: boolean;
  format?: ContextOutputFormat;
} = {}): Promise<string> {
  const writer = new ContextLayerWriter(options);
  try {
    return await writer.getContext(options.refresh ?? true, options.format ?? "yaml");
  } finally {
    writer.close();
  }
}

async function readIndexSummary(projectPath: string): Promise<IndexSummary | null> {
  const status = await readInfimiumStatus({ projectPath }).catch(() => null);
  if (!status) {
    return null;
  }

  return {
    docsFiles: status.docsFiles,
    docsChunks: status.docsChunks,
    codeSymbols: status.codeSymbols,
    codeFiles: status.codeFiles,
    depGraphRelationships: status.importRelationships,
    watchedProjects: status.watchedProjects,
    lastIndexedAt: status.lastIndexedAt
      ? new Date(status.lastIndexedAt).toISOString()
      : null
  };
}

async function readWorkspaceSummary(
  projectPath: string,
  memoryStore: ProjectMemoryStore
): Promise<WorkspaceSummary | null> {
  const workspace = loadWorkspaceForProject(projectPath);
  if (!workspace) {
    return null;
  }

  const currentProject = findWorkspaceProject(workspace, projectPath);
  if (!currentProject) {
    return null;
  }

  const graphStore = new WorkspaceGraphStore(memoryStore.getDatabasePath(), {
    initialize: false
  });
  let relationships: WorkspaceGraphRelationship[];
  try {
    relationships = graphStore.get(workspace.workspaceId).relationships;
  } finally {
    graphStore.close();
  }
  if (relationships.length === 0) {
    relationships = workspace.projects.flatMap((project) =>
      project.dependsOn.map((targetProjectId) => ({
        sourceProjectId: project.id,
        targetProjectId,
        type: "depends_on" as const,
        weight: 1
      }))
    );
  }

  const orderedProjects = [...workspace.projects].sort((left, right) => {
    if (left.id === currentProject.id) return -1;
    if (right.id === currentProject.id) return 1;
    return left.id.localeCompare(right.id);
  });
  const selectedProjects = orderedProjects.slice(0, 12);
  const projects = await Promise.all(
    selectedProjects.map(async (workspaceProject) => {
      const overview = await readStoredOrFreshOverview(memoryStore, workspaceProject.path);
      return {
        id: workspaceProject.id,
        name: overview.name,
        path: workspaceProject.path,
        role: workspaceProject.role,
        current: workspaceProject.id === currentProject.id,
        dependsOn: workspaceProject.dependsOn,
        summary: overview.summary
      };
    })
  );
  const selectedIds = new Set(projects.map((project) => project.id));

  return {
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    manifestPath: workspace.manifestPath,
    currentProjectId: currentProject.id,
    totalProjects: workspace.projects.length,
    omittedProjects: Math.max(0, workspace.projects.length - projects.length),
    projects,
    relationships: relationships.filter(
      (relationship) =>
        selectedIds.has(relationship.sourceProjectId) &&
        selectedIds.has(relationship.targetProjectId)
    )
  };
}

async function readStoredOrFreshOverview(
  memoryStore: ProjectMemoryStore,
  projectPath: string
): Promise<ProjectOverview> {
  const stored = memoryStore.getProjectOverview(projectPath);
  if (stored) {
    try {
      const parsed = JSON.parse(stored.overviewJson) as unknown;
      if (isProjectOverview(parsed, projectPath)) {
        return parsed;
      }
    } catch {
      // Regenerate invalid or outdated cached overviews.
    }
  }
  return readProjectOverview(projectPath);
}

async function readGitWorkingTree(
  projectPath: string
): Promise<WorkingTreeSummary> {
  const result = spawnSync("git", ["status", "--short", "--untracked-files=all"], {
    cwd: projectPath,
    encoding: "utf8",
    timeout: 2_000
  });

  if (result.status !== 0) {
    return {
      isGitRepo: false,
      dirty: false,
      totalChangedFiles: 0,
      omittedFiles: 0,
      summary: "Not a Git repository.",
      changedFiles: []
    };
  }

  const policy = await createProjectFilePolicy(projectPath);
  const allChangedFiles = result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2).trim() || "?",
      path: line.slice(3).trim()
    }))
    .filter((file) => !policy.isIgnored(resolve(projectPath, normalizeGitPath(file.path))))
    .sort(compareChangedFiles);
  const changedFiles = allChangedFiles.slice(0, DEFAULT_CHANGED_FILE_LIMIT);
  const omittedFiles = Math.max(0, allChangedFiles.length - changedFiles.length);

  return {
    isGitRepo: true,
    dirty: allChangedFiles.length > 0,
    totalChangedFiles: allChangedFiles.length,
    omittedFiles,
    summary: summarizePaths(allChangedFiles.map((file) => file.path), "changed"),
    changedFiles
  };
}

async function readRecentlyTouchedFiles(
  projectPath: string,
  sinceMs: number,
  limit: number
): Promise<RecentActivitySummary> {
  const policy = await createProjectFilePolicy(projectPath);
  const paths = await glob("**/*", {
    cwd: policy.rootPath,
    absolute: true,
    nodir: true,
    follow: true,
    ignore: policy.globIgnorePatterns
  }).catch(() => []);

  const touched = await Promise.all(
    paths.map(async (filePath) => {
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat) {
        return null;
      }

      return {
        path: displayPath(filePath, policy.rootPath),
        modifiedAt: new Date(fileStat.mtimeMs).toISOString(),
        modifiedMs: fileStat.mtimeMs
      };
    })
  );

  const existingFiles = touched
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .filter((item) => !policy.isIgnored(resolve(projectPath, item.path)))
    .sort(
      (a, b) =>
        pathPriority(a.path) - pathPriority(b.path) ||
        b.modifiedMs - a.modifiedMs
    );
  const withinWindow = existingFiles.filter((file) => file.modifiedMs >= sinceMs);
  const selectedFiles = withinWindow.length > 0 ? withinWindow : existingFiles;
  const files = selectedFiles
    .slice(0, limit)
    .map(({ path, modifiedAt }) => ({ path, modifiedAt }));

  return {
    withinWindow: withinWindow.length > 0,
    totalFiles: selectedFiles.length,
    omittedFiles: Math.max(0, selectedFiles.length - files.length),
    summary:
      withinWindow.length > 0
        ? summarizePaths(selectedFiles.map((file) => file.path), "recently touched")
        : `No files changed in the activity window; showing the latest ${files.length} relevant files.`,
    files
  };
}

function displayPath(filePath: string, projectPath: string): string {
  const relativePath = relative(projectPath, filePath);
  return relativePath && !relativePath.startsWith("..") ? relativePath : filePath;
}

function serializeSnapshot(
  snapshot: unknown,
  format: ContextOutputFormat
): string {
  if (format === "json") {
    return `${JSON.stringify(snapshot, null, 2)}\n`;
  }
  return stringifyYaml(snapshot, {
    lineWidth: 0,
    indent: 2
  });
}

function parseCachedSnapshot(value: string): unknown | null {
  try {
    const parsed = parseYaml(value) as unknown;
    return isRecognizedContextSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecognizedContextSnapshot(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    (value.schemaVersion === 3 || value.schemaVersion === 4)
  );
}


function isProjectOverview(value: unknown, projectPath: string): value is ProjectOverview {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    value.path === resolve(projectPath) &&
    "projectId" in value &&
    typeof value.projectId === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "summary" in value &&
    typeof value.summary === "string"
  );
}

function normalizeGitPath(filePath: string): string {
  const renameTarget = filePath.includes(" -> ")
    ? filePath.slice(filePath.lastIndexOf(" -> ") + 4)
    : filePath;
  return renameTarget.replace(/^"|"$/g, "");
}

function compareChangedFiles(
  left: { path: string; status: string },
  right: { path: string; status: string }
): number {
  return pathPriority(left.path) - pathPriority(right.path) || left.path.localeCompare(right.path);
}

function pathPriority(filePath: string): number {
  if (/^(src|lib|app|api|services|packages|supabase)\//.test(filePath)) return 0;
  if (/\.(ts|tsx|js|jsx|py|dart)$/.test(filePath)) return 1;
  if (/\.(md|json|ya?ml|toml)$/.test(filePath)) return 2;
  return 3;
}

function summarizePaths(paths: string[], label: string): string {
  if (paths.length === 0) {
    return `No ${label} files.`;
  }

  const groups = new Map<string, number>();
  for (const filePath of paths) {
    const group = filePath.includes("/") ? filePath.split("/", 1)[0] : "root";
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  const mainGroups = [...groups.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([group, count]) => `${group} (${count})`)
    .join(", ");
  return `${paths.length} ${label} files; concentrated in ${mainGroups}.`;
}
