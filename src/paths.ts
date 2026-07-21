import { homedir } from "node:os";
import { resolve } from "node:path";

import { loadConfigEnvironment } from "./env.js";

export function dataPath(fileName: string): string {
  loadConfigEnvironment();
  const baseDir = process.env.INFIMIUM_DATA_DIR?.trim() || resolve(homedir(), ".infimium", "data");

  return resolve(baseDir, fileName);
}

export function resolveProjectPath(explicitProjectPath?: string | null): string {
  loadConfigEnvironment();
  const baseDir =
    explicitProjectPath?.trim() ||
    process.env.CODEBASE_PATH?.trim() ||
    process.env.LOCAL_DOCS_PATH?.trim();

  return baseDir ? resolve(baseDir) : process.cwd();
}
