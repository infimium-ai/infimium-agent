import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { glob } from "glob";

import { loadConfig } from "../config.js";
import { ProjectMemoryStore } from "../memory/project-memory.js";
import { runIndexForPaths, runIndexForProject } from "./index-cmd.js";

const DEFAULT_SCAN_INTERVAL_MS = 5_000;
const DEFAULT_DEBOUNCE_MS = 2_000;

export type WatchIndexOptions = {
  once?: boolean;
  scanIntervalMs?: number;
  debounceMs?: number;
  onLog?: (message: string) => void;
};

export type WatchIndexHandle = {
  stop(): void;
  runNow(): Promise<void>;
};

export async function runWatchCommand(args: string[] = process.argv.slice(3)): Promise<void> {
  const parsed = parseWatchArgs(args);
  const handle = await startAutoIndex({
    scanIntervalMs: parsed.scanIntervalMs,
    debounceMs: parsed.debounceMs,
    onLog: console.log
  });

  if (parsed.once) {
    await handle.runNow();
    handle.stop();
    return;
  }

  console.log("Infimium auto-index running. Press Ctrl+C to stop.");
}

export async function startAutoIndex(options: WatchIndexOptions = {}): Promise<WatchIndexHandle> {
  const config = loadConfig({ requireSearchApiKey: false });
  const onLog = options.onLog ?? (() => undefined);
  const getRoots = (): string[] => {
    const store = new ProjectMemoryStore();
    try {
      return [
        config.localDocsPath,
        config.codebasePath,
        ...store.getKnownProjectPaths()
      ]
        .filter((path): path is string => Boolean(path))
        .map((path) => resolve(path))
        .filter(unique);
    } finally {
      store.close();
    }
  };
  const initialRoots = getRoots();

  if (initialRoots.length === 0) {
    throw new Error("Missing LOCAL_DOCS_PATH or CODEBASE_PATH. Add one to your .env file.");
  }

  let previousFingerprint = await readFingerprint(initialRoots);
  let stopped = false;
  let indexing = false;
  let pending = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  const runNow = async (): Promise<void> => {
    if (indexing) {
      pending = true;
      return;
    }

    indexing = true;
    try {
      const roots = getRoots();
      const configuredCodebasePath = config.codebasePath ? resolve(config.codebasePath) : null;
      onLog("Auto-index: changes detected, indexing...");
      await runIndexForPaths(config, {
        localDocsPath: config.localDocsPath,
        codebasePath: config.codebasePath
      });
      for (const root of roots) {
        if (root !== configuredCodebasePath) {
          await runIndexForProject(root);
        }
      }
      previousFingerprint = await readFingerprint(roots);
      onLog("Auto-index: complete.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      onLog(`Auto-index failed: ${message}`);
    } finally {
      indexing = false;
      if (pending && !stopped) {
        pending = false;
        void runNow();
      }
    }
  };

  const scheduleIndex = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      void runNow();
    }, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    debounceTimer.unref?.();
  };

  const scan = async (): Promise<void> => {
    if (stopped || indexing) {
      return;
    }

    const nextFingerprint = await readFingerprint(getRoots());
    if (nextFingerprint !== previousFingerprint) {
      previousFingerprint = nextFingerprint;
      scheduleIndex();
    }
  };

  const interval = setInterval(() => {
    void scan();
  }, options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS);
  interval.unref?.();

  return {
    stop(): void {
      stopped = true;
      clearInterval(interval);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    },
    runNow
  };
}

function unique(value: string, index: number, array: string[]): boolean {
  return array.indexOf(value) === index;
}

async function readFingerprint(roots: string[]): Promise<string> {
  const files = await findIndexableFiles(roots);
  const entries = await Promise.all(
    files.map(async (filePath) => {
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat) {
        return null;
      }

      return `${filePath}:${Math.trunc(fileStat.mtimeMs)}:${fileStat.size}`;
    })
  );

  return entries
    .filter((entry): entry is string => entry !== null)
    .sort((a, b) => a.localeCompare(b))
    .join("\n");
}

async function findIndexableFiles(roots: string[]): Promise<string[]> {
  const matches = await Promise.all(
    roots.map((root) =>
      glob("**/*.{md,txt,pdf,html,ts,tsx,js,jsx,py}", {
        cwd: root,
        absolute: true,
        nodir: true,
        ignore: [
          "**/node_modules/**",
          "**/.git/**",
          "**/dist/**",
          "**/chroma_db/**",
          "**/*.db",
          "**/*.test.ts",
          "**/*.spec.ts",
          "**/.env",
          "**/.env.*",
          "**/context/layer.md"
        ]
      })
    )
  );

  return [...new Set(matches.flat())];
}

function parseWatchArgs(args: string[]): {
  once: boolean;
  scanIntervalMs: number;
  debounceMs: number;
} {
  let once = false;
  let scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS;
  let debounceMs = DEFAULT_DEBOUNCE_MS;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--once") {
      once = true;
      continue;
    }

    if (arg === "--interval") {
      scanIntervalMs = Number(readFlagValue(args, index, "--interval")) * 1000;
      if (!Number.isFinite(scanIntervalMs) || scanIntervalMs <= 0) {
        throw new Error("--interval must be a positive number of seconds");
      }
      index += 1;
      continue;
    }

    if (arg === "--debounce") {
      debounceMs = Number(readFlagValue(args, index, "--debounce")) * 1000;
      if (!Number.isFinite(debounceMs) || debounceMs <= 0) {
        throw new Error("--debounce must be a positive number of seconds");
      }
      index += 1;
      continue;
    }

    throw new Error(`Unknown watch argument: ${arg}`);
  }

  return {
    once,
    scanIntervalMs,
    debounceMs
  };
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}
