import { describe, expect, it } from "vitest";

import { validateSetupProjectPath } from "../src/commands/setup.js";
import { parseSetupArgs } from "../src/commands/setup-options.js";

describe("setup command", () => {
  it("defaults to one-command setup behavior", () => {
    expect(parseSetupArgs([])).toEqual({
      installDeps: false,
      openPlayground: true,
      telemetryEnabled: true
    });
  });

  it("supports install, playground, and telemetry flags", () => {
    expect(parseSetupArgs(["--install-deps", "--no-playground", "--no-telemetry"])).toEqual({
      installDeps: true,
      openPlayground: false,
      telemetryEnabled: false
    });
  });

  it("rejects unknown flags with usage", () => {
    expect(() => parseSetupArgs(["--silent"])).toThrow("Usage: infimium setup");
  });

  it("rejects setup from the home directory", () => {
    expect(() => validateSetupProjectPath(process.env.HOME ?? "/Users/test")).toThrow(
      "too broad to index safely"
    );
  });
});
