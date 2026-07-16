import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { runDepGraph } from "./tools/dep-graph.js";
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
};

type SemanticCodeSearchArguments = {
  query: string;
  language?: string;
  top_k?: number;
};

type DepGraphArguments = {
  symbol_name: string;
};

const toolDefinitions = [
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
      top_k: z.number().int().positive().default(5).optional()
    }),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        top_k: { type: "number", default: 5 }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "semantic_code_search",
    description: "Search code semantically across the configured codebase.",
    schema: z.object({
      query: z.string(),
      language: z.string().optional(),
      top_k: z.number().int().positive().default(5).optional()
    }),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        language: { type: "string" },
        top_k: { type: "number", default: 5 }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "dep_graph",
    description: "Inspect dependency relationships for a symbol.",
    schema: z.object({
      symbol_name: z.string()
    }),
    inputSchema: {
      type: "object",
      properties: {
        symbol_name: { type: "string" }
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

async function handleQueryLocalDocs(args: QueryLocalDocsArguments): Promise<ToolResponse> {
  const text = await runQueryLocalDocs(
    {
      localDocsPath: readLocalDocsPath(),
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
  const text = await runSemanticCodeSearch(
    {
      codebasePath: readCodebasePath(),
      ollamaHost: readOllamaHost()
    },
    args.query,
    args.language,
    args.top_k ?? 5
  );

  return textResponse(text);
}

function handleDepGraph(args: DepGraphArguments): ToolResponse {
  return textResponse(
    runDepGraph(args.symbol_name, {
      codebasePath: readCodebasePath()
    })
  );
}

async function handleShell(args: ShellArguments): Promise<ToolResponse> {
  const result = await runShell(
    loadConfig(),
    args.command,
    args.cwd,
    args.timeout ?? 30
  );

  return textResponse(formatShellResult(result));
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
      version: "0.1.0"
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

    if (tool.name === "dep_graph") {
      return handleDepGraph(parsedArgs as DepGraphArguments);
    }

    if (tool.name === "shell") {
      return handleShell(parsedArgs as ShellArguments);
    }

    return placeholderResponse(tool.name);
  });

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
}
