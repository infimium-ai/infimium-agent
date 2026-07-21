import { stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { glob } from "glob";

import { readInfimiumStatus } from "../cli/status-cmd.js";
import { dataPath } from "../paths.js";
import {
  ProjectMemoryStore,
  type ProjectMemoryEvent,
  type ProjectState
} from "./project-memory.js";

const DEFAULT_CONTEXT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_CONTEXT_LIMIT = 8;
const DEFAULT_RECENT_FILE_LIMIT = 25;

export type ContextLayerSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  projectPath: string;
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
    changedFiles: Array<{
      path: string;
      status: string;
    }>;
  };
  recentlyTouchedFiles: Array<{
    path: string;
    modifiedAt: string;
    withinWindow: boolean;
  }>;
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
    this.filePath = resolve(
      options.filePath ??
        process.env.INFIMIUM_CONTEXT_FILE?.trim() ??
        dataPath("context/layer.md")
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
    const snapshotJson = JSON.stringify(snapshot, null, 2);

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${snapshotJson}\n`, "utf8");

    this.memoryStore.saveContextSnapshot({
      projectPath: this.projectPath,
      filePath: this.filePath,
      snapshotJson,
      updatedAt: Date.now(),
      activateProject: this.activateProject
    });

    return snapshot;
  }

  async getContext(refresh: boolean = true): Promise<string> {
    if (refresh) {
      return `${JSON.stringify(await this.refresh(), null, 2)}\n`;
    }

    const cached = this.memoryStore.getLatestContextSnapshot(this.projectPath);
    if (cached) {
      return `${cached.snapshotJson}\n`;
    }

    return `${JSON.stringify(await this.refresh(), null, 2)}\n`;
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
    const [index, workingTree, recentlyTouchedFiles] = await Promise.all([
      readIndexSummary(),
      Promise.resolve(readGitWorkingTree(this.projectPath)),
      readRecentlyTouchedFiles(this.projectPath, now - this.activityWindowMs, this.recentFileLimit)
    ]);

    return {
      schemaVersion: 1,
      generatedAt: new Date(now).toISOString(),
      projectPath: this.projectPath,
      contextFilePath: this.filePath,
      currentTask: resumeContext.state.currentTask,
      lastNote: lastNonIndexNote ?? resumeContext.state.lastNote,
      lastPlanPath: resumeContext.state.lastPlanPath,
      index,
      recentMemory: recentMemory
        .slice(0, this.limit)
        .map(formatMemoryEvent),
      workingTree,
      recentlyTouchedFiles,
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
} = {}): Promise<string> {
  const writer = new ContextLayerWriter(options);
  try {
    return await writer.getContext(options.refresh ?? true);
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

async function readIndexSummary(): Promise<ContextLayerSnapshot["index"]> {
  const status = await readInfimiumStatus().catch(() => null);
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

function readGitWorkingTree(projectPath: string): ContextLayerSnapshot["workingTree"] {
  const result = spawnSync("git", ["status", "--short"], {
    cwd: projectPath,
    encoding: "utf8",
    timeout: 2_000
  });

  if (result.status !== 0) {
    return {
      isGitRepo: false,
      dirty: false,
      changedFiles: []
    };
  }

  const changedFiles = result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 50)
    .map((line) => ({
      status: line.slice(0, 2).trim() || "?",
      path: line.slice(3).trim()
    }));

  return {
    isGitRepo: true,
    dirty: changedFiles.length > 0,
    changedFiles
  };
}

async function readRecentlyTouchedFiles(
  projectPath: string,
  sinceMs: number,
  limit: number
): Promise<ContextLayerSnapshot["recentlyTouchedFiles"]> {
  const paths = await glob("**/*", {
    cwd: projectPath,
    absolute: true,
    nodir: true,
    ignore: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/chroma_db/**",
      "**/*.db",
      "**/.env",
      "**/.env.*",
      "**/context/layer.md"
    ]
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
    .sort((a, b) => b.modifiedMs - a.modifiedMs);
  const withinWindow = existingFiles.filter((file) => file.modifiedMs >= sinceMs);
  const selectedFiles = withinWindow.length > 0 ? withinWindow : existingFiles;

  return selectedFiles
    .slice(0, limit)
    .map(({ path, modifiedAt, modifiedMs }) => ({
      path,
      modifiedAt,
      withinWindow: modifiedMs >= sinceMs
    }));
}

function displayPath(filePath: string, projectPath: string): string {
  const relativePath = relative(projectPath, filePath);
  return relativePath && !relativePath.startsWith("..") ? relativePath : filePath;
}
