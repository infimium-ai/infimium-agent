#!/usr/bin/env node

import { initEnv } from "./cli/init.js";
import { runIndexCommand } from "./cli/index-cmd.js";
import { runPlaygroundCommand } from "./cli/playground.js";
import { runStatusCommand } from "./cli/status-cmd.js";
import { runWatchCommand } from "./cli/watch-cmd.js";
import { runCodeSearchCommand } from "./commands/code-search.js";
import { runDepGraphCommand } from "./commands/dep-graph.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runDocsSearchCommand } from "./commands/docs-search.js";
import { runFetchCommand } from "./commands/fetch.js";
import { runExpandSymbolCommand } from "./commands/expand-symbol.js";
import {
  runGetContextCommand,
  runMemoryCommand,
  runRememberCommand,
  runResumeCommand
} from "./commands/memory.js";
import { runPlanCommand } from "./commands/plan.js";
import { runSearchCommand } from "./commands/search.js";
import { runSetupCommand } from "./commands/setup.js";
import { runWorkspaceCommand } from "./commands/workspace.js";
import { startServer } from "./server.js";
import { protectStdioStdout } from "./stdio.js";
import { runTelemetryCommand } from "./telemetry.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  const args = process.argv.slice(3);

  if (command === "--help" || command === "-h" || command === "help") {
    console.log(`Infimium — Project-Aware Context Layer for AI Agents

Usage: infimium <command> [options]

Commands:
  setup           Interactive setup for Infimium dependencies (Ollama, models, sqlite)
  doctor          Run health checks on your setup
  index           Index the current directory (code, docs, dependencies)
  watch           Run indexer in watch mode
  status          Show index and memory status
  playground      Launch the local playground web UI
  workspace       Manage tracked projects in your workspace
  get-context     Output the full flattened context (layer.md)
  remember        Add a milestone or note to project memory
  memory          Manage project memory (reset, inspect)
  plan            Draft an implementation plan based on a prompt
  serve           (Default) Start the MCP server via stdio

Options:
  --help, -h      Show this help message`);
    return;
  }

  if (command === "init") {
    await initEnv(undefined, {
      telemetryEnabled: !args.includes("--no-telemetry")
    });
    return;
  }

  if (command === "setup") {
    await runSetupCommand(args);
    return;
  }

  if (command === "index") {
    await runIndexCommand(args);
    return;
  }

  if (command === "workspace") {
    await runWorkspaceCommand(args);
    return;
  }

  if (command === "watch" || command === "watch-index" || command === "auto-index") {
    await runWatchCommand(args);
    return;
  }

  if (command === "status") {
    await runStatusCommand();
    return;
  }

  if (command === "hello" || command === "hello-infimium" || command === "hello_infimium") {
    console.log("hey-dude");
    return;
  }

  if (command === "search") {
    await runSearchCommand(args);
    return;
  }

  if (command === "fetch" || command === "fetch-url" || command === "fetch_url") {
    await runFetchCommand(args);
    return;
  }

  if (
    command === "code-search" ||
    command === "semantic-code-search" ||
    command === "semantic_code_search"
  ) {
    await runCodeSearchCommand(args);
    return;
  }

  if (command === "expand-symbol" || command === "expand_symbol") {
    await runExpandSymbolCommand(args);
    return;
  }

  if (
    command === "docs-search" ||
    command === "query-local-docs" ||
    command === "query_local_docs"
  ) {
    await runDocsSearchCommand(args);
    return;
  }

  if (command === "dep-graph" || command === "dep_graph") {
    await runDepGraphCommand(args);
    return;
  }

  if (command === "resume") {
    await runResumeCommand(args);
    return;
  }

  if (command === "get-context" || command === "get_context") {
    await runGetContextCommand(args);
    return;
  }

  if (command === "remember") {
    await runRememberCommand(args);
    return;
  }

  if (command === "memory") {
    await runMemoryCommand(command, args);
    return;
  }

  if (command === "doctor") {
    await runDoctorCommand();
    return;
  }

  if (command === "plan") {
    await runPlanCommand(args);
    return;
  }

  if (command === "playground") {
    await runPlaygroundCommand();
    return;
  }

  if (command === "telemetry") {
    await runTelemetryCommand(args);
    return;
  }

  if (command === "serve") {
    protectStdioStdout();
    console.error("Infimium MCP server running...");
    await startServer();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : String(error);
  if (message.includes("database is locked")) {
    message = "Database is locked. Is another instance of Infimium (like the playground or watch) already running?";
  }
  console.error(`Failed to start Infimium: ${message}`);
  process.exitCode = 1;
});
