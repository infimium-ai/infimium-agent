import { loadConfig } from "../config.js";
import { runQueryLocalDocs } from "../tools/query-local-docs.js";

const DEFAULT_TOP_K = 5;

type DocsSearchCliArgs = {
  query: string;
  topK: number;
};

export async function runDocsSearchCommand(args: string[] = process.argv.slice(3)): Promise<void> {
  const parsed = parseDocsSearchCliArgs(args);
  const config = loadConfig({ requireSearchApiKey: false });
  const output = await runQueryLocalDocs(
    {
      localDocsPath: config.localDocsPath,
      ollamaHost: config.ollamaHost
    },
    parsed.query,
    parsed.topK
  );

  console.log(output);
}

function parseDocsSearchCliArgs(args: string[]): DocsSearchCliArgs {
  const queryParts: string[] = [];
  let topK = DEFAULT_TOP_K;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--top-k" || arg === "--limit") {
      topK = Number(readFlagValue(args, index, arg));
      if (!Number.isInteger(topK) || topK <= 0) {
        throw new Error(`${arg} must be a positive integer`);
      }
      index += 1;
      continue;
    }

    queryParts.push(arg);
  }

  const query = queryParts.join(" ").trim();
  if (!query) {
    throw new Error('Missing query. Usage: infimium docs-search "setup instructions"');
  }

  return { query, topK };
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}
