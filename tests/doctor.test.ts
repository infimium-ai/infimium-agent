import { describe, expect, it } from "vitest";

import { formatDoctorReport, type DoctorCheck } from "../src/commands/doctor.js";

describe("doctor command", () => {
  it("prints numbered checks, copy-paste fixes, and an actionable summary", () => {
    const checks: DoctorCheck[] = [
      {
        name: "Node/npm version",
        status: "pass",
        detail: "Node 24.18.0 satisfies >=22.5.0; npm 11.16.0 found."
      },
      {
        name: "Ollama",
        status: "fail",
        detail: "Ollama binary is not installed or not available on PATH.",
        fixCommand: "brew install ollama && ollama serve"
      },
      {
        name: "Required embedding model",
        status: "fail",
        detail: "nomic-embed-text is not installed in Ollama.",
        fixCommand: "ollama pull nomic-embed-text"
      }
    ];

    const report = formatDoctorReport(checks);

    expect(report).toContain("1. ✅ Node/npm version");
    expect(report).toContain("2. ❌ Ollama");
    expect(report).toContain("Fix: brew install ollama && ollama serve");
    expect(report).toContain("Fix: ollama pull nomic-embed-text");
    expect(report).toContain("Summary: 1/3 checks passed — brew install ollama && ollama serve");
  });
});
