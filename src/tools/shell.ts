import { spawn } from "node:child_process";

import type { Config } from "../config.js";

export type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

const OUTPUT_LIMIT = 10_000;
const DEFAULT_TIMEOUT_SECONDS = 30;
const BLOCKED_PATTERNS = [
  new RegExp(String.raw`\brm\s+-rf\b`, "i"),
  new RegExp(String.raw`\bsudo\b`, "i"),
  new RegExp(String.raw`\bcurl\b`, "i"),
  new RegExp(String.raw`\bwget\b`, "i"),
  new RegExp(String.raw`\bnc\b`, "i"),
  new RegExp(String.raw`\bnetcat\b`, "i"),
  new RegExp(String.raw`\bpython\s+-c\b`, "i"),
  new RegExp(String.raw`\bnode\s+-e\b`, "i"),
  new RegExp(String.raw`\beval\b`, "i"),
  new RegExp(String.raw`\bexec\b`, "i")
];

export class ShellTool {
  constructor(private readonly config: Pick<Config, "shellAllowlist">) {}

  async run(
    command: string,
    cwd?: string,
    timeout: number = DEFAULT_TIMEOUT_SECONDS
  ): Promise<ShellResult> {
    const trimmedCommand = command.trim();
    const baseCommand = extractBaseCommand(trimmedCommand);

    if (!baseCommand || this.isBlocked(trimmedCommand) || !this.isAllowed(baseCommand)) {
      return blockedResult(baseCommand || trimmedCommand, this.config.shellAllowlist);
    }

    const parts = splitCommand(trimmedCommand);
    if (parts.length === 0) {
      return blockedResult(trimmedCommand, this.config.shellAllowlist);
    }

    return spawnCommand(parts[0], parts.slice(1), cwd, timeout);
  }

  private isAllowed(baseCommand: string): boolean {
    return this.config.shellAllowlist.includes(baseCommand);
  }

  private isBlocked(command: string): boolean {
    return BLOCKED_PATTERNS.some((pattern) => pattern.test(command));
  }
}

function extractBaseCommand(command: string): string {
  return command.split(/\s+/)[0]?.replace(/^["']|["']$/g, "") ?? "";
}

function blockedResult(command: string, allowlist: string[]): ShellResult {
  return {
    stdout: "",
    stderr: `Command not allowed: ${command}. Allowed: ${allowlist.join(", ")}`,
    exitCode: 1,
    durationMs: 0
  };
}

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (const char of command) {
    if ((char === "'" || char === '"') && quote === null) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (/\s/.test(char) && quote === null) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}

function spawnCommand(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeout: number
): Promise<ShellResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutSeconds = Math.max(timeout, 1);
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutSeconds * 1_000);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let didTimeout = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: cwd ?? process.cwd(),
      env: process.env,
      signal: controller.signal
    });

    controller.signal.addEventListener("abort", () => {
      didTimeout = true;
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: capOutput(stdout, "stdout"),
        stderr: didTimeout || isAbortError(error) ? `Command timed out after ${timeoutSeconds} seconds` : error.message,
        exitCode: 1,
        durationMs: Date.now() - start
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: capOutput(stdout, "stdout"),
        stderr: capOutput(
          didTimeout ? appendWithNewline(stderr, `Command timed out after ${timeoutSeconds} seconds`) : stderr,
          "stderr"
        ),
        exitCode: didTimeout ? 1 : code ?? 0,
        durationMs: Date.now() - start
      });
    });
  });
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError" || error.message.toLowerCase().includes("abort");
}

function appendWithNewline(value: string, suffix: string): string {
  return value.length > 0 ? `${value}
${suffix}` : suffix;
}

function capOutput(value: string, streamName: "stdout" | "stderr"): string {
  if (value.length <= OUTPUT_LIMIT) {
    return value;
  }

  return `${value.slice(0, OUTPUT_LIMIT)}\n[${streamName} truncated at 10,000 chars]`;
}

export function formatShellResult(result: ShellResult): string {
  return [
    `Exit code: ${result.exitCode}`,
    `Duration: ${result.durationMs}ms`,
    "STDOUT:",
    result.stdout,
    "STDERR:",
    result.stderr
  ].join("\n");
}

export async function runShell(
  config: Pick<Config, "shellAllowlist">,
  command: string,
  cwd?: string,
  timeout?: number
): Promise<ShellResult> {
  const tool = new ShellTool(config);

  return tool.run(command, cwd, timeout);
}
