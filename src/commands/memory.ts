import {
  readContextLayer,
  type ContextOutputFormat
} from "../memory/context-layer.js";
import {
  ProjectMemoryStore,
  formatResumeContext,
  type ProjectMemoryEventType
} from "../memory/project-memory.js";
import { resolveProjectPath } from "../paths.js";

type MemoryCommand = "resume" | "remember" | "memory";

type RememberArgs = {
  summary: string;
  eventType: ProjectMemoryEventType;
  currentTask?: string;
};

type GetContextArgs = {
  refresh: boolean;
  limit: number;
  format: ContextOutputFormat;
  projectPath?: string;
};

export async function runResumeCommand(args: string[] = process.argv.slice(3)): Promise<void> {
  const limit = parseLimit(args);
  const store = new ProjectMemoryStore();
  try {
    console.log(formatResumeContext(store.getResumeContext(resolveMemoryProjectPath(), limit)));
  } finally {
    store.close();
  }
}

export async function runRememberCommand(args: string[] = process.argv.slice(3)): Promise<void> {
  const parsed = parseRememberArgs(args);
  const store = new ProjectMemoryStore();
  try {
    const event = store.remember({
      projectPath: resolveMemoryProjectPath(),
      eventType: parsed.eventType,
      summary: parsed.summary,
      currentTask: parsed.currentTask
    });

    console.log(`Remembered ${event.eventType}: ${event.summary}`);
  } finally {
    store.close();
  }
}

export async function runMemoryCommand(
  command: MemoryCommand,
  args: string[] = process.argv.slice(3)
): Promise<void> {
  if (command === "resume") {
    await runResumeCommand(args);
    return;
  }

  if (command === "remember") {
    await runRememberCommand(args);
    return;
  }

  const subcommand = args[0] ?? "resume";
  const subArgs = args.slice(1);
  if (subcommand === "resume") {
    await runResumeCommand(subArgs);
    return;
  }

  if (subcommand === "remember") {
    await runRememberCommand(subArgs);
    return;
  }

  throw new Error("Usage: infimium memory resume | infimium memory remember \"what changed\"");
}

export async function runGetContextCommand(args: string[] = process.argv.slice(3)): Promise<void> {
  const parsed = parseGetContextArgs(args);
  const context = await readContextLayer({
    projectPath: resolveMemoryProjectPath(parsed.projectPath),
    limit: parsed.limit,
    refresh: parsed.refresh,
    format: parsed.format
  });

  console.log(context.trimEnd());
}

export async function runRefreshContextCommand(
  args: string[] = process.argv.slice(3)
): Promise<void> {
  await runGetContextCommand(args);
}

export async function runGetContextTool(args: {
  refresh?: boolean;
  limit?: number;
  format?: ContextOutputFormat;
  project_path?: string;
}): Promise<string> {
  return readContextLayer({
    projectPath: resolveMemoryProjectPath(args.project_path),
    limit: args.limit ?? 8,
    refresh: args.refresh ?? true,
    format: args.format ?? "yaml"
  });
}

export function runProjectMemoryTool(args: {
  action: "resume" | "remember";
  note?: string;
  task?: string;
  event_type?: ProjectMemoryEventType;
  limit?: number;
  project_path?: string;
}): string {
  const store = new ProjectMemoryStore();
  try {
    const projectPath = resolveMemoryProjectPath(args.project_path);

    if (args.action === "remember") {
      const note = args.note?.trim();
      if (!note) {
        return "Memory not saved: note is required for action=remember";
      }

      const event = store.remember({
        projectPath,
        eventType: args.event_type ?? "note",
        summary: note,
        currentTask: args.task
      });

      return `Remembered ${event.eventType}: ${event.summary}`;
    }

    return formatResumeContext(
      store.getResumeContext(projectPath, args.limit ?? 8)
    );
  } finally {
    store.close();
  }
}

export function resolveMemoryProjectPath(explicitProjectPath?: string | null): string {
  if (explicitProjectPath?.trim()) {
    return resolveProjectPath(explicitProjectPath);
  }

  const store = new ProjectMemoryStore();
  try {
    return store.getActiveProjectPath() ?? resolveProjectPath();
  } finally {
    store.close();
  }
}

function parseGetContextArgs(args: string[]): GetContextArgs {
  let refresh = true;
  let limit = 8;
  let format: ContextOutputFormat = "yaml";
  let projectPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--cached") {
      refresh = false;
      continue;
    }

    if (arg === "--refresh") {
      refresh = true;
      continue;
    }

    if (arg === "--limit") {
      limit = Number(readFlagValue(args, index, "--limit"));
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      index += 1;
      continue;
    }

    if (arg === "--project") {
      projectPath = readFlagValue(args, index, "--project");
      index += 1;
      continue;
    }

    if (arg === "--format") {
      const value = readFlagValue(args, index, "--format");
      if (value !== "yaml" && value !== "json") {
        throw new Error("--format must be yaml or json");
      }
      format = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown get_context argument: ${arg}`);
  }

  return {
    refresh,
    limit,
    format,
    projectPath
  };
}

function parseRememberArgs(args: string[]): RememberArgs {
  const summaryParts: string[] = [];
  let eventType: ProjectMemoryEventType = "note";
  let currentTask: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--type") {
      eventType = parseEventType(readFlagValue(args, index, "--type"));
      index += 1;
      continue;
    }

    if (arg === "--task") {
      currentTask = readFlagValue(args, index, "--task");
      index += 1;
      continue;
    }

    summaryParts.push(arg);
  }

  const summary = summaryParts.join(" ").trim();
  if (!summary) {
    throw new Error("Usage: infimium remember \"what changed\" --type progress");
  }

  return {
    summary,
    eventType,
    currentTask
  };
}

function parseLimit(args: string[]): number {
  const index = args.indexOf("--limit");
  if (index === -1) {
    return 8;
  }

  const value = Number(readFlagValue(args, index, "--limit"));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("--limit must be a positive integer");
  }

  return value;
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function parseEventType(value: string): ProjectMemoryEventType {
  if (
    value === "note" ||
    value === "progress" ||
    value === "decision" ||
    value === "blocker" ||
    value === "index" ||
    value === "plan"
  ) {
    return value;
  }

  throw new Error("--type must be one of: note, progress, decision, blocker, index, plan");
}
