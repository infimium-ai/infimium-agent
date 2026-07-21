import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { initEnv } from "../cli/init.js";
import { runIndexCommand } from "../cli/index-cmd.js";
import { runPlaygroundCommand } from "../cli/playground.js";
import { collectDoctorChecks, formatDoctorReport } from "./doctor.js";
import { parseSetupArgs } from "./setup-options.js";
import { trackSetupCompleted, trackTelemetry } from "../telemetry.js";

const execFileAsync = promisify(execFile);
const EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const MAC_OLLAMA_BINARY = "/Applications/Ollama.app/Contents/Resources/ollama";

export async function runSetupCommand(args: string[] = []): Promise<void> {
  const options = parseSetupArgs(args);
  await trackTelemetry("setup_started", { install_deps: options.installDeps });

  console.log("Infimium setup");
  console.log("1/5 Creating local config...");
  await initEnv(undefined, { telemetryEnabled: options.telemetryEnabled });

  console.log("\n2/5 Preparing Ollama...");
  const ollamaBinary = await ensureOllamaInstalled(options.installDeps);
  await ensureOllamaRunning(ollamaBinary);
  await ensureEmbeddingModel(ollamaBinary);

  console.log("\n3/5 Indexing this project...");
  await runIndexCommand(["--yes", "--no-playground"], {
    stdinIsTTY: false,
    launchPlayground: async () => undefined
  });

  console.log("\n4/5 Checking setup...");
  const checks = await collectDoctorChecks();
  console.log(formatDoctorReport(checks));
  const passed = checks.every((check) => check.status === "pass");
  if (!passed) {
    process.exitCode = 1;
    return;
  }

  await trackSetupCompleted({ source: "setup" });

  if (options.openPlayground) {
    console.log("\n5/5 Opening Playground...");
    await runPlaygroundCommand({ projectPath: process.cwd() });
  } else {
    console.log("\n5/5 Playground skipped.");
  }

  console.log("\nInfimium is ready.");
  console.log("Next: connect Cursor, Claude Desktop, Windsurf, or run `infimium serve`.");
}

async function ensureOllamaInstalled(installDeps: boolean): Promise<string> {
  const existing = await findOllamaBinary();
  if (existing) {
    console.log(`Ollama found: ${existing}`);
    return existing;
  }

  if (!installDeps) {
    throw new Error(
      [
        "Ollama is required for local embeddings.",
        `Run: ${ollamaInstallCommand()}`,
        "Then rerun: npx infimium setup",
        "Or run once with dependency install: npx infimium setup --install-deps"
      ].join("\n")
    );
  }

  console.log("Ollama not found. Installing...");
  await runInstallCommand();
  const installed = await findOllamaBinary();
  if (!installed) {
    throw new Error(`Ollama install finished, but binary was not found. Run: ${ollamaInstallCommand()}`);
  }
  return installed;
}

async function ensureOllamaRunning(ollamaBinary: string): Promise<void> {
  if (await canReachOllama()) {
    console.log("Ollama is running.");
    return;
  }

  console.log("Starting Ollama...");
  const child = spawn(ollamaBinary, ["serve"], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(500);
    if (await canReachOllama()) {
      console.log("Ollama is running.");
      return;
    }
  }

  throw new Error(`Ollama did not start. Run: ${quoteCommand(ollamaBinary)} serve`);
}

async function ensureEmbeddingModel(ollamaBinary: string): Promise<void> {
  if (await hasEmbeddingModel()) {
    console.log(`${EMBEDDING_MODEL} is already pulled.`);
    return;
  }

  console.log(`Pulling ${EMBEDDING_MODEL}...`);
  await runCommand(ollamaBinary, ["pull", EMBEDDING_MODEL]);
}

async function findOllamaBinary(): Promise<string | null> {
  if (await commandExists("ollama", ["--version"])) {
    return "ollama";
  }

  if (process.platform === "darwin" && existsSync(MAC_OLLAMA_BINARY)) {
    return MAC_OLLAMA_BINARY;
  }

  return null;
}

async function commandExists(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function canReachOllama(): Promise<boolean> {
  try {
    const response = await fetch(`${DEFAULT_OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(3000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function hasEmbeddingModel(): Promise<boolean> {
  try {
    const response = await fetch(`${DEFAULT_OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) return false;
    const body = await response.json() as {
      models?: Array<{ name?: string; model?: string }>;
    };
    return (body.models ?? []).some((entry) => {
      const name = entry.name ?? entry.model ?? "";
      return name === EMBEDDING_MODEL || name.startsWith(`${EMBEDDING_MODEL}:`);
    });
  } catch {
    return false;
  }
}

async function runInstallCommand(): Promise<void> {
  if (process.platform === "darwin") {
    if (await commandExists("brew", ["--version"])) {
      await runCommand("brew", ["install", "ollama"]);
      return;
    }
    throw new Error("Homebrew is required for automatic Ollama install on macOS. Run: brew install ollama");
  }

  if (process.platform === "win32") {
    await runCommand("winget", ["install", "Ollama.Ollama"]);
    return;
  }

  await runCommand("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"]);
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

function ollamaInstallCommand(): string {
  switch (process.platform) {
    case "darwin":
      return "brew install ollama";
    case "win32":
      return "winget install Ollama.Ollama";
    default:
      return "curl -fsSL https://ollama.com/install.sh | sh";
  }
}

function quoteCommand(command: string): string {
  return command.includes(" ") ? `"${command}"` : command;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
