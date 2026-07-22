import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { glob } from "glob";
import { parse as parseYaml } from "yaml";

import {
  createProjectFilePolicy,
  filterProjectFiles
} from "../indexer/project-files.js";

const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,py,dart}";
const MAX_SUMMARY_LENGTH = 360;
const MAX_LIST_ITEMS = 12;

export type ProjectOverview = {
  projectId: string;
  name: string;
  path: string;
  repository: string | null;
  branch: string | null;
  summary: string;
  kind: "flutter" | "generic";
  frameworks: string[];
  languages: Array<{
    name: string;
    files: number;
  }>;
  entryPoints: string[];
  modules: string[];
  commands: string[];
  generatedAt: string;
};

type PackageManifest = {
  name?: unknown;
  description?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
};

type PubspecManifest = {
  name?: unknown;
  description?: unknown;
  dependencies?: unknown;
  dev_dependencies?: unknown;
};

export async function readProjectOverview(projectPath: string): Promise<ProjectOverview> {
  const rootPath = resolve(projectPath);
  const [packageManifest, pubspecManifest, readme, sourceFiles] = await Promise.all([
    readJsonFile<PackageManifest>(resolve(rootPath, "package.json")),
    readYamlFile<PubspecManifest>(resolve(rootPath, "pubspec.yaml")),
    readProjectReadme(rootPath),
    findSourceFiles(rootPath)
  ]);
  const repository = readGitValue(rootPath, ["remote", "get-url", "origin"]);
  const branch = readGitValue(rootPath, ["branch", "--show-current"]);
  const manifestName =
    readString(packageManifest?.name) ??
    readString(pubspecManifest?.name) ??
    basename(rootPath);
  const readmeTitle = readme ? firstMarkdownHeading(readme) : null;
  const projectName = isGenericProjectName(manifestName) && readmeTitle
    ? readmeTitle
    : manifestName;
  const manifestDescription =
    readString(packageManifest?.description) ??
    readString(pubspecManifest?.description);
  const dependencies = new Set([
    ...readRecordKeys(packageManifest?.dependencies),
    ...readRecordKeys(packageManifest?.devDependencies),
    ...readRecordKeys(pubspecManifest?.dependencies),
    ...readRecordKeys(pubspecManifest?.dev_dependencies)
  ]);
  const kind = existsSync(resolve(rootPath, "pubspec.yaml")) ? "flutter" : "generic";

  return {
    projectId: createProjectId(rootPath),
    name: projectName,
    path: rootPath,
    repository: repository ? sanitizeRepository(repository) : null,
    branch,
    summary: chooseSummary(readme, manifestDescription, projectName),
    kind,
    frameworks: detectFrameworks(rootPath, dependencies, kind),
    languages: countLanguages(sourceFiles),
    entryPoints: detectEntryPoints(rootPath),
    modules: await detectModules(rootPath),
    commands: readCommands(packageManifest, kind),
    generatedAt: new Date().toISOString()
  };
}

export function createProjectId(projectPath: string): string {
  return createHash("sha256").update(resolve(projectPath)).digest("hex").slice(0, 12);
}

async function findSourceFiles(rootPath: string): Promise<string[]> {
  const policy = await createProjectFilePolicy(rootPath);
  const matches = await glob(SOURCE_GLOB, {
    cwd: policy.rootPath,
    absolute: true,
    nodir: true,
    follow: true,
    ignore: policy.globIgnorePatterns
  });
  return filterProjectFiles(matches, policy);
}

function countLanguages(filePaths: string[]): ProjectOverview["languages"] {
  const counts = new Map<string, number>();
  const names: Record<string, string> = {
    ".dart": "Dart",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".mjs": "JavaScript",
    ".py": "Python",
    ".ts": "TypeScript",
    ".tsx": "TypeScript"
  };

  for (const filePath of filePaths) {
    const name = names[extname(filePath).toLowerCase()];
    if (name) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name));
}

