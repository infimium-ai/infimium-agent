import { relative, resolve } from "node:path";

import { z } from "zod";

import { MEMORY_COMPACTION_PROMPT } from "../prompts/memory-compaction-prompt.js";
import {
  ProjectMemoryStore,
  type DurableMemory,
  type MemoryArchiveEntry,
  type MemoryScratchpadEvent
} from "./project-memory.js";

const DEFAULT_MEMORY_MODEL = "llama3.1";
const MAX_PROMPT_CHARS = 24_000;
const OLLAMA_COMPACTION_FORMAT = {
  type: "object",
  additionalProperties: false,
  required: [
    "milestone",
    "summary",
    "durableMemories",
    "unresolvedBlockers",
    "relevantFiles"
  ],
  properties: {
    milestone: { type: "string" },
    summary: { type: "string" },
    durableMemories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "key", "value", "confidence"],
        properties: {
          category: { type: "string", enum: ["decision", "rule", "quirk", "blocker"] },
          key: { type: "string" },
          value: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    },
    unresolvedBlockers: { type: "array", items: { type: "string" } },
    relevantFiles: { type: "array", items: { type: "string" } }
  }
} as const;

const compactionSchema = z.object({
  milestone: z.string().min(1).max(160),
  summary: z.string().min(1).max(2_000),
  durableMemories: z.array(z.object({
    category: z.enum(["decision", "rule", "quirk", "blocker"]),
    key: z.string().min(1).max(120),
    value: z.string().min(1).max(1_000),
    confidence: z.number().min(0).max(1)
  })).max(10),
  unresolvedBlockers: z.array(z.string().min(1).max(500)).max(5),
  relevantFiles: z.array(z.string().min(1).max(500)).max(10)
});

export type MemoryCompaction = z.infer<typeof compactionSchema>;

export type MemoryCompactionResult = {
  archive: MemoryArchiveEntry;
  scratchpadEvents: number;
  ledgerEntries: number;
  usedModel: boolean;
  model: string | null;
};

type CompactProjectMemoryOptions = {
  projectPath: string;
  ollamaHost?: string;
  model?: string;
  useModel?: boolean;
  store?: ProjectMemoryStore;
};

type OllamaGenerateResponse = { response?: unknown };

export async function compactProjectMemory(
  options: CompactProjectMemoryOptions
): Promise<MemoryCompactionResult> {
  const projectPath = resolve(options.projectPath);
  const ownsStore = options.store === undefined;
  const store = options.store ?? new ProjectMemoryStore();
  try {
    const session = store.getActiveSession(projectPath);
    if (!session) {
      throw new Error("No active memory session to complete");
    }
    const events = store.getScratchpadEvents(session.id, 200);
    if (events.length === 0) {
      throw new Error("The active memory session has no events to compact");
    }

    const model = readMemoryModel(options.model);
    let compaction: MemoryCompaction;
    let usedModel = false;
    if (options.useModel ?? true) {
      const generated = await generateWithOllama({
        projectPath,
        task: session.task,
        events,
        model,
        ollamaHost: options.ollamaHost ?? process.env.OLLAMA_HOST ?? "http://localhost:11434"
      }).catch(() => null);
      if (generated) {
        compaction = normalizeModelCompaction(generated, projectPath, session.task, events);
        usedModel = true;
      } else {
        compaction = buildDeterministicCompaction(projectPath, session.task, events);
      }
    } else {
      compaction = buildDeterministicCompaction(projectPath, session.task, events);
    }

    const archive = store.completeSession({
      projectPath,
      sessionId: session.id,
      ...compaction
    });
    return {
      archive,
      scratchpadEvents: events.length,
      ledgerEntries: compaction.durableMemories.length,
      usedModel,
      model: usedModel ? model : null
    };
  } finally {
    if (ownsStore) store.close();
  }
}

export function buildDeterministicCompaction(
  projectPath: string,
  task: string | null,
  events: MemoryScratchpadEvent[]
): MemoryCompaction {
  const meaningful = deduplicate(events.filter((event) => event.eventType !== "plan"));
  const latest = meaningful.slice(-5);
  const milestone = trimSentence(task ?? latest.at(-1)?.summary ?? "Completed project task", 160);
  const outcomes = latest.map((event) => trimSentence(event.summary, 240));
  const summary = trimSentence(
    outcomes.length > 0
      ? `Completed ${milestone}. Key outcomes: ${outcomes.join("; ")}.`
      : `Completed ${milestone}.`,
    2_000
  );
  const durableMemories: DurableMemory[] = meaningful
    .filter((event) => event.eventType === "decision" || event.eventType === "blocker")
    .slice(-10)
    .map((event) => ({
      category: event.eventType === "decision" ? "decision" : "blocker",
      key: stableMemoryKey(event.summary),
      value: trimSentence(event.details ?? event.summary, 1_000),
      confidence: 0.8
    }));
  const unresolvedBlockers = meaningful
    .filter((event) => event.eventType === "blocker")
    .slice(-5)
    .map((event) => trimSentence(event.summary, 500));
  const relevantFiles = extractFilePaths(projectPath, meaningful).slice(0, 10);

  return compactionSchema.parse({
    milestone,
    summary,
    durableMemories,
    unresolvedBlockers,
    relevantFiles
  });
}

