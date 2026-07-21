import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runIndexForProject } from "./cli/index-cmd.js";
import { startAutoIndex } from "./cli/watch-cmd.js";
import { loadConfig } from "./config.js";
import {
  resolveMemoryProjectPath,
  runGetContextTool,
  runProjectMemoryTool
} from "./commands/memory.js";
import { runPlanTool } from "./commands/plan.js";
import { startContextLayerAutoWriter } from "./memory/context-layer.js";
import { resolveProjectPath } from "./paths.js";
import { trackFirstToolCall, trackTelemetry } from "./telemetry.js";
import { runDepGraph } from "./tools/dep-graph.js";
import { expandSymbol } from "./tools/expand-symbol.js";
import { runFetchUrl } from "./tools/fetch-url.js";
import { DEFAULT_OLLAMA_HOST, runQueryLocalDocs } from "./tools/query-local-docs.js";
import { runSemanticCodeSearch } from "./tools/semantic-code-search.js";
import { formatShellResult, runShell } from "./tools/shell.js";
import { runWebSearch } from "./tools/web-search.js";

type ToolResponse = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  schema: z.ZodType<unknown>;
};

type WebSearchArguments = {
  query: string;
  max_results?: number;
};

type FetchUrlArguments = {
  url: string;
  extract?: "text" | "markdown";
};

type ShellArguments = {
  command: string;
  cwd?: string;
  timeout?: number;
};

type QueryLocalDocsArguments = {
  query: string;
  top_k?: number;
  project_path?: string;
};

type SemanticCodeSearchArguments = {
  query: string;
  language?: string;
  top_k?: number;
  project_path?: string;
};

type ExpandSymbolArguments = {
  symbol_name: string;
  file_path?: string;
  project_path?: string;
};

type DepGraphArguments = {
  symbol_name: string;
  project_path?: string;
};

type PlanArguments = {
  task: string;
  dry_run?: boolean;
  write_plan?: boolean;
  output_path?: string;
  top_k?: number;
  language?: string;
  project_path?: string;
};

type ProjectMemoryArguments = {
  action: "resume" | "remember";
  note?: string;
  task?: string;
  event_type?: "note" | "progress" | "decision" | "blocker" | "index" | "plan";
  limit?: number;
  project_path?: string;
};

type GetContextArguments = {
  refresh?: boolean;
  limit?: number;
  format?: "yaml" | "json";
  project_path?: string;
};

const toolDefinitions = [
  {
    name: "hello_infimium",
    description: "Health probe for the Infimium MCP server.",
    schema: z.object({}),
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "web_search",
    description: "Search the web for current information.",
    schema: z.object({
      query: z.string(),
      max_results: z.number().int().positive().default(5).optional()
    }),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "number", default: 5 }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "fetch_url",
    description: "Fetch a URL and extract readable content.",
    schema: z.object({
      url: z.string().url(),
      extract: z.enum(["text", "markdown"]).default("markdown").optional()
    }),
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        extract: {
          type: "string",
          enum: ["text", "markdown"],
          default: "markdown"
        }
      },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "query_local_docs",
    description: "Query indexed local documentation.",
    schema: z.object({
      query: z.string(),
      top_k: z.number().int().positive().default(5).optional(),
      project_path: z.string().optional()
    }),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        top_k: { type: "number", default: 5 },
        project_path: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "semantic_code_search",
    description: "Search code semantically and return compact symbol signatures.",
    schema: z.object({
      query: z.string(),
      language: z.string().optional(),
      top_k: z.number().int().positive().default(5).optional(),
      project_path: z.string().optional()
    }),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        language: { type: "string" },
        top_k: { type: "number", default: 5 },
        project_path: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "expand_symbol",
    description: "Load the full implementation of one symbol returned by semantic_code_search.",
    schema: z.object({
      symbol_name: z.string(),
      file_path: z.string().optional(),
      project_path: z.string().optional()
    }),
    inputSchema: {
      type: "object",
      properties: {
        symbol_name: { type: "string" },
        file_path: { type: "string" },
        project_path: { type: "string" }
      },
      required: ["symbol_name"],
      additionalProperties: false
    }
  },
  {
    name: "dep_graph",
    description: "Inspect dependency relationships for a symbol.",
    schema: z.object({
      symbol_name: z.string(),
      project_path: z.string().optional()
    }),
    inputSchema: {
      type: "object",
      properties: {
        symbol_name: { type: "string" },
        project_path: { type: "string" }
      },
      required: ["symbol_name"],
      additionalProperties: false
    }
  },
  {
    name: "shell",
    description: "Run an allowlisted shell command.",
    schema: z.object({
      command: z.string(),
      cwd: z.string().optional(),
      timeout: z.number().int().positive().default(30).optional()
    }),
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeout: { type: "number", default: 30 }
      },
      required: ["command"],
      additionalProperties: false
    }
  },
  {
    name: "plan",
    description: "Generate a grounded implementation plan for the current repository.",
    schema: z.object({
      task: z.string(),
      dry_run: z.boolean().default(false).optional(),
      write_plan: z.boolean().default(false).optional(),
      output_path: z.string().default("plan.md").optional(),
      top_k: z.number().int().positive().default(5).optional(),
      language: z.string().optional(),
      project_path: z.string().optional()
    }),
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        dry_run: { type: "boolean", default: false },
        write_plan: { type: "boolean", default: false },
        output_path: { type: "string", default: "plan.md" },
        top_k: { type: "number", default: 5 },
        language: { type: "string" },
        project_path: { type: "string" }
      },
      required: ["task"],
      additionalProperties: false
    }
  },
  {
    name: "project_memory",
    description:
      "Remember or resume project task context across chats, agents, and IDEs. Pass project_path once when the IDE workspace differs from the MCP server cwd.",
    schema: z.object({
      action: z.enum(["resume", "remember"]).default("resume"),
      note: z.string().optional(),
      task: z.string().optional(),
      event_type: z
        .enum(["note", "progress", "decision", "blocker", "index", "plan"])
        .default("note")
        .optional(),
      limit: z.number().int().positive().default(8).optional(),
      project_path: z.string().optional()
    }),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["resume", "remember"],
          default: "resume"
        },
        note: { type: "string" },
        task: { type: "string" },
        event_type: {
          type: "string",
          enum: ["note", "progress", "decision", "blocker", "index", "plan"],
          default: "note"
        },
        limit: { type: "number", default: 8 },
        project_path: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_context",
    description:
      "Read the compact YAML context layer and project overview. Pass project_path once to activate the current IDE workspace as the default.",
    schema: z.object({
      refresh: z.boolean().default(true).optional(),
      limit: z.number().int().positive().default(8).optional(),
      format: z.enum(["yaml", "json"]).default("yaml").optional(),
      project_path: z.string().optional()
    }),
    inputSchema: {
      type: "object",
      properties: {
        refresh: { type: "boolean", default: true },
        limit: { type: "number", default: 8 },
        format: {
          type: "string",
          enum: ["yaml", "json"],
          default: "yaml"
        },
        project_path: { type: "string" }
      },
      additionalProperties: false
    }
  }
] satisfies ToolDefinition[];

