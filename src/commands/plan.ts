import { writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { loadConfig } from "../config.js";
import { ProjectMemoryStore } from "../memory/project-memory.js";
import { IMPLEMENTATION_PLAN_PROMPT } from "../prompts/plan-prompt.js";
import { DepGraphTool, type DepGraphResult } from "../tools/dep-graph.js";
import { CodeSearchTool, type CodeResult } from "../tools/semantic-code-search.js";

const DEFAULT_PLAN_MODEL = "llama3.1";
const DEFAULT_TOP_K = 5;
const MAX_CONTEXT_CHARS = 12_000;

type PlanCliArgs = {
  task: string;
  dryRun: boolean;
  writePlan: boolean;
  outputPath: string;
  topK: number;
  language?: string;
};

export type PlanResult = {
  task: string;
  dryRun: boolean;
  context: PlanContext;
  planText?: string;
  writtenPath?: string;
};

export type PlanContext = {
  codeResults: CodeResult[];
  dependencies: DepGraphResult[];
};

export type PlanOptions = {
  task: string;
  dryRun?: boolean;
  writePlan?: boolean;
  outputPath?: string;
  topK?: number;
  language?: string;
  codebasePath?: string | null;
  ollamaHost?: string;
  planModel?: string;
  recordMemory?: boolean;
  searcher?: CodeSearcher;
  depGraph?: DepGraphQuerier;
  llmClient?: PlanLlmClient;
};

type CodeSearcher = {
  search(query: string, language: string | undefined, topK: number): Promise<CodeResult[]>;
};

type DepGraphQuerier = {
  query(symbolName: string): DepGraphResult;
  close?(): void;
};

type PlanLlmClient = {
  generate(prompt: string, model: string, ollamaHost: string): Promise<string>;
};

type OllamaGenerateResponse = {
  response?: unknown;
};

export async function runPlanCommand(args: string[] = process.argv.slice(3)): Promise<void> {
  try {
    const parsed = parsePlanCliArgs(args);
    const config = loadConfig({ requireSearchApiKey: false });
    const result = await createPlan({
      task: parsed.task,
      dryRun: parsed.dryRun,
      writePlan: parsed.writePlan,
      outputPath: parsed.outputPath,
      topK: parsed.topK,
      language: parsed.language,
      codebasePath: config.codebasePath ?? process.cwd(),
      ollamaHost: config.ollamaHost,
      planModel: readPlanModel()
    });

    console.log(formatPlanResult(result, config.codebasePath ?? process.cwd()));
  } catch (error: unknown) {
    console.error(formatPlanError(error));
    process.exitCode = 1;
  }
}

export async function createPlan(options: PlanOptions): Promise<PlanResult> {
  const task = options.task.trim();
  if (!task) {
    throw new Error("Missing task. Usage: infimium plan \"add rate limiting to auth endpoint\"");
  }

  const codebasePath = options.codebasePath ?? process.cwd();
  const ollamaHost = normalizeBaseUrl(options.ollamaHost ?? "http://localhost:11434");
  const topK = options.topK ?? DEFAULT_TOP_K;
  const searcher =
    options.searcher ??
    new CodeSearchTool({
      codebasePath,
      ollamaHost
    });
  const depGraph =
    options.depGraph ??
    new DepGraphTool({
      codebasePath
    });

  try {
    const context = await retrievePlanContext({
      task,
      topK,
      language: options.language,
      searcher,
      depGraph
    });

    if (options.dryRun) {
      if (options.recordMemory ?? true) {
        rememberPlanEvent({
          codebasePath,
          task,
          dryRun: true
        });
      }

      return {
        task,
        dryRun: true,
        context
      };
    }

    const prompt = buildPlanPrompt(task, context, codebasePath);
    const llmClient = options.llmClient ?? new OllamaPlanClient();
    const planText = await llmClient.generate(prompt, options.planModel ?? readPlanModel(), ollamaHost);
    const result: PlanResult = {
      task,
      dryRun: false,
      context,
      planText
    };

    if (options.writePlan) {
      const outputPath = resolve(options.outputPath ?? "plan.md");
      await writeFile(outputPath, formatPlanMarkdown(result, codebasePath), "utf8");
      result.writtenPath = outputPath;
    }

    if (options.recordMemory ?? true) {
      rememberPlanEvent({
        codebasePath,
        task,
        writtenPath: result.writtenPath,
        dryRun: false
      });
    }

    return result;
  } finally {
    depGraph.close?.();
  }
}

export async function runPlanTool(
  options: Omit<PlanOptions, "writePlan"> & { writePlan?: boolean }
): Promise<string> {
  try {
    const result = await createPlan(options);
    return formatPlanResult(result, options.codebasePath ?? process.cwd());
  } catch (error: unknown) {
    return formatPlanError(error);
  }
}

export function formatPlanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  if (
    lowerMessage.includes("fetch failed") ||
    lowerMessage.includes("econnrefused") ||
    lowerMessage.includes("ollama")
  ) {
    return [
      "Plan failed: semantic retrieval or plan generation could not reach Ollama.",
      "Fix: ollama serve",
      "Then: ollama pull nomic-embed-text"
    ].join("\n");
  }

  if (
    lowerMessage.includes("chromadb") ||
    lowerMessage.includes("connection refused") ||
    lowerMessage.includes("failed to connect")
  ) {
    return [
      "Plan failed: semantic code context could not be read from ChromaDB.",
      "Fix: docker run -d --name infimium-chromadb -p 8000:8000 -v chroma_data:/chroma/chroma chromadb/chroma:latest"
    ].join("\n");
  }

  if (lowerMessage.includes("code not indexed") || lowerMessage.includes("not indexed")) {
    return ["Plan failed: code has not been indexed yet.", "Fix: npx infimium index"].join("\n");
  }

  return `Plan failed: ${message}`;
}

