import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

import createIgnore, { type Ignore } from "ignore";

const COMMON_IGNORE_GLOBS = [
  "**/.git/**",
  "**/.hg/**",
  "**/.svn/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/chroma_db/**",
  "**/DerivedData/**",
  "**/*.framework/**",
  "**/*.app/**",
  "**/*.xcarchive/**",
  "**/.env",
  "**/.env.*",
  "**/*.db",
  "**/context/layer.md"
] as const;

const FLUTTER_IGNORE_GLOBS = [
  "**/.dart_tool/**",
  "**/ios/Pods/**",
  "**/ios/.symlinks/**",
  "**/ios/Flutter/ephemeral/**",
  "**/macos/Flutter/ephemeral/**",
  "**/Flutter/Generated.xcconfig",
  "**/Flutter/flutter_export_environment.sh",
  "**/Flutter/Flutter.podspec",
  "**/xcshareddata/swiftpm/**",
  "**/GeneratedPluginRegistrant.*",
  "**/generated_plugin_registrant.*",
  "**/generated_plugins.cmake",
  "**/android/.gradle/**",
  "**/android/.kotlin/**",
  "**/android/build/**",
  "**/.firebase/**",
  "**/supabase/.temp/**"
] as const;

const BLOCKED_EXTENSIONS = new Set([
  ".a",
  ".app",
  ".bin",
  ".class",
  ".dylib",
  ".framework",
  ".jar",
  ".lock",
  ".o",
  ".pyc",
  ".so",
  ".wasm",
  ".xcarchive",
  ".zip"
]);

export type ProjectKind = "flutter" | "generic";

export type ProjectFilePolicy = {
  rootPath: string;
  kind: ProjectKind;
  globIgnorePatterns: string[];
  isIgnored(filePath: string): boolean;
};

export async function createProjectFilePolicy(
  projectPath: string
): Promise<ProjectFilePolicy> {
  const rootPath = resolve(projectPath);
  const canonicalRootPath = canonicalProjectPath(rootPath);
  const kind: ProjectKind = existsSync(resolve(rootPath, "pubspec.yaml"))
    ? "flutter"
    : "generic";
  const globIgnorePatterns = [
    ...COMMON_IGNORE_GLOBS,
    ...(kind === "flutter" ? FLUTTER_IGNORE_GLOBS : [])
  ];
  const matcher = await loadIgnoreMatcher(rootPath);

  return {
    rootPath,
    kind,
    globIgnorePatterns,
    isIgnored(filePath: string): boolean {
      const absolutePath = resolve(filePath);
      const requestedRelativePath = normalizePath(relative(rootPath, absolutePath));
      const relativePath = isWithinRoot(requestedRelativePath)
        ? requestedRelativePath
        : normalizePath(relative(canonicalRootPath, canonicalProjectPath(absolutePath)));
      if (!relativePath || relativePath.startsWith("../")) {
        return relativePath.startsWith("../");
      }

      return (
        isBlockedExtension(relativePath) ||
        isBlockedBundlePath(relativePath) ||
        matcher.ignores(relativePath)
      );
    }
  };
}

function isWithinRoot(relativePath: string): boolean {
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith("../"));
}

function canonicalProjectPath(projectPath: string): string {
  const resolvedPath = resolve(projectPath);
  try {
    return realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

export function filterProjectFiles(
  filePaths: string[],
  policy: ProjectFilePolicy
): string[] {
  return filePaths
    .filter((filePath) => !policy.isIgnored(filePath))
    .sort((left, right) => left.localeCompare(right));
}

async function loadIgnoreMatcher(rootPath: string): Promise<Ignore> {
  const matcher = createIgnore();
  matcher.add(COMMON_IGNORE_GLOBS.map(toIgnorePattern));

  if (existsSync(resolve(rootPath, "pubspec.yaml"))) {
    matcher.add(FLUTTER_IGNORE_GLOBS.map(toIgnorePattern));
  }

  for (const fileName of [".gitignore", ".infimiumignore"]) {
    const contents = await readFile(resolve(rootPath, fileName), "utf8").catch(
      () => null
    );
    if (contents) {
      matcher.add(contents);
    }
  }

  return matcher;
}

function toIgnorePattern(pattern: string): string {
  return pattern.replace(/^\*\*\//, "").replace(/\/\*\*$/, "/");
}

function isBlockedExtension(relativePath: string): boolean {
  return BLOCKED_EXTENSIONS.has(extname(relativePath).toLowerCase());
}

function isBlockedBundlePath(relativePath: string): boolean {
  const segments = normalizePath(relativePath).split("/");
  return segments.some((segment) => {
    const extension = extname(segment).toLowerCase();
    return extension === ".framework" || extension === ".app" || extension === ".xcarchive";
  });
}

function normalizePath(filePath: string): string {
  return sep === "/" ? filePath : filePath.split(sep).join("/");
}
