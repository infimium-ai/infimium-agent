import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readProjectOverview } from "../src/memory/project-overview.js";

describe("project overview", () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), "infimium-overview-"));
    await mkdir(join(projectPath, "lib", "services"), { recursive: true });
    await mkdir(join(projectPath, "build", "generated"), { recursive: true });
    await writeFile(
      join(projectPath, "pubspec.yaml"),
      [
        "name: meals_app",
        "description: A meal ordering application.",
        "dependencies:",
        "  flutter:",
        "    sdk: flutter",
        "  supabase_flutter: ^2.0.0"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectPath, "README.md"),
      "# Meals App\n\nA Flutter meal ordering client backed by Supabase.\n",
      "utf8"
    );
    await writeFile(join(projectPath, "lib", "main.dart"), "void main() {}\n", "utf8");
    await writeFile(
      join(projectPath, "build", "generated", "plugin.dart"),
      "void generated() {}\n",
      "utf8"
    );
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it("summarizes the active project without generated files", async () => {
    const overview = await readProjectOverview(projectPath);

    expect(overview.name).toBe("meals_app");
    expect(overview.summary).toContain("meal ordering client");
    expect(overview.frameworks).toEqual(["Flutter", "Supabase"]);
    expect(overview.languages).toEqual([{ name: "Dart", files: 1 }]);
    expect(overview.entryPoints).toContain("lib/main.dart");
    expect(overview.modules).toContain("lib/services");
    expect(overview.projectId).toHaveLength(12);
  });

  it("detects languages when the project is opened through a symlink", async () => {
    const linkedPath = join(projectPath, "..", `linked-${Date.now()}`);
    await symlink(projectPath, linkedPath, "dir");
    try {
      const overview = await readProjectOverview(linkedPath);
      expect(overview.languages).toEqual([{ name: "Dart", files: 1 }]);
    } finally {
      await rm(linkedPath, { force: true });
    }
  });
});