export function buildPlanPrompt(task: string, context: PlanContext, codebasePath: string): string {
  const contextText = formatRetrievedContext(context, codebasePath);
  const compactContext =
    contextText.length > MAX_CONTEXT_CHARS
      ? `${contextText.slice(0, MAX_CONTEXT_CHARS)}\n\n[Context truncated]`
      : contextText;

  return [
    IMPLEMENTATION_PLAN_PROMPT,
    "",
    "Task:",
    task,
    "",
    "Retrieved repository context:",
    compactContext
  ].join("\n");
}

export function formatPlanResult(result: PlanResult, codebasePath: string): string {
  if (result.dryRun) {
    return [
      "Infimium plan dry run",
      `Task: ${result.task}`,
      "",
      formatRetrievedContext(result.context, codebasePath),
      "",
      "LLM call skipped. Run without --dry-run to generate the implementation plan."
    ].join("\n");
  }

  return [
    "Infimium plan",
    `Task: ${result.task}`,
    result.writtenPath ? `Plan written to: ${result.writtenPath}` : null,
    "",
    result.planText ?? ""
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function formatPlanMarkdown(result: PlanResult, codebasePath: string): string {
  return [
    `# Infimium plan`,
    "",
    `Task: ${result.task}`,
    "",
    "## Retrieved context",
    "",
    formatRetrievedContext(result.context, codebasePath),
    "",
    "## Plan",
    "",
    result.planText ?? "Dry run: no plan generated."
  ].join("\n");
}

function parsePlanCliArgs(args: string[]): PlanCliArgs {
  const taskParts: string[] = [];
  let dryRun = false;
  let writePlan = false;
  let outputPath = "plan.md";
  let topK = DEFAULT_TOP_K;
  let language: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--write") {
      writePlan = true;
      continue;
    }

    if (arg === "--output") {
      outputPath = readFlagValue(args, index, "--output");
      index += 1;
      continue;
    }

    if (arg === "--top-k") {
      topK = Number(readFlagValue(args, index, "--top-k"));
      if (!Number.isInteger(topK) || topK <= 0) {
        throw new Error("--top-k must be a positive integer");
      }
      index += 1;
      continue;
    }

    if (arg === "--language") {
      language = readFlagValue(args, index, "--language");
      index += 1;
      continue;
    }

    taskParts.push(arg);
  }

  return {
    task: taskParts.join(" ").trim(),
    dryRun,
    writePlan,
    outputPath,
    topK,
    language
  };
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

async function retrievePlanContext(args: {
  task: string;
  topK: number;
  language?: string;
  searcher: CodeSearcher;
  depGraph: DepGraphQuerier;
}): Promise<PlanContext> {
  const codeResults = await args.searcher.search(args.task, args.language, args.topK);
  const dependencies = codeResults.map((result) => args.depGraph.query(result.name));

  return {
    codeResults,
    dependencies
  };
}

function formatRetrievedContext(context: PlanContext, codebasePath: string): string {
  const files = context.codeResults.map((result, index) =>
    [
      `[${index + 1}] ${displayPath(result.filePath, codebasePath)}:${result.lineStart}-${result.lineEnd}`,
      `Symbol: ${result.name} (${result.language}, score ${result.score.toFixed(2)})`,
      `Summary: ${collapseWhitespace(result.snippet)}`
    ].join("\n")
  );

  const dependencies = context.dependencies.map((dependency) =>
    [
      `Symbol: ${dependency.symbol}`,
      `Defined in: ${dependency.definedIn ? displayPath(dependency.definedIn, codebasePath) : "Not found"}`,
      `Imported by: ${formatPathList(dependency.importedBy, codebasePath)}`,
      `Imports: ${formatPathList(dependency.imports, codebasePath)}`
    ].join("\n")
  );

  return [
    "Retrieved code summaries:",
    files.length > 0 ? files.join("\n\n") : "No code results found.",
    "",
    "Relevant dependency edges:",
    dependencies.length > 0 ? dependencies.join("\n\n") : "No dependency edges found."
  ].join("\n");
}

function formatPathList(paths: string[], codebasePath: string): string {
  if (paths.length === 0) {
    return "None";
  }

  return paths.map((filePath) => displayPath(filePath, codebasePath)).join(", ");
}

function displayPath(filePath: string, codebasePath: string): string {
  const relativePath = relative(codebasePath, filePath);
  return relativePath && !relativePath.startsWith("..") ? relativePath : filePath;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function readPlanModel(): string {
  return (
    process.env.INFIMIUM_PLAN_MODEL?.trim() ||
    process.env.OLLAMA_PLAN_MODEL?.trim() ||
    process.env.OLLAMA_MODEL?.trim() ||
    DEFAULT_PLAN_MODEL
  );
}

function rememberPlanEvent(args: {
  codebasePath: string;
  task: string;
  writtenPath?: string;
  dryRun: boolean;
}): void {
  const store = new ProjectMemoryStore();
  try {
    store.remember({
      projectPath: args.codebasePath,
      eventType: "plan",
      summary: args.dryRun
        ? `Retrieved planning context for: ${args.task}`
        : `Generated implementation plan for: ${args.task}`,
      currentTask: args.task,
      lastPlanPath: args.writtenPath
    });
  } finally {
    store.close();
  }
}

function normalizeBaseUrl(value: string): string {
  const withProtocol = value.includes("://") ? value : `http://${value}`;
  return withProtocol.replace(/\/+$/, "");
}

class OllamaPlanClient implements PlanLlmClient {
  async generate(prompt: string, model: string, ollamaHost: string): Promise<string> {
    const response = await fetch(`${ollamaHost}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(
        `Ollama plan generation failed with HTTP ${response.status}. Run: ollama pull ${model}`
      );
    }

    const body = (await response.json()) as OllamaGenerateResponse;
    if (typeof body.response !== "string" || !body.response.trim()) {
      throw new Error("Ollama plan generation returned an empty response");
    }

    return body.response.trim();
  }
}
