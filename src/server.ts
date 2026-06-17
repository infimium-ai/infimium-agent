import { loadConfig, type Config } from "./config.js";
import { depGraphInputSchema, depGraphTool } from "./tools/dep_graph.js";
import { fetchUrlInputSchema, fetchUrlTool } from "./tools/fetch_url.js";
import {
  queryLocalDocsInputSchema,
  queryLocalDocsTool
} from "./tools/query_local_docs.js";
import {
  semanticCodeSearchInputSchema,
  semanticCodeSearchTool
} from "./tools/semantic_code_search.js";
import { shellInputSchema, shellTool } from "./tools/shell.js";
import { webSearchInputSchema, webSearchTool } from "./tools/web_search.js";

export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: unknown;
  execute: (input: TInput) => Promise<unknown>;
}

export class InfimiumServer {
  constructor(
    public readonly config: Config,
    public readonly tools: ToolDefinition[]
  ) {}

  async start() {
    return {
      name: "infimium",
      toolCount: this.tools.length
    };
  }
}

export function createInfimiumServer(
  config: Config = loadConfig()
): InfimiumServer {
  return new InfimiumServer(config, [
    {
      name: "web_search",
      description: "Search the web through a configured provider.",
      inputSchema: webSearchInputSchema,
      execute: webSearchTool
    },
    {
      name: "fetch_url",
      description: "Fetch and normalize a remote URL.",
      inputSchema: fetchUrlInputSchema,
      execute: fetchUrlTool
    },
    {
      name: "query_local_docs",
      description: "Search indexed local documentation.",
      inputSchema: queryLocalDocsInputSchema,
      execute: queryLocalDocsTool
    },
    {
      name: "semantic_code_search",
      description: "Run semantic search across the configured codebase.",
      inputSchema: semanticCodeSearchInputSchema,
      execute: semanticCodeSearchTool
    },
    {
      name: "dep_graph",
      description: "Inspect dependency relationships in the codebase.",
      inputSchema: depGraphInputSchema,
      execute: depGraphTool
    },
    {
      name: "shell",
      description: "Run allowlisted shell commands.",
      inputSchema: shellInputSchema,
      execute: shellTool
    }
  ]);
}
