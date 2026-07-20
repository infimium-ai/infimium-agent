import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expandSymbol } from "../src/tools/expand-symbol.js";

const require = createRequire(import.meta.url);

describe("expand_symbol", () => {
  let tempDir: string;
  let sqlitePath: string;
  let sourcePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "infimium-expand-"));
    sqlitePath = join(tempDir, "infimium.db");
    sourcePath = join(tempDir, "src", "calc.ts");
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(
      sourcePath,
      "export function calculatePrice(value: number): number {\n  return value * 1.05;\n}\n",
      "utf8"
    );
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      CREATE TABLE symbol_locations (
        symbol_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line_start INTEGER,
        PRIMARY KEY (symbol_name, file_path)
      );
    `);
    db.prepare(
      "INSERT INTO symbol_locations (symbol_name, file_path, line_start) VALUES (?, ?, ?)"
    ).run("calculatePrice", sourcePath, 1);
    db.close();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns the full implementation only for an explicitly expanded symbol", () => {
    const result = expandSymbol({
      codebasePath: tempDir,
      symbolName: "calculatePrice",
      sqlitePath
    });

    expect(result).toContain("src/calc.ts:1-3");
    expect(result).toContain("return value * 1.05");
  });

  it("does not expand symbols outside the selected project", () => {
    const result = expandSymbol({
      codebasePath: join(tempDir, "other"),
      symbolName: "calculatePrice",
      sqlitePath
    });

    expect(result).toBe("Symbol not found: calculatePrice");
  });
});
