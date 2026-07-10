import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const expectedToolNames = [
  "web_search",
  "fetch_url",
  "query_local_docs",
  "semantic_code_search",
  "dep_graph",
  "shell"
] as const;

const tmpDir = process.env.TMPDIR?.startsWith("/var/")
  ? `/private${process.env.TMPDIR}`
  : process.env.TMPDIR;

const validToolInputs: Record<
  (typeof expectedToolNames)[number],
  Record<string, unknown>
> = {
  web_search: { query: "infimium", max_results: 1 },
  fetch_url: { url: "data:text/html,<main>Hello from Infimium</main>", extract: "markdown" },
  query_local_docs: { query: "setup", top_k: 1 },
  semantic_code_search: { query: "server", top_k: 1 },
  dep_graph: { symbol_name: "createServer" },
  shell: { command: "ls", timeout: 1 }
};

describe("Infimium MCP server", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    client = new Client({
      name: "infimium-test-client",
      version: "0.1.0"
    });

    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["node_modules/tsx/dist/cli.mjs", "src/index.ts", "serve"],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        ...(tmpDir ? { TMPDIR: tmpDir } : {}),
        SEARCH_API_KEY: "test-key",
        SHELL_ALLOWLIST: "ls,sleep"
      }
    });

    await client.connect(transport);
  }, 5_000);

  afterAll(async () => {
    await transport.close();
  });

  it("lists exactly the six Infimium tools", async () => {
    const response = await client.listTools(undefined, { timeout: 2_000 });
    const toolNames = response.tools.map((tool) => tool.name).sort();

    expect(toolNames).toEqual([...expectedToolNames].sort());
  });

  it("returns text content from every stub tool", async () => {
    for (const name of expectedToolNames) {
      const rawResponse = await client.callTool(
        {
          name,
          arguments: validToolInputs[name]
        },
        undefined,
        { timeout: 2_000 }
      );
      const response = CallToolResultSchema.parse(rawResponse);

      expect(response.content[0]?.type).toBe("text");
    }
  });
});
