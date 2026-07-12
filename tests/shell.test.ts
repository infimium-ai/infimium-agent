import { describe, expect, it } from "vitest";

import { ShellTool } from "../src/tools/shell.js";

const allowlist = ["ls", "sh", "sleep"];

describe("ShellTool", () => {
  it("runs ls successfully when allowlisted", async () => {
    const tool = new ShellTool({ shellAllowlist: allowlist });

    const result = await tool.run("ls", process.cwd(), 5);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("blocks rm -rf regardless of allowlist", async () => {
    const tool = new ShellTool({ shellAllowlist: [...allowlist, "rm"] });

    const result = await tool.run("rm -rf /");

    expect(result).toMatchObject({
      stdout: "",
      stderr: "Command not allowed: rm. Allowed: ls, sh, sleep, rm",
      exitCode: 1,
      durationMs: 0
    });
  });

  it("blocks sudo regardless of allowlist", async () => {
    const tool = new ShellTool({ shellAllowlist: [...allowlist, "sudo"] });

    const result = await tool.run("sudo ls");

    expect(result.stderr).toBe("Command not allowed: sudo. Allowed: ls, sh, sleep, sudo");
    expect(result.exitCode).toBe(1);
  });

  it("blocks unknown commands", async () => {
    const tool = new ShellTool({ shellAllowlist: allowlist });

    const result = await tool.run("unknown-command");

    expect(result.stderr).toBe("Command not allowed: unknown-command. Allowed: ls, sh, sleep");
    expect(result.exitCode).toBe(1);
  });

  it("enforces timeout", async () => {
    const tool = new ShellTool({ shellAllowlist: allowlist });

    const result = await tool.run("sh -c 'sleep 2'", process.cwd(), 1);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Command timed out after 1 seconds");
    expect(result.durationMs).toBeGreaterThanOrEqual(900);
    expect(result.durationMs).toBeLessThan(2_000);
  });
});
