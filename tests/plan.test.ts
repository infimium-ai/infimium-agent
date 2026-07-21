import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPlanPrompt,
  createPlan,
  formatPlanError,
  formatPlanResult
} from "../src/commands/plan.js";
import type { DepGraphResult } from "../src/tools/dep-graph.js";
import type { CodeResult } from "../src/tools/semantic-code-search.js";

const codeResult: CodeResult = {
  name: "runDoctorCommand",
  filePath: "/repo/src/commands/doctor.ts",
  lineStart: 40,
  lineEnd: 72,
  language: "typescript",
  score: 0.93,
  snippet: "export async function runDoctorCommand(): Promise<void> { /* checks env */ }"
};

const depGraphResult: DepGraphResult = {
  symbol: "runDoctorCommand",
  definedIn: "/repo/src/commands/doctor.ts",
  importedBy: ["/repo/src/index.ts"],
  imports: ["/repo/src/paths.ts"],
  calledBy: [],
  calls: [],
  routes: []
};

function fakeSearcher(results: CodeResult[]) {
  return {
    async search(): Promise<CodeResult[]> {
      return results;
    }
  };
}

function fakeDepGraph(result: DepGraphResult) {
  return {
    query(): DepGraphResult {
      return result;
    },
    close(): void {}
  };
}

describe("plan command", () => {
  it("formats dry-run retrieval context without calling the LLM", async () => {
    const result = await createPlan({
      task: "add a doctor command",
      dryRun: true,
      recordMemory: false,
      codebasePath: "/repo",
      searcher: fakeSearcher([codeResult]),
      depGraph: fakeDepGraph(depGraphResult)
    });

    const output = formatPlanResult(result, "/repo");

    expect(output).toContain("Infimium plan dry run");
    expect(output).toContain("src/commands/doctor.ts:40-72");
    expect(output).toContain("Imported by: src/index.ts");
    expect(output).toContain("LLM call skipped");
  });

  it("builds a prompt with the task, code summaries, and dependency edges", () => {
    const prompt = buildPlanPrompt(
      "add a doctor command",
      {
        codeResults: [codeResult],
        dependencies: [depGraphResult]
      },
      "/repo"
    );

    expect(prompt).toContain("Task:");
    expect(prompt).toContain("add a doctor command");
    expect(prompt).toContain("runDoctorCommand");
    expect(prompt).toContain("Imported by: src/index.ts");
  });

  it("generates a plan and optionally writes plan.md", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "infimium-plan-"));
    const outputPath = join(tempDir, "plan.md");
    const result = await createPlan({
      task: "add a doctor command",
      writePlan: true,
      outputPath,
      recordMemory: false,
      codebasePath: "/repo",
      searcher: fakeSearcher([codeResult]),
      depGraph: fakeDepGraph(depGraphResult),
      llmClient: {
        async generate(): Promise<string> {
          return "## Summary\nAdd doctor command safely.";
        }
      }
    });

    const written = await readFile(outputPath, "utf8");

    expect(result.planText).toContain("Add doctor command safely");
    expect(result.writtenPath).toBe(outputPath);
    expect(written).toContain("# Infimium plan");
    expect(written).toContain("## Plan");
  });

  it("writes relative plan output paths inside the target project", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "infimium-plan-project-"));
    const result = await createPlan({
      task: "add a doctor command",
      writePlan: true,
      outputPath: "plan.md",
      recordMemory: false,
      codebasePath: tempDir,
      searcher: fakeSearcher([{
        ...codeResult,
        filePath: join(tempDir, "src", "commands", "doctor.ts")
      }]),
      depGraph: fakeDepGraph({
        ...depGraphResult,
        definedIn: join(tempDir, "src", "commands", "doctor.ts"),
        importedBy: [join(tempDir, "src", "index.ts")]
      }),
      llmClient: {
        async generate(): Promise<string> {
          return "## Summary\nAdd doctor command safely.";
        }
      }
    });

    expect(result.writtenPath).toBe(resolve(tempDir, "plan.md"));
    await expect(readFile(resolve(tempDir, "plan.md"), "utf8")).resolves.toContain(
      "# Infimium plan"
    );
  });

  it("prints the exact model pull command when the plan model is missing", () => {
    const output = formatPlanError(
      new Error("Ollama plan generation failed with HTTP 404. Run: ollama pull llama3.1")
    );

    expect(output).toContain("Plan failed: Ollama is missing the local plan-generation model.");
    expect(output).toContain("Fix: ollama pull llama3.1");
  });
});
