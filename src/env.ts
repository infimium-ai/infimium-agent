import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { parse as parseDotenv } from "dotenv";

export type ConfigEnvironment = {
  globalPath: string;
  projectPath: string | null;
  loadedFiles: string[];
};

export function loadConfigEnvironment(startPath: string = process.cwd()): ConfigEnvironment {
  const globalPath = resolve(homedir(), ".infimium", ".env");
  const projectPath = findProjectEnv(startPath);
  const values = {
    ...readEnvFile(globalPath),
    ...(projectPath ? readEnvFile(projectPath) : {})
  };

  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return {
    globalPath,
    projectPath,
    loadedFiles: [globalPath, projectPath].filter(
      (filePath): filePath is string => Boolean(filePath && existsSync(filePath))
    )
  };
}

export function findProjectEnv(startPath: string): string | null {
  let currentPath = resolve(startPath);
  while (true) {
    const candidate = resolve(currentPath, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    currentPath = parentPath;
  }
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }

  return parseDotenv(readFileSync(filePath));
}
