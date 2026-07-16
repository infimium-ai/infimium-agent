import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { config as loadDotenv } from "dotenv";

import { dataPath } from "../paths.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const DEFAULT_CHROMADB_HOST = "http://localhost:8000";
const CHECK_TIMEOUT_MS = 3000;

type DoctorStatus = "pass" | "fail";

export type DoctorCheck = {
  name: string;
  status: DoctorStatus;
  detail: string;
  fixCommand?: string;
};

type PackageJson = {
  name?: string;
  engines?: {
    node?: string;
    npm?: string;
  };
};

type OllamaTagsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
};

type Database = import("node:sqlite").DatabaseSync;

type NumberRow = {
  count?: number | bigint | null;
};

export async function runDoctorCommand(): Promise<void> {
  const checks = await collectDoctorChecks();
  console.log(formatDoctorReport(checks));
  process.exitCode = checks.every((check) => check.status === "pass") ? 0 : 1;
}

export async function collectDoctorChecks(): Promise<DoctorCheck[]> {
  loadDotenv();

  const packageJson = await readInfimiumPackageJson();
  const ollamaHost = normalizeBaseUrl(process.env.OLLAMA_HOST, DEFAULT_OLLAMA_HOST);
  const chromadbHost = normalizeBaseUrl(process.env.CHROMADB_HOST, DEFAULT_CHROMADB_HOST);

  return [
    await checkNodeAndNpm(packageJson),
    await checkOllama(ollamaHost),
    await checkEmbeddingModel(ollamaHost),
    await checkChromaDb(chromadbHost),
    checkConfigEnv(),
    checkIndexStatus()
  ];
}

export function formatDoctorReport(checks: DoctorCheck[]): string {
  const lines = checks.flatMap((check, index) => {
    const mark = check.status === "pass" ? "✅" : "❌";
    const output = [`${index + 1}. ${mark} ${check.name}`, `   ${check.detail}`];

    if (check.status === "fail" && check.fixCommand) {
      output.push(`   Fix: ${check.fixCommand}`);
    }

    return output;
  });

  const passed = checks.filter((check) => check.status === "pass").length;
  const nextCommand =
    checks.find((check) => check.status === "fail")?.fixCommand ?? "npx infimium status";

  return [...lines, `Summary: ${passed}/${checks.length} checks passed — ${nextCommand}`].join("\n");
}

async function checkNodeAndNpm(packageJson: PackageJson): Promise<DoctorCheck> {
  const nodeEngine = packageJson.engines?.node ?? ">=22.5.0";
  const npmEngine = packageJson.engines?.npm;
  const nodeVersion = process.versions.node;
  const nodeOk = satisfiesEngine(nodeVersion, nodeEngine);
  const npmVersion = await readCommandVersion("npm", ["--version"]);
  const npmOk = npmVersion !== null && (!npmEngine || satisfiesEngine(npmVersion, npmEngine));

  if (nodeOk && npmOk) {
    const npmDetail = npmEngine
      ? `npm ${npmVersion} satisfies ${npmEngine}`
      : `npm ${npmVersion} found`;
    return pass("Node/npm version", `Node ${nodeVersion} satisfies ${nodeEngine}; ${npmDetail}.`);
  }

  const npmDetail = npmVersion === null ? "npm was not found" : `npm ${npmVersion}`;
  return fail(
    "Node/npm version",
    `Node ${nodeVersion} does not satisfy ${nodeEngine}, or ${npmDetail} is not usable.`,
    nodeUpgradeCommand()
  );
}

async function checkOllama(ollamaHost: string): Promise<DoctorCheck> {
  const binaryExists = await commandExists("ollama");
  if (!binaryExists) {
    return fail(
      "Ollama",
      "Ollama binary is not installed or not available on PATH.",
      ollamaInstallCommand()
    );
  }

  const response = await fetchJson<OllamaTagsResponse>(`${ollamaHost}/api/tags`);

  if (response.ok) {
    return pass("Ollama", `Ollama is installed and the API is reachable at ${ollamaHost}.`);
  }

  return fail("Ollama", `Ollama is installed but not running at ${ollamaHost}.`, "ollama serve");
}

