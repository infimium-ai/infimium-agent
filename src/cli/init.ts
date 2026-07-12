import { constants } from "node:fs";
import { access, copyFile } from "node:fs/promises";
import { resolve } from "node:path";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function initEnv(cwd: string = process.cwd()): Promise<void> {
  const envPath = resolve(cwd, ".env");
  const examplePath = resolve(cwd, ".env.example");

  if (await fileExists(envPath)) {
    console.log(".env already exists.");
    return;
  }

  await copyFile(examplePath, envPath);
  console.log("Created .env — add your API keys to get started.");
}

