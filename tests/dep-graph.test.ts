import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DepGraphBuilder } from "../src/indexer/dep-graph.js";
import { DepGraphTool } from "../src/tools/dep-graph.js";

const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "property");
const calcFilePath = join(fixturesPath, "services", "property", "calc.ts");

function fakeClient() {
  return {
    getOrCreateCollection: vi.fn().mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        metadatas: [
          {
            name: "calcPropertyValue",
            filePath: calcFilePath,
            lineStart: 1
          }
        ]
      })
    })
  };
}

describe("dep graph", () => {
  let tempDir: string;
  let sqlitePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "infimium-dep-graph-"));
    sqlitePath = join(tempDir, "infimium.db");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("finds files that import a symbol definition", async () => {
    const builder = new DepGraphBuilder(fakeClient(), sqlitePath);
    await builder.buildGraph(fixturesPath);
    builder.close();

    const tool = new DepGraphTool({ sqlitePath, codebasePath: fixturesPath });
    const result = tool.query("calcPropertyValue");
    tool.close();

    expect(result.definedIn).toBe(calcFilePath);
    expect(result.importedBy.some((filePath) => filePath.endsWith("api/routes/listing.ts"))).toBe(true);
    expect(result.importedBy.some((filePath) => filePath.endsWith("utils/tax.ts"))).toBe(true);
  });

  it("returns an empty graph for unknown symbols", async () => {
    const builder = new DepGraphBuilder(fakeClient(), sqlitePath);
    await builder.buildGraph(fixturesPath);
    builder.close();

    const tool = new DepGraphTool({ sqlitePath, codebasePath: fixturesPath });
    const result = tool.query("unknownSymbol");
    tool.close();

    expect(result).toEqual({
      symbol: "unknownSymbol",
      definedIn: null,
      importedBy: [],
      imports: []
    });
  });

  it("resolves TypeScript source files imported with .js specifiers", async () => {
    const sourceRoot = join(tempDir, "source");
    const srcDir = join(sourceRoot, "src");
    const commandsDir = join(srcDir, "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(srcDir, "index.ts"),
      'import { runDoctorCommand } from "./commands/doctor.js";\nexport function main() { return runDoctorCommand(); }\n',
      "utf8"
    );
    await writeFile(
      join(commandsDir, "doctor.ts"),
      'export function runDoctorCommand(): string { return "ok"; }\n',
      "utf8"
    );

    const builder = new DepGraphBuilder(fakeClient(), sqlitePath);
    await builder.buildGraph(sourceRoot);
    builder.close();

    const tool = new DepGraphTool({ sqlitePath, codebasePath: sourceRoot });
    const result = tool.query("runDoctorCommand");
    tool.close();

    expect(result.definedIn).toBe(join(commandsDir, "doctor.ts"));
    expect(result.importedBy).toContain(join(srcDir, "index.ts"));
  });

  it("resolves relative and package imports in a Flutter project", async () => {
    const flutterRoot = join(tempDir, "flutter-app");
    const servicesDir = join(flutterRoot, "lib", "services");
    await mkdir(servicesDir, { recursive: true });
    await writeFile(join(flutterRoot, "pubspec.yaml"), "name: sample_app\n", "utf8");
    await writeFile(
      join(flutterRoot, "lib", "main.dart"),
      "import 'package:sample_app/services/notifications.dart';\nvoid main() {}\n",
      "utf8"
    );
    const notificationsPath = join(servicesDir, "notifications.dart");
    await writeFile(
      notificationsPath,
      "class NotificationService {\n  void initialize() {}\n}\n",
      "utf8"
    );

    const builder = new DepGraphBuilder(fakeClient(), sqlitePath);
    await builder.buildGraph(flutterRoot);
    builder.close();

    const tool = new DepGraphTool({ sqlitePath, codebasePath: flutterRoot });
    const result = tool.query("NotificationService");
    tool.close();

    expect(result.definedIn).toBe(notificationsPath);
    expect(result.importedBy).toContain(join(flutterRoot, "lib", "main.dart"));
  });
});
