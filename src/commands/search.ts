import { loadConfig } from "../config.js";
import { runWebSearch } from "../tools/web-search.js";

const DEFAULT_MAX_RESULTS = 5;

type SearchCliArgs = {
  query: string;
  maxResults: number;
};

export async function runSearchCommand(args: string[] = process.argv.slice(3)): Promise<void> {
  const parsed = parseSearchCliArgs(args);
  const output = await runWebSearch(
    loadConfig({ requireSearchApiKey: true }),
    parsed.query,
    parsed.maxResults
  );

  console.log(output);
}

function parseSearchCliArgs(args: string[]): SearchCliArgs {
  const queryParts: string[] = [];
  let maxResults = DEFAULT_MAX_RESULTS;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--max-results" || arg === "--limit") {
      maxResults = Number(readFlagValue(args, index, arg));
      if (!Number.isInteger(maxResults) || maxResults <= 0) {
        throw new Error(`${arg} must be a positive integer`);
      }
      index += 1;
      continue;
    }

    queryParts.push(arg);
  }

  const query = queryParts.join(" ").trim();
  if (!query) {
    throw new Error('Missing search query. Usage: infimium search "who is Salman Khan"');
  }

  return {
    query,
    maxResults
  };
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}