async function generateWithOllama(input: {
  projectPath: string;
  task: string | null;
  events: MemoryScratchpadEvent[];
  model: string;
  ollamaHost: string;
}): Promise<MemoryCompaction | null> {
  const eventLines = input.events.map((event) =>
    `[${new Date(event.createdAt).toISOString()}] ${event.eventType}: ${event.summary}` +
    (event.details ? `\nDetails: ${event.details}` : "")
  );
  const prompt = [
    MEMORY_COMPACTION_PROMPT,
    "",
    `Project: ${input.projectPath}`,
    `Completed task: ${input.task ?? "Not explicitly named"}`,
    "",
    "Scratchpad events:",
    eventLines.join("\n\n")
  ].join("\n").slice(0, MAX_PROMPT_CHARS);
  const response = await fetch(`${normalizeBaseUrl(input.ollamaHost)}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      prompt,
      stream: false,
      format: OLLAMA_COMPACTION_FORMAT
    })
  });
  if (!response.ok) return null;
  const body = (await response.json()) as OllamaGenerateResponse;
  if (typeof body.response !== "string") return null;
  try {
    return compactionSchema.parse(JSON.parse(stripCodeFence(body.response)) as unknown);
  } catch {
    return null;
  }
}

function deduplicate(events: MemoryScratchpadEvent[]): MemoryScratchpadEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.eventType}:${event.summary.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeModelCompaction(
  generated: MemoryCompaction,
  projectPath: string,
  task: string | null,
  events: MemoryScratchpadEvent[]
): MemoryCompaction {
  const fallback = buildDeterministicCompaction(projectPath, task, events);
  const eventText = events
    .map((event) => `${event.eventType} ${event.summary} ${event.details ?? ""}`)
    .join(" ")
    .toLowerCase();
  const mentionedFiles = new Set(extractFilePaths(projectPath, events));
  const blockerEvents = events.filter((event) => event.eventType === "blocker");
  const placeholderMilestone = /^(short completed milestone|completed task|milestone|<.*>)$/i.test(
    generated.milestone.trim()
  );
  const durableMemories = generated.durableMemories.filter((memory) =>
    hasGroundingOverlap(`${memory.key} ${memory.value}`, eventText)
  );
  let summary = generated.summary.trim();
  if (blockerEvents.length === 0) {
    summary = summary
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => !/\b(unresolved|blocked|blocker remains|work remains)\b/i.test(sentence))
      .join(" ")
      .trim();
  }

  return compactionSchema.parse({
    milestone: placeholderMilestone ? fallback.milestone : generated.milestone,
    summary: summary || fallback.summary,
    durableMemories,
    unresolvedBlockers: blockerEvents.length > 0
      ? generated.unresolvedBlockers.filter((blocker) => hasGroundingOverlap(blocker, eventText))
      : [],
    relevantFiles: generated.relevantFiles.filter((filePath) => mentionedFiles.has(filePath))
  });
}

function hasGroundingOverlap(value: string, source: string): boolean {
  const terms = value.toLowerCase().match(/[a-z0-9_./-]{4,}/g) ?? [];
  return terms.some((term) => source.includes(term));
}

function extractFilePaths(projectPath: string, events: MemoryScratchpadEvent[]): string[] {
  const paths = new Set<string>();
  const pathPattern = /(?:^|[\s`'"(])((?:src|lib|app|api|services|packages|tests?|docs|supabase)\/[\w@+.,/ -]+\.[a-z0-9]+)(?=$|[\s`'"),:])/gi;
  for (const event of events) {
    const text = `${event.summary} ${event.details ?? ""}`;
    for (const match of text.matchAll(pathPattern)) {
      const value = match[1]?.trim();
      if (!value) continue;
      const absolute = resolve(projectPath, value);
      const display = relative(projectPath, absolute);
      if (display && !display.startsWith("..")) paths.add(display);
    }
  }
  return [...paths];
}

function stableMemoryKey(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized.slice(0, 80) || "project-memory";
}

function trimSentence(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}.`;
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function normalizeBaseUrl(value: string): string {
  const withProtocol = value.includes("://") ? value : `http://${value}`;
  return withProtocol.replace(/\/+$/, "");
}

function readMemoryModel(explicit?: string): string {
  return explicit?.trim() || process.env.INFIMIUM_MEMORY_MODEL?.trim() ||
    process.env.INFIMIUM_PLAN_MODEL?.trim() || process.env.OLLAMA_PLAN_MODEL?.trim() ||
    process.env.OLLAMA_MODEL?.trim() || DEFAULT_MEMORY_MODEL;
}
