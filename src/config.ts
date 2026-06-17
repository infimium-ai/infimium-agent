import { config as loadDotenv } from "dotenv";

loadDotenv();

export interface Config {
  searchApiKey: string;
  searchProvider: "brave" | "serp";
  localDocsPath: string | null;
  codebasePath: string | null;
  shellAllowlist: string[];
}

function readRequiredEnv(
  env: NodeJS.ProcessEnv,
  key: "SEARCH_API_KEY"
): string {
  const value = env[key]?.trim();

  if (!value) {
    throw new Error(`Missing ${key}. Add it to your .env file.`);
  }

  return value;
}

function readSearchProvider(
  env: NodeJS.ProcessEnv
): Config["searchProvider"] {
  const value = env.SEARCH_PROVIDER?.trim();

  if (!value || value === "brave") {
    return "brave";
  }

  if (value === "serp") {
    return "serp";
  }

  throw new Error('Invalid SEARCH_PROVIDER. Expected "brave" or "serp".');
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

  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  return {
    searchApiKey: readRequiredEnv(process.env, "SEARCH_API_KEY"),
    searchProvider: readSearchProvider(process.env),
    localDocsPath: readOptionalPath(process.env, "LOCAL_DOCS_PATH"),
    codebasePath: readOptionalPath(process.env, "CODEBASE_PATH"),
    shellAllowlist: readShellAllowlist(process.env)
  };
}
