import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { loadConfigEnvironment } from "./env.js";

const TELEMETRY_VERSION = 1;
const INFIMIUM_VERSION = "0.4.1";
const DEFAULT_POSTHOG_ENDPOINT = "https://us.i.posthog.com/capture/";
const DEFAULT_POSTHOG_PROJECT_KEY = "phc_qsitSGmdMwdhYozF3FdXuRoPwH84fRbPrQKZjC6LemH4";
const TELEMETRY_TIMEOUT_MS = 1500;

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
  const record = await readOrCreateInstallRecord(options.installPath);
  if (record.setupCompletedTracked) {
    return;
  }

  const sent = await trackTelemetry("setup_completed", properties, options);
  if (sent) {
    await updateInstallRecord(
      { ...record, setupCompletedTracked: true },
      options.installPath
    );
  }
}

export async function trackFirstToolCall(
  toolName: string,
  options: TrackOptions = {}
): Promise<void> {
  const record = await readOrCreateInstallRecord(options.installPath);
  if (record.firstToolCallTracked) {
    return;
  }

  const sent = await trackTelemetry("first_tool_call", { tool_name: toolName }, options);
  if (sent) {
    await updateInstallRecord(
      { ...record, firstToolCallTracked: true },
      options.installPath
    );
  }
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
    // Create a fresh anonymous install record below.
  }

  const record: InstallRecord = {
    installId: randomUUID(),
    createdAt: Date.now()
  };
  await updateInstallRecord(record, installPath);
  return record;
}

async function updateInstallRecord(record: InstallRecord, installPath = defaultInstallPath()): Promise<void> {
  await mkdir(dirname(installPath), { recursive: true });
  await writeFile(installPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
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
    ...properties
  };
}

export async function telemetryConfigExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