async function checkEmbeddingModel(ollamaHost: string): Promise<DoctorCheck> {
  const binaryExists = await commandExists("ollama");
  if (!binaryExists) {
    return fail(
      "Required embedding model",
      `Cannot check ${EMBEDDING_MODEL} because Ollama is not installed.`,
      ollamaInstallCommand()
    );
  }

  const response = await fetchJson<OllamaTagsResponse>(`${ollamaHost}/api/tags`);

  if (!response.ok) {
    return fail(
      "Required embedding model",
      `Cannot check ${EMBEDDING_MODEL} because Ollama is not reachable.`,
      "ollama serve"
    );
  }

  const models = response.data.models ?? [];
  const hasModel = models.some((entry) => {
    const name = entry.name ?? entry.model ?? "";
    return name === EMBEDDING_MODEL || name.startsWith(`${EMBEDDING_MODEL}:`);
  });

  if (hasModel) {
    return pass("Required embedding model", `${EMBEDDING_MODEL} is pulled locally.`);
  }

  return fail(
    "Required embedding model",
    `${EMBEDDING_MODEL} is not installed in Ollama.`,
    `ollama pull ${EMBEDDING_MODEL}`
  );
}

async function checkChromaDb(chromadbHost: string): Promise<DoctorCheck> {
  const heartbeatUrls = [
    `${chromadbHost}/api/v2/heartbeat`,
    `${chromadbHost}/api/v1/heartbeat`
  ];

  for (const url of heartbeatUrls) {
    const response = await fetchText(url);
    if (response.ok) {
      return pass("ChromaDB", `ChromaDB is reachable at ${chromadbHost}.`);
    }
  }

  return fail(
    "ChromaDB",
    `ChromaDB is not reachable at ${chromadbHost}.`,
    "docker run -d --name infimium-chromadb -p 8000:8000 -v chroma_data:/chroma/chroma chromadb/chroma:latest"
  );
}

function checkConfigEnv(): DoctorCheck {
  const envPath = resolve(process.cwd(), ".env");
  const missing: string[] = [];

  if (!existsSync(envPath)) {
    return fail(
      "Config/env",
      ".env is missing in the current project.",
      "cp .env.example .env"
    );
  }

  const requiredEnv = [
    "SEARCH_API_KEY",
    "SEARCH_PROVIDER",
    "OLLAMA_HOST",
    "CHROMADB_HOST",
    "SHELL_ALLOWLIST"
  ] as const;

  for (const key of requiredEnv) {
    if (!process.env[key]?.trim()) {
      missing.push(key);
    }
  }

  if (!process.env.LOCAL_DOCS_PATH?.trim() && !process.env.CODEBASE_PATH?.trim()) {
    missing.push("LOCAL_DOCS_PATH or CODEBASE_PATH");
  }

  if (missing.length === 0) {
    return pass("Config/env", ".env exists and required values are set.");
  }

  return fail(
    "Config/env",
    `Missing: ${missing.join(", ")}.`,
    "printf '\\nSEARCH_API_KEY=your_brave_search_api_key\\nSEARCH_PROVIDER=brave\\nLOCAL_DOCS_PATH=./docs\\nCODEBASE_PATH=.\\nOLLAMA_HOST=http://localhost:11434\\nCHROMADB_HOST=http://localhost:8000\\nSHELL_ALLOWLIST=ls,git,npm,npx\\n' >> .env"
  );
}

