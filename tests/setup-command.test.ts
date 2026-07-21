import { describe, expect, it } from "vitest";

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
});
