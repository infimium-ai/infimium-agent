import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectMemoryStore } from "../src/memory/project-memory.js";
import { createProjectId } from "../src/memory/project-overview.js";

const expectedToolNames = [
  "infimium_update",
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
  infimium_update: { action: "status" },
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
        SEARCH_API_KEY: "",
        INFIMIUM_AUTO_INDEX: "false",
        INFIMIUM_TELEMETRY: "false",
        SHELL_ALLOWLIST: "ls,sleep"
      }
    });

    await client.connect(transport);
  }, 5_000);

  afterAll(async () => {
    await transport.close();
    rmSync(serverDataDir, { recursive: true, force: true });
  });

  it("lists all Infimium tools including memory updates", async () => {
    const response = await client.listTools(undefined, { timeout: 2_000 });
    const toolNames = response.tools.map((tool) => tool.name).sort();

    expect(toolNames).toEqual([...expectedToolNames].sort());
  });

  it("returns text content from every tool without external search credentials", async () => {
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

  it("updates project memory through MCP and returns its handoff without a refresh", async () => {
    const project = join(serverDataDir, "memory-project");
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "memory-mcp-check" }));
    const updated = CallToolResultSchema.parse(await client.callTool({
      name: "infimium_update",
      arguments: { project_path: project, note: "Verified MCP checkpoint", task: "Check handoff", handoff: "Review the saved checkpoint" }
    }));
    expect(updated.isError).not.toBe(true);
    expect(JSON.stringify(updated.content)).toContain("updated: true");
    const context = CallToolResultSchema.parse(await client.callTool({
      name: "get_context", arguments: { project_path: project }
    }));
    expect(JSON.stringify(context.content)).toContain("Review the saved checkpoint");
    expect(JSON.stringify(context.content)).toContain("Do not rescan");
    for (const action of ["start", "status", "stop"] as const) {
      const result = CallToolResultSchema.parse(await client.callTool({
        name: "infimium_update", arguments: { project_path: project, action }
      }));
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain(`enabled: ${action !== "stop"}`);
    }
  });
});

describe("Infimium MCP server in a read-only client sandbox", () => {
  const readOnlyDataDir = mkdtempSync(join(tmpDir, "infimium-readonly-test-"));
  const projectPath = process.cwd();
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    const dbPath = join(readOnlyDataDir, "infimium.db");
    const store = new ProjectMemoryStore(dbPath);
    store.saveContextSnapshot({
      projectPath,
      filePath: join(readOnlyDataDir, "context", createProjectId(projectPath), "layer.md"),
      snapshotText: "schemaVersion: 4\nsource: cached-read-only-context\n",
      format: "yaml",
      updatedAt: Date.now(),
      activateProject: true
    });
    store.close();
    const contextDirectory = join(readOnlyDataDir, "context", createProjectId(projectPath));
    mkdirSync(contextDirectory, { recursive: true });
    writeFileSync(
      join(contextDirectory, "layer.md"),
      "schemaVersion: 4\nsource: cached-read-only-context\n",
      "utf8"
    );
    chmodSync(dbPath, 0o444);
    chmodSync(readOnlyDataDir, 0o555);

    client = new Client({
      name: "infimium-readonly-test-client",
      version: "0.1.0"
    });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: serverArgs,
      cwd: projectPath,
      stderr: "pipe",
      env: {
        INFIMIUM_DATA_DIR: readOnlyDataDir,
        INFIMIUM_AUTO_INDEX: "false",
        INFIMIUM_TELEMETRY: "false"
      }
    });

    await client.connect(transport);
  }, 5_000);

  afterAll(async () => {
    await transport.close();
    chmodSync(readOnlyDataDir, 0o755);
    chmodSync(join(readOnlyDataDir, "infimium.db"), 0o644);
    rmSync(readOnlyDataDir, { recursive: true, force: true });
  });

  it("keeps tool discovery and health available", async () => {
    const tools = await client.listTools(undefined, { timeout: 2_000 });
    expect(tools.tools.map((tool) => tool.name)).toContain("get_context");

    const response = CallToolResultSchema.parse(
      await client.callTool(
        { name: "hello_infimium", arguments: {} },
        undefined,
        { timeout: 2_000 }
      )
    );
    expect(response.content[0]).toEqual({ type: "text", text: "hey-dude" });
  });

  it("returns the cached context without requiring a database write", async () => {
    const response = CallToolResultSchema.parse(
      await client.callTool(
        {
          name: "get_context",
          arguments: { project_path: projectPath, refresh: false }
        },
        undefined,
        { timeout: 2_000 }
      )
    );
    expect(response.content[0]).toEqual({
      type: "text",
      text: "schemaVersion: 4\nsource: cached-read-only-context\n"
    });
  });
});
