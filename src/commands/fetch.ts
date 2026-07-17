import { runFetchUrl } from "../tools/fetch-url.js";

type FetchCliArgs = {
  url: string;
  extract: "markdown" | "text";
};

export async function runFetchCommand(args: string[] = process.argv.slice(3)): Promise<void> {
  const parsed = parseFetchCliArgs(args);
  console.log(await runFetchUrl(parsed.url, parsed.extract));
}

function parseFetchCliArgs(args: string[]): FetchCliArgs {
  const urlParts: string[] = [];
  let extract: "markdown" | "text" = "markdown";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--extract") {
      const value = readFlagValue(args, index, "--extract");
      if (value !== "markdown" && value !== "text") {
        throw new Error('--extract must be "markdown" or "text"');
      }
      extract = value;
      index += 1;
      continue;
    }

    urlParts.push(arg);
  }

  const url = urlParts.join(" ").trim();
  if (!url) {
    throw new Error('Missing URL. Usage: infimium fetch "https://example.com"');
  }

  return { url, extract };
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}
