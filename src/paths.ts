import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

loadDotenv();

export function dataPath(fileName: string): string {
  const baseDir =
    process.env.INFIMIUM_DATA_DIR?.trim() ||
    process.env.CODEBASE_PATH?.trim() ||
    process.env.LOCAL_DOCS_PATH?.trim();

  return baseDir ? resolve(baseDir, fileName) : resolve(fileName);
}

export function resolveProjectPath(explicitProjectPath?: string | null): string {
  const baseDir =
    explicitProjectPath?.trim() ||
    process.env.CODEBASE_PATH?.trim() ||
    process.env.LOCAL_DOCS_PATH?.trim();

  return baseDir ? resolve(baseDir) : process.cwd();
}
