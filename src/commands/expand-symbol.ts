import { loadConfig } from "../config.js";
import { resolveMemoryProjectPath } from "./memory.js";
import { expandSymbol } from "../tools/expand-symbol.js";

export async function runExpandSymbolCommand(
  args: string[] = process.argv.slice(3)
): Promise<void> {
  const parsed = parseArgs(args);
  const config = loadConfig({ requireSearchApiKey: false });
  console.log(
    expandSymbol({
      codebasePath: resolveMemoryProjectPath(parsed.projectPath ?? config.codebasePath),
      symbolName: parsed.symbolName,
      filePath: parsed.filePath
    })
  );
}

function parseArgs(args: string[]): {
  symbolName: string;
  filePath?: string;
  projectPath?: string;
} {
  const symbolName = args[0]?.trim();
  if (!symbolName || symbolName.startsWith("--")) {
    throw new Error('Missing symbol name. Usage: infimium expand-symbol "symbolName"');
  }
  let filePath: string | undefined;
  let projectPath: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--file") {
      filePath = readValue(args, ++index, "--file");
      continue;
    }
    if (arg === "--project") {
      projectPath = readValue(args, ++index, "--project");
      continue;
    }
    throw new Error(`Unknown expand-symbol argument: ${arg}`);
  }
  return { symbolName, filePath, projectPath };
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
