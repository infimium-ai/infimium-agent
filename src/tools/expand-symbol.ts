import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";

import { CodeParser } from "../indexer/code-parser.js";
import { dataPath } from "../paths.js";

const require = createRequire(import.meta.url);

export type ExpandSymbolOptions = {
  codebasePath: string;
  symbolName: string;
  filePath?: string;
  sqlitePath?: string;
};

export function expandSymbol(options: ExpandSymbolOptions): string {
  const rootPath = resolve(options.codebasePath);
  const sqlitePath = resolve(options.sqlitePath ?? dataPath("infimium.db"));
  if (!existsSync(sqlitePath)) {
    return `Symbol not found: ${options.symbolName}. Run: infimium index`;
  }

  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT file_path, line_start FROM symbol_locations
         WHERE symbol_name = ? ORDER BY file_path`
      )
      .all(options.symbolName) as Array<{
        file_path?: unknown;
        line_start?: unknown;
      }>;
    const requestedPath = options.filePath ? resolve(rootPath, options.filePath) : null;
    const candidate = rows.find((row) => {
      if (typeof row.file_path !== "string" || !isWithinRoot(row.file_path, rootPath)) {
        return false;
      }
      return requestedPath ? resolve(row.file_path) === requestedPath : true;
    });
    if (typeof candidate?.file_path !== "string") {
      return `Symbol not found: ${options.symbolName}`;
    }

    const parser = new CodeParser();
    const symbol = parser
      .parseFile(candidate.file_path)
      .find((item) => item.name === options.symbolName);
    if (!symbol) {
      return `Symbol not found: ${options.symbolName}`;
    }

    const displayPath = relative(rootPath, symbol.filePath) || symbol.filePath;
    return [
      `${symbol.name} — ${displayPath}:${symbol.lineStart}-${symbol.lineEnd}`,
      `Language: ${symbol.language}`,
      "",
      symbol.bodyText
    ].join("\n");
  } finally {
    db.close();
  }
}

function isWithinRoot(filePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, resolve(filePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