function detectFrameworks(
  rootPath: string,
  dependencies: Set<string>,
  kind: ProjectOverview["kind"]
): string[] {
  const frameworks = new Set<string>();
  if (kind === "flutter") frameworks.add("Flutter");
  if (dependencies.has("supabase_flutter") || dependencies.has("@supabase/supabase-js")) frameworks.add("Supabase");
  if (dependencies.has("firebase_core") || dependencies.has("firebase")) frameworks.add("Firebase");
  if (dependencies.has("next")) frameworks.add("Next.js");
  if (dependencies.has("react")) frameworks.add("React");
  if (dependencies.has("vite")) frameworks.add("Vite");
  if (dependencies.has("express")) frameworks.add("Express");
  if (existsSync(resolve(rootPath, "supabase"))) frameworks.add("Supabase Edge Functions");
  return [...frameworks].slice(0, MAX_LIST_ITEMS);
}

function detectEntryPoints(rootPath: string): string[] {
  const candidates = [
    "lib/main.dart",
    "src/index.ts",
    "src/index.js",
    "src/main.ts",
    "src/main.js",
    "app/page.tsx",
    "index.ts",
    "index.js",
    "main.py"
  ];
  return candidates.filter((filePath) => existsSync(resolve(rootPath, filePath)));
}

async function detectModules(rootPath: string): Promise<string[]> {
  const roots = ["src", "lib", "app", "api", "services", "packages", "supabase"];
  const modules: string[] = [];
  for (const sourceRoot of roots) {
    const absoluteRoot = resolve(rootPath, sourceRoot);
    if (!existsSync(absoluteRoot)) {
      continue;
    }
    modules.push(sourceRoot);
    const entries = await readdir(absoluteRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        modules.push(`${sourceRoot}/${entry.name}`);
      }
    }
  }
  return modules.slice(0, MAX_LIST_ITEMS);
}

function readCommands(
  packageManifest: PackageManifest | null,
  kind: ProjectOverview["kind"]
): string[] {
  const commands: string[] = [];
  if (kind === "flutter") {
    commands.push("flutter pub get", "flutter run", "flutter test");
  }
  if (isRecord(packageManifest?.scripts)) {
    for (const scriptName of Object.keys(packageManifest.scripts)) {
      commands.push(`npm run ${scriptName}`);
    }
  }
  return [...new Set(commands)].slice(0, MAX_LIST_ITEMS);
}

async function readProjectReadme(rootPath: string): Promise<string | null> {
  const entries = await readdir(rootPath).catch(() => []);
  const fileName = entries.find((entry) => /^readme(?:\.md|\.txt)?$/i.test(entry));
  return fileName ? readFile(resolve(rootPath, fileName), "utf8").catch(() => null) : null;
}

function chooseSummary(
  readme: string | null,
  manifestDescription: string | null,
  projectName: string
): string {
  const readmeSummary = readme ? firstReadableParagraph(readme) : null;
  return truncate(readmeSummary ?? manifestDescription ?? `${projectName} project.`, MAX_SUMMARY_LENGTH);
}

function firstReadableParagraph(markdown: string): string | null {
  const blocks = markdown.replace(/```[\s\S]*?```/g, "").split(/\n\s*\n/);
  for (const block of blocks) {
    const text = block
      .split("\n")
      .filter((line) => !line.trim().startsWith("#") && !line.includes("img.shields.io"))
      .join(" ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
      .replace(/[*_`>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length >= 24) {
      return text;
    }
  }
  return null;
}

function firstMarkdownHeading(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.replace(/[*_`]/g, "").trim() || null;
}

function isGenericProjectName(name: string): boolean {
  return new Set(["app", "application", "project", "user", "web"]).has(
    name.trim().toLowerCase()
  );
}

function readGitValue(rootPath: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: rootPath,
    encoding: "utf8",
    timeout: 2_000
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function sanitizeRepository(repository: string): string {
  return repository.replace(/\/\/[^/@]+@/, "//");
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  const contents = await readFile(filePath, "utf8").catch(() => null);
  if (!contents) return null;
  try {
    return JSON.parse(contents) as T;
  } catch {
    return null;
  }
}

async function readYamlFile<T>(filePath: string): Promise<T | null> {
  const contents = await readFile(filePath, "utf8").catch(() => null);
  if (!contents) return null;
  try {
    return parseYaml(contents) as T;
  } catch {
    return null;
  }
}

function readRecordKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}
