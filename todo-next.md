# Infimium Next Backlog

These are intentionally parked for later so the current launch release stays focused.

## Project Inference Engine

Goal: infer which project a user means before asking them to choose.

Why it matters: in multi-project workspaces, users may say "fix push notifications" while `UserApp`, `BrandApp`, and `AdminApp` all have recent changes. Infimium should resolve the likely project automatically when confidence is high.

Planned module:

- `src/planning/project-inference.ts`
- `InferenceEngine.inferProject(tasks, candidates)`
- Output:
  - `inferredProject: string | null`
  - `confidence: "high" | "low"`
  - `reason: string`
  - candidate score details

Signals to use:

- Recent project activity from project memory.
- Keyword matches against indexed symbol names and file names.
- Semantic matches scoped to each candidate project.
- Workspace relationships from `infimium.workspace.json`.

Decision rules:

- If one project is clearly ahead, infer it with high confidence.
- If scores are close, return `null` and ask the user to disambiguate.

Tests:

- Tasks mentioning `ShellTool` and `dep_graph` should infer the Infimium repo over an unrelated Flutter app.
- Generic tasks such as "add logging" across two active projects should return low confidence.

## Planning Agent Project Resolution

Goal: make `plan` choose the right project before generating `plan.md`.

Input shape:

```ts
{
  tasks: string[];
  project?: string;
}
```

Flow:

1. Read recently changed projects.
2. If `project` is provided, validate it exists and use it directly.
3. If no changed projects exist, return setup instructions for watched projects.
4. If one project changed recently, use it automatically and say why.
5. If multiple projects changed recently, call `InferenceEngine`.
6. If inference is high confidence, use the inferred project and include the reason.
7. If inference is low confidence, return a numbered disambiguation list and stop.
8. After project resolution, generate `plan.md`.
9. Return a concise MCP response with file path, task count, unique files, execution order, and how to hand it to Cursor or Claude Code.

Expected disambiguation response:

```text
I have recent changes in 3 projects:

1. /path/UserApp - 12 files changed, last: 4m ago
2. /path/BrandApp - 3 files changed, last: 18m ago
3. /path/Supabase - 2 files changed, last: 1h ago

Which project are you working on?
Reply with the project number or path.
```

Tests:

- Tasks plus explicit project skip disambiguation and write `plan.md`.
- Tasks only with zero watched projects return setup instructions.
- Tasks only with one changed project auto-select it.
- Tasks only with multiple changed projects and clear task match infer the project.
- Tasks only with generic wording return disambiguation.
- Second call after disambiguation with `project` writes `plan.md`.

## Raw File Change History

Goal: preserve exact file change events as a low-level signal for context, Playground logs, planning, and future `code_review`.

Do not replace the current project memory system. Add raw events underneath it.

Suggested table:

```sql
CREATE TABLE IF NOT EXISTS project_file_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  change_type TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
```

Use cases:

- Better `recentlyTouchedFiles`.
- More accurate project inference.
- Playground activity feed.
- Diff-aware `code_review`.
