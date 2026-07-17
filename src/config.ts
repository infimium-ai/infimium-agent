import { config as loadDotenv } from "dotenv";

loadDotenv();

export interface Config {
  searchApiKey: string;
  searchProvider: "tinyfish" | "brave" | "serp";
  localDocsPath: string | null;
  codebasePath: string | null;
  ollamaHost: string;
  shellAllowlist: string[];
}

type LoadConfigOptions = {
  requireSearchApiKey?: boolean;
};

function readRequiredEnv(env: NodeJS.ProcessEnv, key: "SEARCH_API_KEY"): string {
  const value = env[key]?.trim();

  if (!value) {
    throw new Error(`Missing ${key}. Add it to your .env file.`);
  }

  return value;
}

function readSearchApiKey(env: NodeJS.ProcessEnv, required: boolean): string {
  if (required) {
    return readRequiredEnv(env, "SEARCH_API_KEY");
  }

  return env.SEARCH_API_KEY?.trim() ?? "";
}

function readSearchProvider(env: NodeJS.ProcessEnv): Config["searchProvider"] {
  const value = env.SEARCH_PROVIDER?.trim();

  if (!value || value === "tinyfish") {
    return "tinyfish";
  }

  if (value === "brave") {
    return "brave";
  }

  if (value === "serp") {
    return "serp";
  }

  throw new Error('Invalid SEARCH_PROVIDER. Expected "tinyfish", "brave", or "serp".');
}

function readOptionalPath(
  env: NodeJS.ProcessEnv,
  key: "LOCAL_DOCS_PATH" | "CODEBASE_PATH"
): string | null {
  const value = env[key]?.trim();

  return value ? value : null;
}

function readShellAllowlist(env: NodeJS.ProcessEnv): string[] {
  const value = env.SHELL_ALLOWLIST?.trim();

  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readOllamaHost(env: NodeJS.ProcessEnv): string {
  return env.OLLAMA_HOST?.trim() || "http://localhost:11434";
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const requireSearchApiKey = options.requireSearchApiKey ?? true;

  return {
    searchApiKey: readSearchApiKey(process.env, requireSearchApiKey),
    searchProvider: readSearchProvider(process.env),
    localDocsPath: readOptionalPath(process.env, "LOCAL_DOCS_PATH"),
    codebasePath: readOptionalPath(process.env, "CODEBASE_PATH"),
    ollamaHost: readOllamaHost(process.env),
    shellAllowlist: readShellAllowlist(process.env)
  };
}