function checkIndexStatus(): DoctorCheck {
  const codeDbPath = resolve(dataPath("infimium_code.db"));
  const targetRepoPath = resolve(process.env.CODEBASE_PATH?.trim() || process.cwd());

  if (!existsSync(codeDbPath)) {
    return fail(
      "Index status",
      `No code index database found for current repo: ${targetRepoPath}.`,
      "npx infimium index"
    );
  }

  try {
    const indexedFiles = readIndexedFileCount(codeDbPath, targetRepoPath);

    if (indexedFiles > 0) {
      return pass(
        "Index status",
        `Found ${indexedFiles} indexed file(s) for current repo: ${targetRepoPath}.`
      );
    }

    return fail(
      "Index status",
      `Index database exists, but no files are indexed for current repo: ${targetRepoPath}.`,
      "npx infimium index"
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(
      "Index status",
      `Could not read code index for current repo: ${message}.`,
      "npx infimium index"
    );
  }
}

function readIndexedFileCount(dbPath: string, targetRepoPath: string): number {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    if (!tableExists(db, "indexed_code_files")) {
      return 0;
    }

    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM indexed_code_files
         WHERE file_path = ? OR file_path LIKE ?`
      )
      .get(targetRepoPath, `${targetRepoPath}/%`) as NumberRow | undefined;

    return readCount(row);
  } finally {
    db.close();
  }
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);

  return row !== undefined;
}

function readCount(row: NumberRow | undefined): number {
  const value = row?.count;
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  return 0;
}

function pass(name: string, detail: string): DoctorCheck {
  return { name, status: "pass", detail };
}

function fail(name: string, detail: string, fixCommand: string): DoctorCheck {
  return { name, status: "fail", detail, fixCommand };
}

async function readCommandVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: CHECK_TIMEOUT_MS });
    return stdout.trim().split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

async function commandExists(command: string): Promise<boolean> {
  return (await readCommandVersion(command, ["--version"])) !== null;
}

async function fetchJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false }> {
  const response = await fetchWithTimeout(url);
  if (!response?.ok) {
    return { ok: false };
  }

  try {
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false };
  }
}

async function fetchText(url: string): Promise<{ ok: boolean }> {
  const response = await fetchWithTimeout(url);
  return { ok: response?.ok ?? false };
}

async function fetchWithTimeout(url: string): Promise<Response | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    return await fetch(url, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  const withProtocol = raw.includes("://") ? raw : `http://${raw}`;
  return withProtocol.replace(/\/+$/, "");
}

async function readInfimiumPackageJson(): Promise<PackageJson> {
  const packageRoot = await findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const packageJsonPath = resolve(packageRoot, "package.json");
  const raw = await readFile(packageJsonPath, "utf8");
  return JSON.parse(raw) as PackageJson;
}

async function findPackageRoot(startDir: string): Promise<string> {
  let currentDir = startDir;

  for (;;) {
    const packageJsonPath = resolve(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const raw = await readFile(packageJsonPath, "utf8");
        const parsed = JSON.parse(raw) as PackageJson;
        if (parsed.name === "infimium") {
          return currentDir;
        }
      } catch {
        // Keep walking upward.
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return process.cwd();
    }

    currentDir = parentDir;
  }
}

function satisfiesEngine(version: string, engine: string): boolean {
  const parsedVersion = parseVersion(version);
  const match = engine.trim().match(/^(>=|>|<=|<|=)?\s*v?(\d+(?:\.\d+){0,2})/);

  if (!parsedVersion || !match) {
    return false;
  }

  const operator = match[1] ?? "=";
  const target = parseVersion(match[2]);
  if (!target) {
    return false;
  }

  const comparison = compareVersions(parsedVersion, target);

  switch (operator) {
    case ">=":
      return comparison >= 0;
    case ">":
      return comparison > 0;
    case "<=":
      return comparison <= 0;
    case "<":
      return comparison < 0;
    case "=":
      return comparison === 0;
    default:
      return false;
  }
}

function parseVersion(version: string): [number, number, number] | null {
  const parts = version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number(part.replace(/\D.*$/, "")));

  if (parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareVersions(
  left: [number, number, number],
  right: [number, number, number]
): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] > right[index]) {
      return 1;
    }

    if (left[index] < right[index]) {
      return -1;
    }
  }

  return 0;
}

function nodeUpgradeCommand(): string {
  switch (process.platform) {
    case "darwin":
      return "brew install node@24 && brew link --overwrite node@24";
    case "win32":
      return "winget install OpenJS.NodeJS.LTS";
    default:
      return "curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs";
  }
}

function ollamaInstallCommand(): string {
  switch (process.platform) {
    case "darwin":
      return "brew install ollama && ollama serve";
    case "win32":
      return "winget install Ollama.Ollama && ollama serve";
    default:
      return "curl -fsSL https://ollama.com/install.sh | sh && ollama serve";
  }
}
