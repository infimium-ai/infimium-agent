import { constants } from "node:fs";
import { access, copyFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function initEnv(): Promise<void> {
  const envPath = path.resolve(process.cwd(), ".env");
  const envExamplePath = path.resolve(process.cwd(), ".env.example");

  if (await fileExists(envPath)) {
    console.log(".env already exists.");
    return;
  }

  await copyFile(envExamplePath, envPath);
  console.log("Created .env \u2014 add your API keys to get started.");
}

async function main(): Promise<void> {
  await initEnv();
}

const entryPoint = process.argv[1];

if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error("Failed to initialize environment:", error);
    process.exitCode = 1;
  });
}