function findTool(name: string): ToolDefinition | undefined {
  return toolDefinitions.find((tool) => tool.name === name);
}

function textResponse(text: string): ToolResponse {
  return {
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

function placeholderResponse(name: string): ToolResponse {
  return textResponse(`Tool ${name} not yet implemented`);
}

function isMissingApiKeyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "Missing SEARCH_API_KEY. Add it to your .env file."
  );
}

async function handleFetchUrl(args: FetchUrlArguments): Promise<ToolResponse> {
  const text = await runFetchUrl(args.url, args.extract ?? "markdown");

  return textResponse(text);
}

function readLocalDocsPath(): string | null {
  return process.env.LOCAL_DOCS_PATH?.trim() || null;
}

function readCodebasePath(): string | null {
  return process.env.CODEBASE_PATH?.trim() || null;
}

function readOllamaHost(): string {
  return process.env.OLLAMA_HOST?.trim() || DEFAULT_OLLAMA_HOST;
}

const indexingProjects = new Set<string>();

function indexProjectInBackground(projectPath?: string | null): void {
  if (!projectPath?.trim()) {
    return;
  }

  const resolvedProjectPath = resolveProjectPath(projectPath);
  if (indexingProjects.has(resolvedProjectPath)) {
    return;
  }

  indexingProjects.add(resolvedProjectPath);
  void runIndexForProject(resolvedProjectPath)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Background index failed for ${resolvedProjectPath}: ${message}`);
    })
    .finally(() => {
      indexingProjects.delete(resolvedProjectPath);
    });
}

async function handleQueryLocalDocs(args: QueryLocalDocsArguments): Promise<ToolResponse> {
  indexProjectInBackground(args.project_path);
  const localDocsPath = args.project_path
    ? resolveProjectPath(args.project_path)
    : readLocalDocsPath();
  const text = await runQueryLocalDocs(
    {
      localDocsPath,
      ollamaHost: readOllamaHost()
    },
    args.query,
    args.top_k ?? 5
  );

  return textResponse(text);
}

async function handleSemanticCodeSearch(
  args: SemanticCodeSearchArguments
): Promise<ToolResponse> {
  indexProjectInBackground(args.project_path);
  const projectPath = args.project_path
    ? resolveProjectPath(args.project_path)
    : resolveMemoryProjectPath(readCodebasePath());
  const text = await runSemanticCodeSearch(
    {
      codebasePath: projectPath,
      ollamaHost: readOllamaHost()
    },
    args.query,
    args.language,
    args.top_k ?? 5
  );

  return textResponse(text);
}

function handleDepGraph(args: DepGraphArguments): ToolResponse {
  indexProjectInBackground(args.project_path);
  const projectPath = args.project_path
    ? resolveProjectPath(args.project_path)
    : resolveMemoryProjectPath(readCodebasePath());
  return textResponse(
    runDepGraph(args.symbol_name, {
      codebasePath: projectPath
    })
  );
}

function handleExpandSymbol(args: ExpandSymbolArguments): ToolResponse {
  const projectPath = args.project_path
    ? resolveProjectPath(args.project_path)
    : resolveMemoryProjectPath(readCodebasePath());
  return textResponse(
    expandSymbol({
      codebasePath: projectPath,
      symbolName: args.symbol_name,
      filePath: args.file_path
    })
  );
}

async function handleShell(args: ShellArguments): Promise<ToolResponse> {
  const result = await runShell(
    loadConfig({ requireSearchApiKey: false }),
    args.command,
    args.cwd,
    args.timeout ?? 30
  );

  return textResponse(formatShellResult(result));
}

async function handlePlan(args: PlanArguments): Promise<ToolResponse> {
  const config = loadConfig({ requireSearchApiKey: false });
  indexProjectInBackground(args.project_path);
  const codebasePath = args.project_path
    ? resolveProjectPath(args.project_path)
    : resolveMemoryProjectPath(config.codebasePath);
  const text = await runPlanTool({
    task: args.task,
    dryRun: args.dry_run ?? false,
    writePlan: args.write_plan ?? false,
    outputPath: args.output_path ?? "plan.md",
    topK: args.top_k ?? 5,
    language: args.language,
    codebasePath,
    ollamaHost: config.ollamaHost
  });

  return textResponse(text);
}

function handleProjectMemory(args: ProjectMemoryArguments): ToolResponse {
  indexProjectInBackground(args.project_path);
  return textResponse(runProjectMemoryTool(args));
}

async function handleGetContext(args: GetContextArguments): Promise<ToolResponse> {
  indexProjectInBackground(args.project_path);
  return textResponse(await runGetContextTool(args));
}

async function handleWebSearch(args: WebSearchArguments): Promise<ToolResponse> {
  try {
    const text = await runWebSearch(
      loadConfig(),
      args.query,
      args.max_results ?? 5
    );

    return textResponse(text);
  } catch (error: unknown) {
    if (isMissingApiKeyError(error)) {
      return textResponse("Search unavailable: missing API key");
    }

    const message = error instanceof Error ? error.message : String(error);
    return textResponse(`Search failed: ${message}`);
  }
}

export function createServer(): Server {
  const server = new Server(
    {
      name: "infimium",
      version: "0.4.4"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = findTool(request.params.name);

    if (!tool) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    const parsedArgs = tool.schema.parse(request.params.arguments ?? {});
    void trackFirstToolCall(tool.name);

    if (tool.name === "hello_infimium") {
      return textResponse("hey-dude");
    }

    if (tool.name === "web_search") {
      return handleWebSearch(parsedArgs as WebSearchArguments);
    }

    if (tool.name === "fetch_url") {
      return handleFetchUrl(parsedArgs as FetchUrlArguments);
    }

    if (tool.name === "query_local_docs") {
      return handleQueryLocalDocs(parsedArgs as QueryLocalDocsArguments);
    }

    if (tool.name === "semantic_code_search") {
      return handleSemanticCodeSearch(parsedArgs as SemanticCodeSearchArguments);
    }

    if (tool.name === "expand_symbol") {
      return handleExpandSymbol(parsedArgs as ExpandSymbolArguments);
    }

    if (tool.name === "dep_graph") {
      return handleDepGraph(parsedArgs as DepGraphArguments);
    }

    if (tool.name === "shell") {
      return handleShell(parsedArgs as ShellArguments);
    }

    if (tool.name === "plan") {
      return handlePlan(parsedArgs as PlanArguments);
    }

    if (tool.name === "project_memory") {
      return handleProjectMemory(parsedArgs as ProjectMemoryArguments);
    }

    if (tool.name === "get_context") {
      return handleGetContext(parsedArgs as GetContextArguments);
    }

    return placeholderResponse(tool.name);
  });

  return server;
}

export async function startServer(): Promise<void> {
  void trackTelemetry("serve_started");
  const server = createServer();
  const transport = new StdioServerTransport();
  const config = loadConfig({ requireSearchApiKey: false });
  const contextLayer = startContextLayerAutoWriter({
    projectPath: resolveMemoryProjectPath(config.codebasePath),
    activateProject: false
  });
  const autoIndex =
    process.env.INFIMIUM_AUTO_INDEX?.trim() === "false"
      ? null
      : await startAutoIndex({
          onLog: (message) => console.error(message)
        }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Auto-index disabled: ${message}`);
          return null;
        });

  process.once("exit", () => {
    contextLayer.stop();
    autoIndex?.stop();
  });

  await server.connect(transport);
}
