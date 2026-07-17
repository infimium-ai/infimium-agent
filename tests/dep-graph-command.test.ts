import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const savedEnv = { ...process.env };

describe("dep-graph command", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "infimium-dep-graph-command-"));
    process.env = {
      ...savedEnv,
      INFIMIUM_DATA_DIR: tempDir,
      CODEBASE_PATH: "/repo"
    };

    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(tempDir, "infimium.db"));
    db.exec(`
      CREATE TABLE symbol_locations (
        symbol_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line_start INTEGER,
        PRIMARY KEY (symbol_name, file_path)
      );
      CREATE TABLE file_imports (
        source_file TEXT NOT NULL,
        imported_file TEXT NOT NULL,
        PRIMARY KEY (source_file, imported_file)
      );
      INSERT INTO symbol_locations VALUES ('runDoctorCommand', '/repo/src/commands/doctor.ts', 1);
      INSERT INTO file_imports VALUES ('/repo/src/index.ts', '/repo/src/commands/doctor.ts');
    `);
    db.close();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it("prints a graph for a symbol", async () => {
    const { runDepGraphCommand } = await import("../src/commands/dep-graph.js");
    const logMock = vi.spyOn(console, "log").mockImplementation(() => {});

    await runDepGraphCommand(["runDoctorCommand"]);

    const output = String(logMock.mock.calls[0]?.[0]);
    expect(output).toContain("Symbol: runDoctorCommand()");
    expect(output).toContain("Defined in: src/commands/doctor.ts");
    expect(output).toContain("→ src/index.ts");
  });
});
