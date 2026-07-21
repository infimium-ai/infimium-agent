import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { setTelemetryEnabled, trackTelemetry } from "../telemetry.js";

function defaultConfig(telemetryEnabled: boolean): string {
  return `SEARCH_API_KEY=
SEARCH_PROVIDER=tinyfish
LOCAL_DOCS_PATH=
CODEBASE_PATH=
OLLAMA_HOST=http://localhost:11434
SHELL_ALLOWLIST=ls,git,pwd,npm,npx
INFIMIUM_AUTO_INDEX=true
INFIMIUM_TELEMETRY=${telemetryEnabled ? "true" : "false"}
`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function initEnv(
  configDir: string = resolve(homedir(), ".infimium"),
  options: { telemetryEnabled?: boolean; telemetryInstallPath?: string } = {}
): Promise<void> {
  const telemetryEnabled = options.telemetryEnabled ?? true;
  await setTelemetryEnabled(telemetryEnabled, options.telemetryInstallPath);
  if (telemetryEnabled) {
    await trackTelemetry("init_started", {}, { installPath: options.telemetryInstallPath });
  }

  const envPath = resolve(configDir, ".env");

  if (await fileExists(envPath)) {
    console.log(`Infimium config already exists: ${envPath}`);
    if (telemetryEnabled) {
      await trackTelemetry(
        "init_completed",
        { already_exists: true },
        { installPath: options.telemetryInstallPath }
      );
    }
    return;
  }

  await mkdir(configDir, { recursive: true });
  await writeFile(envPath, defaultConfig(telemetryEnabled), { encoding: "utf8", mode: 0o600 });
  console.log(`Created global Infimium config: ${envPath}`);
  console.log("Web search is optional; add SEARCH_API_KEY when you need it.");
  if (telemetryEnabled) {
    await trackTelemetry(
      "init_completed",
      { already_exists: false },
      { installPath: options.telemetryInstallPath }
    );
  }
}
