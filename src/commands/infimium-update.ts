import { stat } from "node:fs/promises";
import { stringify } from "yaml";
import { resolveMemoryProjectPath } from "./memory.js";
import { ProjectMemoryStore } from "../memory/project-memory.js";
import { startMemoryUpdateWorker, updateMemory } from "../memory/update-memory.js";

export type InfimiumUpdateArgs = {
  action?: "refresh" | "start" | "stop" | "status";
  project_path?: string;
  note?: string;
  task?: string;
  handoff?: string;
  files?: string[];
  interval_seconds?: number;
};

export async function runInfimiumUpdateTool(args: InfimiumUpdateArgs): Promise<string> {
  const projectPath = resolveMemoryProjectPath(args.project_path);
  const action = args.action ?? "refresh";
  if (action === "refresh") return stringify(await updateMemory({
    projectPath, note: args.note, task: args.task, handoff: args.handoff, files: args.files
  }));
  if (args.note || args.task || args.handoff || args.files) {
    throw new Error("Use action=refresh to record notes, tasks, handoff, or files");
  }
  const store = new ProjectMemoryStore();
  try {
    const previous = store.getMemoryUpdateSettings().find((entry) => entry.projectPath === projectPath);
    if (action === "start") {
      if (!(await stat(projectPath)).isDirectory()) throw new Error("Project path must be a directory");
      store.configureMemoryUpdates(projectPath, true, (args.interval_seconds ?? 300) * 1000);
    } else if (action === "stop") {
      store.configureMemoryUpdates(projectPath, false, previous?.intervalMs);
    }
    return stringify({
      projectPath,
      automaticUpdates: store.getMemoryUpdateSettings().find((entry) => entry.projectPath === projectPath) ?? { enabled: false },
      latestCheckpoint: store.getMemoryCheckpoints(projectPath, 1)[0] ?? null,
      runtime: "Automatic updates run while an Infimium MCP server or infimium update start CLI process is open."
    });
  } finally { store.close(); }
}

export async function runInfimiumUpdateCommand(args: string[]): Promise<void> {
  const input: InfimiumUpdateArgs = {};
  const actions = ["refresh", "start", "stop", "status"] as const;
  let index = 0;
  if (actions.includes(args[0] as typeof actions[number])) input.action = args[index++] as typeof input.action;
  for (; index < args.length; index++) {
    const flag = args[index];
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    switch (flag) {
      case "--project": input.project_path = value; break;
      case "--note": input.note = value; break;
      case "--task": input.task = value; break;
      case "--handoff": input.handoff = value; break;
      case "--file": (input.files ??= []).push(value); break;
      case "--interval": input.interval_seconds = Number(value); break;
      default: throw new Error(`Unknown update argument: ${flag}`);
    }
  }
  console.log((await runInfimiumUpdateTool(input)).trimEnd());
  if (input.action !== "start") return;
  const worker = startMemoryUpdateWorker({ projectPath: resolveMemoryProjectPath(input.project_path), onError: console.error });
  console.error("Memory auto-update running. Ctrl+C stops this process; use update stop to disable future updates.");
  await new Promise<void>((resolveDone, reject) => {
    const keepAlive = setInterval(() => undefined, 60_000);
    const stop = () => {
      clearInterval(keepAlive);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      void worker.stop().then(resolveDone, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
