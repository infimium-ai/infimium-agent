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

const DEFAULT_CONTEXT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_CONTEXT_LIMIT = 8;
const DEFAULT_RECENT_FILE_LIMIT = 10;
const DEFAULT_CHANGED_FILE_LIMIT = 10;

export type ContextOutputFormat = "yaml" | "json";

export type ContextLayerSnapshot = {
  schemaVersion: 2;
  generatedAt: string;
  project: ProjectOverview;
  contextFilePath: string;
  currentTask: string | null;
  lastNote: string | null;
  lastPlanPath: string | null;
  index: {
    docsFiles: number;
    docsChunks: number;
    codeSymbols: number;
    codeFiles: number;
    depGraphRelationships: number;
    watchedProjects: number;
    lastIndexedAt: string | null;
  } | null;
  recentMemory: Array<{
    type: ProjectMemoryEvent["eventType"];
    summary: string;
    details: string | null;
    createdAt: string | null;
  }>;
  workingTree: {
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
  recentActivity: {
    withinWindow: boolean;
    totalFiles: number;
    omittedFiles: number;
    summary: string;
    files: Array<{
      path: string;
      modifiedAt: string;
    }>;
  };
  agentHandoff: {
    instruction: string;
    preferredTools: string[];
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
      projectId: snapshot.project.projectId,
      projectPath: this.projectPath,
      overviewJson: JSON.stringify(snapshot.project),
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
    const recentMemory = compactMemoryEvents(resumeContext.recentEvents);
    const lastNonIndexNote =
      recentMemory.find((event) => event.eventType !== "index")?.summary ?? null;
    const [project, index, workingTree, recentActivity] = await Promise.all([
      readProjectOverview(this.projectPath),
      readIndexSummary(this.projectPath),
      readGitWorkingTree(this.projectPath),
      readRecentlyTouchedFiles(this.projectPath, now - this.activityWindowMs, this.recentFileLimit)
    ]);

    return {
      schemaVersion: 2,
      generatedAt: new Date(now).toISOString(),
      project,
      contextFilePath: this.filePath,
      currentTask: resumeContext.state.currentTask,
      lastNote: lastNonIndexNote ?? resumeContext.state.lastNote,
      lastPlanPath: resumeContext.state.lastPlanPath,
      index,
      recentMemory: recentMemory
        .slice(0, this.limit)
        .map(formatMemoryEvent),
      workingTree,
      recentActivity,
      agentHandoff: {
        instruction:
          "Read this context first, then use semantic_code_search, dep_graph, query_local_docs, and project_memory before editing.",
        preferredTools: [
          "get_context",
          "project_memory",
          "semantic_code_search",
          "dep_graph",
          "query_local_docs",
          "plan"
        ]
      }
    };
  }
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

function formatMemoryEvent(event: ProjectMemoryEvent): ContextLayerSnapshot["recentMemory"][number] {
  return {
    type: event.eventType,
    summary: event.summary,
    details: event.details,
    createdAt: event.createdAt ? new Date(event.createdAt).toISOString() : null
  };
}

function compactMemoryEvents(events: ProjectMemoryEvent[]): ProjectMemoryEvent[] {
  const latestIndexEvent = events.find((event) => event.eventType === "index");
  const nonIndexEvents = events.filter((event) => event.eventType !== "index");

  return latestIndexEvent ? [...nonIndexEvents, latestIndexEvent] : nonIndexEvents;
}

async function readIndexSummary(projectPath: string): Promise<ContextLayerSnapshot["index"]> {
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

async function readGitWorkingTree(
  projectPath: string
): Promise<ContextLayerSnapshot["workingTree"]> {
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
): Promise<ContextLayerSnapshot["recentActivity"]> {
  const policy = await createProjectFilePolicy(projectPath);
  const paths = await glob("**/*", {
    cwd: projectPath,
    absolute: true,
    nodir: true,
    ignore: policy.globIgnorePatterns
  }).catch(() => []);

  const touched = await Promise.all(
    paths.map(async (filePath) => {
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat) {
        return null;
      }

      return {
        path: displayPath(filePath, projectPath),
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
  snapshot: ContextLayerSnapshot,
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

function parseCachedSnapshot(value: string): ContextLayerSnapshot | null {
  try {
    const parsed = parseYaml(value) as unknown;
    return isContextLayerSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isContextLayerSnapshot(value: unknown): value is ContextLayerSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    "project" in value
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
