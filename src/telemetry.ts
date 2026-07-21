import { constants, existsSync, readFileSync } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadConfigEnvironment } from "./env.js";

const TELEMETRY_VERSION = 1;
const INFIMIUM_VERSION = readInfimiumVersion();
const DEFAULT_POSTHOG_ENDPOINT = "https://us.i.posthog.com/capture/";
const DEFAULT_POSTHOG_PROJECT_KEY = "phc_qsitSGmdMwdhYozF3FdXuRoPwH84fRbPrQKZjC6LemH4";
const TELEMETRY_TIMEOUT_MS = 1500;
const TELEMETRY_LOCK_WAIT_MS = 2000;
const TELEMETRY_LOCK_STALE_MS = 30000;

type InstallRecord = {
  installId: string;
  createdAt: number;
  telemetryEnabled?: boolean;
  setupCompletedTracked?: boolean;
  firstToolCallTracked?: boolean;
};

export type TelemetryStatus = {
  enabled: boolean;
  configured: boolean;
  installId: string;
  endpoint: string;
};

type TrackOptions = {
  installPath?: string;
};

export async function trackTelemetry(
  event: string,
  properties: Record<string, string | number | boolean | null> = {},
  options: TrackOptions = {}
): Promise<boolean> {
  loadConfigEnvironment();
  const key = readPostHogKey();
  if (!key) {
    return false;
  }

  const record = await readOrCreateInstallRecord(options.installPath);
  if (!isTelemetryEnabled(record)) {
    return false;
  }

  const payload = {
    api_key: key,
    event,
    distinct_id: record.installId,
    properties: sanitizeProperties(properties)
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  try {
    const response = await fetch(readPostHogEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function trackSetupCompleted(
  properties: Record<string, string | number | boolean | null> = {},
  options: TrackOptions = {}
): Promise<void> {
  await withInstallRecordLock(options.installPath, async (installPath) => {
    const record = await readOrCreateInstallRecord(installPath);
    if (record.setupCompletedTracked) {
      return;
    }

    const sent = await trackTelemetry(
      "setup_completed",
      { ...properties, $insert_id: `${record.installId}:setup_completed` },
      { installPath }
    );
    if (sent) {
      await updateInstallRecord(
        { ...record, setupCompletedTracked: true },
        installPath
      );
    }
  });
}

export async function trackFirstToolCall(
  toolName: string,
  options: TrackOptions = {}
): Promise<void> {
  await withInstallRecordLock(options.installPath, async (installPath) => {
    const record = await readOrCreateInstallRecord(installPath);
    if (record.firstToolCallTracked) {
      return;
    }

    const sent = await trackTelemetry(
      "first_tool_call",
      {
        tool_name: toolName,
        $insert_id: `${record.installId}:first_tool_call`
      },
      { installPath }
    );
    if (sent) {
      await updateInstallRecord(
        { ...record, firstToolCallTracked: true },
        installPath
      );
    }
  });
}

export async function setTelemetryEnabled(
  enabled: boolean,
  installPath?: string
): Promise<void> {
  const record = await readOrCreateInstallRecord(installPath);
  await updateInstallRecord({ ...record, telemetryEnabled: enabled }, installPath);
}

export async function getTelemetryStatus(installPath?: string): Promise<TelemetryStatus> {
  loadConfigEnvironment();
  const record = await readOrCreateInstallRecord(installPath);
  return {
    enabled: isTelemetryEnabled(record),
    configured: Boolean(readPostHogKey()),
    installId: record.installId,
    endpoint: readPostHogEndpoint()
  };
}

export async function runTelemetryCommand(args: string[]): Promise<void> {
  const action = args[0] ?? "status";

  if (action === "on" || action === "enable") {
    await setTelemetryEnabled(true);
    console.log("Infimium telemetry enabled.");
    return;
  }

  if (action === "off" || action === "disable") {
    await setTelemetryEnabled(false);
    console.log("Infimium telemetry disabled.");
    return;
  }

  if (action === "status") {
    const status = await getTelemetryStatus();
    console.log(`Telemetry: ${status.enabled ? "enabled" : "disabled"}`);
    console.log(`PostHog key: ${status.configured ? "configured" : "not configured"}`);
    console.log(`Endpoint: ${status.endpoint}`);
    return;
  }

  throw new Error("Usage: infimium telemetry [status|on|off]");
}

async function readOrCreateInstallRecord(installPath = defaultInstallPath()): Promise<InstallRecord> {
  const existing = await readInstallRecord(installPath);
  if (existing) {
    return existing;
  }

  const record: InstallRecord = {
    installId: randomUUID(),
    createdAt: Date.now()
  };

  await mkdir(dirname(installPath), { recursive: true });
  try {
    await writeFile(installPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    return record;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "EEXIST") {
      const concurrentRecord = await readInstallRecord(installPath);
      if (concurrentRecord) {
        return concurrentRecord;
      }
    }
  }

  // If the existing file is corrupt, replace it with a valid anonymous record.
  await updateInstallRecord(record, installPath);
  return record;
}

async function readInstallRecord(installPath: string): Promise<InstallRecord | null> {
  try {
    const raw = await readFile(installPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<InstallRecord>;
    if (typeof parsed.installId === "string" && typeof parsed.createdAt === "number") {
      return {
        installId: parsed.installId,
        createdAt: parsed.createdAt,
        telemetryEnabled: parsed.telemetryEnabled,
        setupCompletedTracked: parsed.setupCompletedTracked,
        firstToolCallTracked: parsed.firstToolCallTracked
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function updateInstallRecord(record: InstallRecord, installPath = defaultInstallPath()): Promise<void> {
  await mkdir(dirname(installPath), { recursive: true });
  await writeFile(installPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

async function withInstallRecordLock(
  installPath = defaultInstallPath(),
  callback: (installPath: string) => Promise<void>
): Promise<void> {
  const lockPath = `${installPath}.lock`;
  const release = await acquireInstallRecordLock(lockPath);
  if (!release) {
    return;
  }

  try {
    await callback(installPath);
  } finally {
    await release();
  }
}

async function acquireInstallRecordLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  await mkdir(dirname(lockPath), { recursive: true });
  const startedAt = Date.now();

  while (Date.now() - startedAt < TELEMETRY_LOCK_WAIT_MS) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        return null;
      }
      await removeStaleLock(lockPath);
      await sleep(25);
    }
  }

  return null;
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const { mtimeMs } = await stat(lockPath);
    if (Date.now() - mtimeMs > TELEMETRY_LOCK_STALE_MS) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch {
    // Lock disappeared between attempts.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function defaultInstallPath(): string {
  return resolve(homedir(), ".infimium", "install.json");
}

function isTelemetryEnabled(record: InstallRecord): boolean {
  const envValue = process.env.INFIMIUM_TELEMETRY?.trim().toLowerCase();
  if (envValue === "false" || envValue === "0" || envValue === "off" || envValue === "no") {
    return false;
  }

  if (record.telemetryEnabled === false) {
    return false;
  }

  if (envValue === "true" || envValue === "1" || envValue === "on" || envValue === "yes") {
    return true;
  }

  return true;
}

function readPostHogKey(): string {
  return process.env.INFIMIUM_TELEMETRY_POSTHOG_KEY?.trim() || DEFAULT_POSTHOG_PROJECT_KEY;
}

function readPostHogEndpoint(): string {
  return process.env.INFIMIUM_TELEMETRY_ENDPOINT?.trim() || DEFAULT_POSTHOG_ENDPOINT;
}

function sanitizeProperties(
  properties: Record<string, string | number | boolean | null>
): Record<string, string | number | boolean | null> {
  return {
    telemetry_version: TELEMETRY_VERSION,
    infimium_version: INFIMIUM_VERSION,
    os: platform(),
    node_major: Number(process.versions.node.split(".")[0] ?? 0),
    run_source: detectRunSource(),
    ...properties
  };
}

function readInfimiumVersion(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, "../package.json"),
    resolve(moduleDir, "../../package.json")
  ];

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // Fall through to unknown.
    }
  }

  return "unknown";
}

function detectRunSource(): "npx" | "global" | "local" {
  const entrypoint = process.argv[1] ?? "";
  if (entrypoint.includes("_npx")) {
    return "npx";
  }
  if (
    entrypoint.includes("/lib/node_modules/infimium/") ||
    entrypoint.includes("\\node_modules\\infimium\\")
  ) {
    return "global";
  }
  return "local";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function telemetryConfigExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
