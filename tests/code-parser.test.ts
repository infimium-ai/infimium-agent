import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CodeParser } from "../src/indexer/code-parser.js";

const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("CodeParser", () => {
  const parser = new CodeParser();

  it("parses TypeScript functions, arrow functions, and classes", () => {
    const symbols = parser.parseFile(join(fixturesPath, "sample.ts"));

    expect(symbols).toHaveLength(4);
    expect(symbols.map((symbol) => [symbol.name, symbol.type])).toEqual([
      ["createServer", "function"],
      ["loadConfigValue", "function"],
      ["runSearch", "arrow_function"],
      ["InfimiumService", "class"]
    ]);
    expect(symbols.every((symbol) => symbol.language === "typescript")).toBe(true);
    expect(symbols[0]?.lineStart).toBe(1);
    expect(symbols[0]?.bodyText).toContain("function createServer");
  });

  it("parses Python classes and methods", () => {
    const symbols = parser.parseFile(join(fixturesPath, "sample.py"));

    expect(symbols).toHaveLength(3);
    expect(symbols.map((symbol) => [symbol.name, symbol.type])).toEqual([
      ["InfimiumService", "class"],
      ["index_docs", "method"],
      ["query_docs", "method"]
    ]);
    expect(symbols.every((symbol) => symbol.language === "python")).toBe(true);
  });

  it("returns an empty list for unsupported files", () => {
    expect(parser.parseFile(join(fixturesPath, "sample.json"))).toEqual([]);
  });

  it("extracts Dart functions, classes, constructors, and methods", () => {
    const symbols = parser.parseFile(join(fixturesPath, "sample.dart"));

    expect(symbols.map((symbol) => symbol.name)).toEqual([
      "bootstrap",
      "NotificationService",
      "NotificationService",
      "initialize",
      "dispose"
    ]);
    expect(symbols.every((symbol) => symbol.language === "dart")).toBe(true);
    expect(symbols.find((symbol) => symbol.name === "initialize")?.signatureText).toContain(
      "Future<void> initialize()"
    );
  });

  it("returns an empty list for malformed TypeScript", () => {
    expect(() => parser.parseFile(join(fixturesPath, "malformed.ts"))).not.toThrow();
    expect(parser.parseFile(join(fixturesPath, "malformed.ts"))).toEqual([]);
  });
});
