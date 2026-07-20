import { afterEach, describe, expect, it, vi } from "vitest";

import { protectStdioStdout } from "../src/stdio.js";

describe("stdio protocol logging", () => {
  const originalLog = console.log;
  const originalError = console.error;

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  it("redirects console.log messages to stderr in serve mode", () => {
    const errorSpy = vi.fn();
    console.error = errorSpy;

    protectStdioStdout();
    console.log("Docs:", 21, "files indexed");

    expect(errorSpy).toHaveBeenCalledWith("Docs:", 21, "files indexed");
  });
});
