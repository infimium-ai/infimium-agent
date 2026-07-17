import { loadConfig } from "../config.js";
import { runSemanticCodeSearch } from "../tools/semantic-code-search.js";

const DEFAULT_TOP_K = 5;

type CodeSearchCliArgs = {
  query: string;
  language?: string;
  topK: number;
};

export async function runCodeSearchCommand(args: string[] = process.argv.slice(3)): Promise<void> {
  const parsed = parseCodeSearchCliArgs(args);
  const config = loadConfig({ requireSearchApiKey: false });
  const output = await runSemanticCodeSearch(
    {
      codebasePath: config.codebasePath ?? process.cwd(),
      ollamaHost: config.ollamaHost
    },
    parsed.query,
    parsed.language,
    parsed.topK
  );

  console.log(output);
}

function parseCodeSearchCliArgs(args: string[]): CodeSearchCliArgs {
  const queryParts: string[] = [];
  let language: string | undefined;
  let topK = DEFAULT_TOP_K;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--language" || arg === "--lang") {
      language = readFlagValue(args, index, arg);
      index += 1;
      continue;
    }

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
    throw new Error('Missing query. Usage: infimium code-search "price calculation logic"');
  }

  return { query, language, topK };
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}
