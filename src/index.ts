#!/usr/bin/env node

import { initEnv } from "./cli/init.js";
import { runIndexCommand } from "./cli/index-cmd.js";
import { runStatusCommand } from "./cli/status-cmd.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";

  if (command === "init") {
    await initEnv();
    return;
  }

  if (command === "index") {
    await runIndexCommand();
    return;
  }

  if (command === "status") {
    await runStatusCommand();
    return;
  }

  if (command === "serve") {
    console.error("Infimium MCP server running...");
    await startServer();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start Infimium: ${message}`);
  process.exitCode = 1;
});
