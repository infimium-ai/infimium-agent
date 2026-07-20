import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const expectedToolNames = [
  "hello_infimium",
  "web_search",
  "fetch_url",
  "query_local_docs",
  "semantic_code_search",
  "expand_symbol",
  "dep_graph",
  "shell",
  "plan",
  "project_memory",
  "get_context"
] as const;

const tmpDir = process.platform === "darwin" ? "/private/tmp" : tmpdir();
const serverDataDir = mkdtempSync(join(tmpDir, "infimium-server-test-"));
const builtServerPath = "dist/src/index.js";
const serverArgs = existsSync(builtServerPath)
  ? [builtServerPath, "serve"]
  : ["node_modules/tsx/dist/cli.mjs", "src/index.ts", "serve"];

const validToolInputs: Record<
  (typeof expectedToolNames)[number],
  Record<string, unknown>
> = {
  hello_infimium: {},
  web_search: { query: "infimium", max_results: 1 },
  fetch_url: { url: "data:text/html,<main>Hello from Infimium</main>", extract: "markdown" },
  query_local_docs: { query: "setup", top_k: 1 },
  semantic_code_search: { query: "server", top_k: 1 },
  expand_symbol: { symbol_name: "createServer" },
  dep_graph: { symbol_name: "createServer" },
  shell: { command: "ls", timeout: 1 },
  plan: { task: "add a doctor command", dry_run: true, top_k: 1 },
  project_memory: { action: "resume", limit: 1 },
  get_context: { refresh: true, limit: 1 }
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
      args: serverArgs,
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        ...(tmpDir ? { TMPDIR: tmpDir } : {}),
        INFIMIUM_DATA_DIR: serverDataDir,
        SEARCH_API_KEY: "test-key",
        SHELL_ALLOWLIST: "ls,sleep"
      }
    });

    await client.connect(transport);
  }, 5_000);

  afterAll(async () => {
    await transport.close();
    rmSync(serverDataDir, { recursive: true, force: true });
  });

  it("lists exactly the eleven Infimium tools", async () => {
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

  it("responds to the hello health probe", async () => {
    const rawResponse = await client.callTool(
      {
        name: "hello_infimium",
        arguments: {}
      },
      undefined,
      { timeout: 2_000 }
    );
    const response = CallToolResultSchema.parse(rawResponse);

    expect(response.content[0]).toEqual({
      type: "text",
      text: "hey-dude"
    });
  });
});
