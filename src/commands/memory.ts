import {
  readContextLayer,
  type ContextOutputFormat
} from "../memory/context-layer.js";
import {
  ProjectMemoryStore,
  formatResumeContext,
  type MemoryLedgerCategory,
  type ProjectMemoryEventType
} from "../memory/project-memory.js";
import { compactProjectMemory } from "../memory/memory-compactor.js";
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

  if (subcommand === "start") {
    const task = subArgs.join(" ").trim();
    if (!task) throw new Error("Usage: infimium memory start \"task description\"");
    const store = new ProjectMemoryStore();
    try {
      const session = store.startSession(resolveMemoryProjectPath(), task);
      console.log(`Started memory session ${session.id}: ${session.task ?? task}`);
    } finally {
      store.close();
    }
    return;
  }

  if (subcommand === "complete") {
    const result = await compactProjectMemory({
      projectPath: resolveMemoryProjectPath(),
      useModel: !subArgs.includes("--no-model")
    });
    console.log(formatCompactionResult(result));
    return;
  }

  if (subcommand === "search") {
    const query = subArgs.join(" ").trim();
    if (!query) throw new Error("Usage: infimium memory search \"query\"");
    const store = new ProjectMemoryStore();
    try {
      console.log(formatMemorySearch(store.searchMemory(resolveMemoryProjectPath(), query)));
    } finally {
      store.close();
    }
    return;
  }

  if (subcommand === "ledger") {
    const store = new ProjectMemoryStore();
    try {
      console.log(formatLedger(store.getRelevantLedger(resolveMemoryProjectPath(), "", 50)));
    } finally {
      store.close();
    }
    return;
  }

  throw new Error(
    "Usage: infimium memory start|remember|resume|complete|search|ledger"
  );
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

export async function runProjectMemoryTool(args: {
  action: "resume" | "remember" | "complete" | "search" | "ledger" | "supersede";
  note?: string;
  task?: string;
  event_type?: ProjectMemoryEventType;
  limit?: number;
  project_path?: string;
  query?: string;
  key?: string;
  value?: string;
  category?: MemoryLedgerCategory;
  use_model?: boolean;
}): Promise<string> {
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

    if (args.action === "complete") {
      const result = await compactProjectMemory({
        projectPath,
        useModel: args.use_model ?? true,
        store
      });
      return formatCompactionResult(result);
    }

    if (args.action === "search") {
      const query = args.query?.trim();
      if (!query) return "Memory search unavailable: query is required";
      return formatMemorySearch(store.searchMemory(projectPath, query, args.limit ?? 10));
    }

    if (args.action === "ledger") {
      return formatLedger(store.getRelevantLedger(projectPath, args.query ?? "", args.limit ?? 10));
    }

    if (args.action === "supersede") {
      const key = args.key?.trim();
      const value = args.value?.trim();
      if (!key || !value) return "Ledger update unavailable: key and value are required";
      const entry = store.supersedeLedgerEntry(projectPath, key, value, args.category ?? "rule");
      return `Updated ${entry.category}/${entry.key}: ${entry.value}`;
    }

    return formatResumeContext(
      store.getResumeContext(projectPath, args.limit ?? 8)
    );
  } finally {
    store.close();
  }
}

function formatCompactionResult(result: Awaited<ReturnType<typeof compactProjectMemory>>): string {
  return [
    "Memory session completed",
    `Milestone: ${result.archive.milestone}`,
    `Summary: ${result.archive.summary}`,
    `Compacted: ${result.scratchpadEvents} scratchpad event(s)`,
    `Ledger: ${result.ledgerEntries} durable memory entr${result.ledgerEntries === 1 ? "y" : "ies"}`,
    `Compactor: ${result.usedModel ? `Ollama (${result.model})` : "deterministic fallback"}`,
    result.archive.unresolvedBlockers.length > 0
      ? `Open blockers: ${result.archive.unresolvedBlockers.join("; ")}`
      : "Open blockers: none"
  ].join("\n");
}

function formatMemorySearch(results: ReturnType<ProjectMemoryStore["searchMemory"]>): string {
  if (results.length === 0) return "No matching project memory found.";
  return results.map((result, index) =>
    `[${index + 1}] ${result.source}/${result.category}: ${result.title}\n${result.summary}`
  ).join("\n\n");
}

function formatLedger(entries: ReturnType<ProjectMemoryStore["getRelevantLedger"]>): string {
  if (entries.length === 0) return "No durable project memories recorded.";
  return entries.map((entry) => `- ${entry.category}/${entry.key}: ${entry.value}`).join("\n");
}

export function resolveMemoryProjectPath(explicitProjectPath?: string | null): string {
  if (explicitProjectPath?.trim()) {
    return resolveProjectPath(explicitProjectPath);
  }

  let store: ProjectMemoryStore | null = null;
  try {
    store = new ProjectMemoryStore();
    return store.getActiveProjectPath() ?? resolveProjectPath();
  } catch {
    store?.close();
    store = null;
    try {
      store = new ProjectMemoryStore(undefined, { readOnly: true });
      return store.getActiveProjectPath() ?? resolveProjectPath();
    } catch {
      return resolveProjectPath();
    }
  } finally {
    store?.close();
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
