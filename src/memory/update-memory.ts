import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { ContextLayerWriter } from "./context-layer.js";
import { ProjectMemoryStore } from "./project-memory.js";
import { createProjectId } from "./project-overview.js";
import { createProjectFilePolicy } from "../indexer/project-files.js";

export type MemoryUpdateInput = {
  projectPath: string;
  note?: string;
  task?: string;
  handoff?: string;
  files?: string[];
  source?: "manual" | "automatic";
};

export async function updateMemory(input: MemoryUpdateInput, existingStore?: ProjectMemoryStore) {
  const projectPath = resolve(input.projectPath);
  if (!(await stat(projectPath)).isDirectory()) throw new Error("Project path must be a directory");
  for (const value of [input.note, input.task, input.handoff]) {
    if (value !== undefined && (!value.trim() || value.length > 2000)) {
      throw new Error("Memory text must contain 1 to 2000 characters");
    }
  }
  if ((input.files?.length ?? 0) > 10) throw new Error("At most 10 file references are allowed");
  const policy = await createProjectFilePolicy(projectPath);
  const canonicalProject = await realpath(projectPath);
  const files: string[] = [];
  for (const file of input.files ?? []) {
    const absolute = resolve(projectPath, file);
    const canonical = await realpath(absolute).catch(() => absolute);
    const within = relative(canonicalProject, canonical);
    if (isAbsolute(within) || within === ".." || within.startsWith("../") || policy.isIgnored(absolute)) {
      throw new Error("File references must be non-excluded files inside the selected project");
    }
    files.push(relative(projectPath, absolute));
  }
  const store = existingStore ?? new ProjectMemoryStore();
  const writer = new ContextLayerWriter({
    projectPath, memoryStore: store, activateProject: false,
    filePath: resolve(dirname(store.getDatabasePath()), "context", createProjectId(projectPath), "layer.md")
  });
  try {
    if (input.note || input.task) {
      store.remember({ projectPath, summary: input.note?.trim() ?? input.task!.trim(),
        currentTask: input.task?.trim(), eventType: "progress" });
    }
    const snapshot = await writer.refresh();
    const previous = store.getMemoryCheckpoints(projectPath, 1)[0];
    const task = snapshot.activeExecution.currentTask;
    const handoff = input.handoff?.trim() ?? (previous?.task === task ? previous.handoff : null);
    const observedFiles = [...new Set([
      ...files,
      ...snapshot.dynamicState.workingTree.changedFiles.map((file) => file.path),
      ...snapshot.dynamicState.recentActivity.files.map((file) => file.path)
    ])].slice(0, 10);
    // File metadata detects successive edits even when Git continues to report "M".
    const fileStates = await Promise.all(observedFiles.map(async (file) => {
      const info = await stat(resolve(projectPath, file)).catch(() => null);
      return [file, info?.mtimeMs ?? null, info?.size ?? null];
    }));
    const summary = input.note?.trim() ??
      `Observed workspace state: ${snapshot.dynamicState.workingTree.summary}. ` +
      (snapshot.activeExecution.lastNote ? `Last recorded progress: ${snapshot.activeExecution.lastNote}` : "No progress note recorded.");
    const fingerprint = createHash("sha256").update(JSON.stringify({
      task, handoff, fileStates, workingTree: snapshot.dynamicState.workingTree,
      lastNote: snapshot.activeExecution.lastNote, ledger: snapshot.activeExecution.semanticLedger,
      milestones: snapshot.activeExecution.recentMilestones
    })).digest("hex");
    const checkpoint = store.saveMemoryCheckpoint({
      projectPath, summary: summary.slice(0, 2000), task, handoff, files: observedFiles,
      fingerprint, source: input.source ?? "manual", createdAt: Date.now()
    });
    await writer.saveSnapshot(snapshot);
    return { projectPath, updated: checkpoint !== null, checkpoint,
      contextFile: snapshot.dynamicState.contextFilePath };
  } finally {
    writer.close();
    if (!existingStore) store.close();
  }
}

export function startMemoryUpdateWorker(options: {
  store?: ProjectMemoryStore;
  projectPath?: string;
  pollMs?: number;
  onError?: (message: string) => void;
} = {}) {
  const store = options.store ?? new ProjectMemoryStore();
  let stopped = false;
  let pending: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      for (const setting of store.getMemoryUpdateSettings()) {
        if (stopped || !setting.enabled || (options.projectPath && setting.projectPath !== resolve(options.projectPath))) continue;
        if (!store.claimMemoryUpdate(setting.projectPath, Date.now())) continue;
        try {
          await updateMemory({ projectPath: setting.projectPath, source: "automatic" }, store);
          store.setMemoryUpdateError(setting.projectPath, null);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          store.setMemoryUpdateError(setting.projectPath, message);
          options.onError?.(`Memory update failed for ${setting.projectPath}: ${message}`);
        }
      }
    })().finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(() => { void tick().catch((error) => options.onError?.(String(error))); }, options.pollMs ?? 1000);
  timer.unref();
  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
      if (!options.store) store.close();
    }
  };
}
