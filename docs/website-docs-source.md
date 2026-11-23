# Infimium Docs: Website Content Source

Status: public-safe documentation draft. Free is available as the open-source CLI and MCP server. Premium is in private preview; public access and pricing have not been announced.

Use this file as the source for the website's Docs section. Keep the product boundaries and availability labels when adapting the copy. Commands below are for Free; the Premium section describes the current preview workflow, not a public installation command.

## 1. What Infimium Does

Infimium gives a coding agent relevant context from an indexed codebase. It finds symbols, connects related files, and keeps project memory between sessions. The agent can start with a compact view, then open a full implementation when needed.

Free provides the local index, search, dependency graph, project memory, MCP tools, and Playground. Premium adds a project-aware place to schedule work, create and review feature roadmaps, and hand a selected task to a coding agent.

### The problem and the approach

| Common problem | What Infimium does | Why it helps |
| --- | --- | --- |
| An agent reads too much of a large repository. | Returns relevant symbols and short code structure first; full code is available on request. | The agent spends its context window on the parts that matter. |
| A feature crosses several files or projects. | Uses indexed files and dependency relationships to show connected code. | A plan can name the likely change points and nearby behavior to check. |
| A new agent loses the previous session's decisions. | Keeps project-scoped memory and a current context snapshot. | Handoffs can carry decisions and progress without replaying the entire history. |
| A plan sounds plausible but does not match the repository. | Grounds roadmap references in the selected project's index and flags missing evidence. | The user can review assumptions before approving work. |

Infimium helps an agent find and explain relevant code; it does not make every generated plan correct. Review the proposed requirements, design, tasks, and evidence before handing off implementation.

### What we learned while building it

- **A whole-file dump is expensive; a tiny summary can miss the implementation.** Infimium starts with indexed symbols and opens full code selectively. The Playground's reference comparison is roughly 1,460 tokens for a full symbol versus 8 for its initial skeleton. Actual savings depend on the code and what the agent expands.
- **The same request can mean different things in different projects.** Selecting a project before retrieval keeps the search, memory, and roadmap focused. Workspace relationships help locate connected code, but they do not replace checking the real contract between projects.
- **A convincing plan can still cite the wrong file or miss a requirement.** Roadmap drafts show their code references and evidence gaps for review. When the right target cannot be established, clarification is better than an invented implementation path.
- **Long task histories bury decisions.** Project memory keeps recent activity and compact milestones so a new session can resume from useful context.

## 2. Free: Quick Start

Requires Node.js 22.5 or newer. Open a terminal in the repository you want Infimium to understand:

```bash
cd /path/to/your/project
npx infimium@latest setup
```

Setup prepares local configuration, checks required dependencies, indexes the current project or detected workspace, runs health checks, and opens the Playground. Run it from the project or workspace root, not your home directory. If the dependency check asks for installation, run:

```bash
npx infimium@latest setup --install-deps
```

Useful follow-up commands:

```bash
npx infimium@latest doctor
npx infimium@latest status
npx infimium@latest playground
```

To refresh the index after code changes, run `npx infimium@latest index`. To keep the index updated while you work, run `npx infimium@latest watch` in a terminal.

### Connect a coding agent

Add an MCP server entry in your client's MCP configuration, then restart that client:

```json
{
  "mcpServers": {
    "infimium": {
      "command": "npx",
      "args": ["-y", "infimium", "serve"]
    }
  }
}
```

The configuration location differs by client. If the client starts the MCP server outside your repository, pass the repository's absolute path as `project_path` on the first relevant tool call.

Try this in the connected client:

```text
Use Infimium get_context for this project. Find where user sign-in is implemented with semantic_code_search. Show the relevant symbols and dependency links, then expand only the symbols needed to explain the flow. Cite the file paths you used.
```

### Use context and memory during a task

`get_context` reads the saved project snapshot and relevant memory. `semantic_code_search` locates code by intent. `dep_graph` explores connected symbols and files. `expand_symbol` opens the full implementation of one symbol. `project_memory` and `infimium_update` preserve meaningful progress and handoff notes.

For documentation or architecture questions, use `query_local_docs`. For a proposed code change, `plan --dry-run "describe the change"` previews retrieved code context; full plan generation needs the optional planning setup. Inspect any plan's referenced files before acting on it. `shell` can run commands on the configured allowlist; the agent should report the actual exit status and relevant failures.

For example:

```bash
npx infimium@latest remember "Changed the login validation flow" --type progress --task "Improve sign-in"
npx infimium@latest get-context
npx infimium@latest memory complete
```

Complete the memory session when a task is done so the next agent receives a compact milestone. Memory records are scoped to the project. A saved snapshot may be stale after external edits; refresh the index or context when needed.

## 3. Free: Make It Fit Your Repository

### Multiple projects in one workspace

Run indexing from a parent folder containing the projects. Infimium detects supported project roots and asks whether to create `infimium.workspace.json`:

```bash
cd /path/to/workspace
npx infimium@latest index
```

For a noninteractive run:

```bash
npx infimium@latest index --yes --no-playground
```

You can review and edit the generated workspace file to name projects, adjust project paths, and record `dependsOn` relationships. Project paths are relative to the workspace file. A minimal example:

```json
{
  "schemaVersion": 1,
  "name": "My workspace",
  "projects": [
    { "id": "user-app", "path": "UserApp", "role": "application", "dependsOn": [] },
    { "id": "admin-app", "path": "AdminApp", "role": "admin application", "dependsOn": ["user-app"] }
  ]
}
```

Only declare a dependency when the projects really share a contract or integration. Each project's index and memory stay scoped to that project; select the intended project before asking for context or a plan.

### Choose what gets indexed

Put repository-specific exclusions in `.infimiumignore` at the project root. Infimium also respects `.gitignore` and skips common dependency and build directories. Re-run `index` after changing ignore rules.

```gitignore
generated/
coverage/
*.min.js
```

### Adjust local behavior

Setup creates a global config at `~/.infimium/.env`; you do not need a separate config file in every repository. You can change allowed shell commands with `SHELL_ALLOWLIST`, then restart the Infimium process. Keep the allowlist limited to commands you trust.

Anonymous setup telemetry can be disabled:

```bash
npx infimium@latest telemetry off
```

Free is MIT licensed. Developers can inspect and modify the source, add language support, and contribute changes. The repository's `CONTRIBUTING.md` is the starting point for source changes.

## 4. Premium: Plan Several Days of Work

Premium is currently a private preview. Its dashboard, calendar, and roadmaps use the selected project. When you request generation, the roadmap uses that project's indexed code and relevant memory. Scheduling a prompt does not replace the active task in project memory. The workflow below describes what to do after you have access to the preview.

1. **Select the project.** Choose the workspace and project you intend to change. Confirm its index is current. Switching projects brings back that project's own scheduled prompts and roadmaps.
2. **Schedule prompts.** Open Calendar or Dashboard, choose a date, and select **New prompt**. Write one feature or fix in plain language. Save several prompts on a day, or spread them across four or five days. A prompt can also stay in the backlog without a date.
3. **Let the scheduled day arrive.** A dated prompt generates a review-required roadmap automatically when Premium is running on or after that day. If Premium was closed, it catches up when you start it again. Use **Save & generate** for an earlier draft; backlog prompts stay manual. A failed generation stays visible for explicit retry and is never treated as ready.
4. **Review the map.** Open each prompt's roadmap. It has **Requirements**, **Design**, **Tasks**, **Security**, and **Code Review** sections. Check that the intended outcome is captured, cited files belong to the selected project, tasks cover the requirements, and missing evidence is visible. Add clarification or edit the request and regenerate a draft when needed.
5. **Approve and hand off.** Approve only after reviewing the draft. A successfully generated scheduled draft saves a compact, review-only reference in project memory without changing your active task. Choose **Hand off next task**, then copy the handoff for your coding agent. That explicit handoff updates the reference; neither scheduling nor generation runs code.
6. **Implement and report back.** Ask the connected coding agent to read the selected map, follow its task order, and return actual changes and test results. Review reported completion, security checks, and code review evidence in the same roadmap. Reported completion and independent verification are different states.

Example for a week away from the project:

```text
Monday: Add a rate limit to the public API.
Monday: Add regression tests for rejected requests.
Wednesday: Show clearer errors in the client.
Friday: Review deployment configuration.
```

Save these as four prompts. On Monday, Premium generates the first two drafts while its local server is running; inspect them and approve only the one you are ready to implement. Wednesday and Friday generate on their due dates. Delete any unwanted draft; its memory reference is removed too. Scheduling alone does not start an agent or change source files.

### Suggested agent handoff

In an MCP client connected to your Premium preview, replace the placeholders with the selected project and roadmap:

```text
Use Infimium infimium_getmap for roadmap <map ID> in project <project path>.
Read Requirements, Design, Tasks, Security, Code Review, and the next-task handoff.
Implement only the approved task and its required dependencies.
Use the cited code references, inspect the current files before editing, and run relevant tests.
Report the changed files, test results, and any unresolved risk back to this roadmap.
Do not mark security or code review checks passed without concrete evidence.
```

The agent needs access to the Premium MCP tools for this prompt to work. If the client does not expose them, copy the handoff shown in the roadmap into the agent chat and keep the roadmap open for status updates.

### What the checks mean

Security and Code Review sections track checks and evidence for the current roadmap. Their displayed scores describe recorded review coverage against the checklist. They are not a guarantee of security or code quality. A draft with weak or missing evidence needs human review; a scheduled prompt is never an approved implementation task.

## 5. Connect a Coding Agent

### Cursor, Claude Code, and Codex

Use the Free MCP server configuration from Section 2. Set it up in the same local environment where the repository is indexed.

**Cursor:** Put that JSON in `.cursor/mcp.json` for one project, or `~/.cursor/mcp.json` to use it across projects. Restart Cursor and check that Infimium is enabled in the agent's available tools. See [Cursor's MCP configuration guide](https://cursor.com/docs/mcp).

**Claude Code:** From the project folder, add the local server and confirm that it connected:

```bash
claude mcp add infimium -- npx -y infimium serve
claude mcp list
```

Inside Claude Code, `/mcp` shows server status. A project-scoped `.mcp.json` may require workspace approval before its tools become available. See [Claude Code's MCP guide](https://code.claude.com/docs/en/mcp).

**Codex CLI and supported local Codex clients:** Add the server from a terminal on the machine with the index, then confirm its configuration:

```bash
codex mcp add infimium -- npx -y infimium serve
codex mcp list
```

Codex keeps MCP configuration in `~/.codex/config.toml`. Restart or open a new local session after adding the server. Confirm that this session can call `hello_infimium`; a configured server is not proof that every remote or isolated session can access your machine. See [OpenAI's Codex MCP setup](https://developers.openai.com/learn/docs-mcp).

In any client, ask:

```text
Call Infimium hello_infimium. Then call get_context with project_path set to the absolute path of this repository. Tell me which project you selected.
```

If `hello_infimium` is unavailable, check the client's MCP server list and the environment where that client runs. Repeating the prompt will not install a missing connection.

## 6. First Real Workflow

Use a repository you know and one feature you can verify. This example asks about sign-in; replace it with a feature in your own codebase.

1. Run `npx infimium@latest doctor` and confirm the index with `npx infimium@latest status`.
2. Connect an MCP client and call `hello_infimium`, then `get_context` with the intended `project_path`.
3. Ask `semantic_code_search` for the sign-in flow. Inspect the returned file paths and symbols. A result from a different project means you should correct the selected project before continuing.
4. Ask `dep_graph` about the most relevant symbol. Follow its imports, callers, or routes to identify nearby behavior.
5. Ask `expand_symbol` for one implementation you need to read. Check the actual code before proposing an edit.
6. Ask the agent to explain the flow with the returned file and symbol references. If a reference is missing or stale, refresh the index and repeat the search.

Copyable agent request:

```text
Use Infimium get_context for this project's absolute path. Find the sign-in flow with semantic_code_search, inspect the most relevant dependency links with dep_graph, and expand only the symbols needed to explain it. Cite the actual indexed file paths and symbols. Say what evidence is missing; do not invent a route or file.
```

For a change request, start with `npx infimium@latest plan --dry-run "describe your change"` to inspect the retrieved context. Review the code references before generating or approving an implementation plan.

## 7. Troubleshooting

**Setup stops at the repository check:** Run it from the project or workspace folder. Infimium deliberately rejects broad roots such as your home directory.

**A dependency or health check fails:** Run `npx infimium@latest doctor` and follow the failed check's printed fix. If a required local dependency has not been installed, rerun setup with `--install-deps`. A configured optional planning capability is separate from the dependencies needed for indexing and search.

**The agent cannot see `hello_infimium` or `get_context`:** Check the MCP entry in that client's settings, restart the client, and start a new local session. Use the client's MCP status screen or list command. Confirm the client runs on the same machine as the Infimium installation; a cloud session does not automatically inherit local MCP tools.

**Context points to the wrong project:** Pass the absolute `project_path` explicitly. For a multi-project workspace, select the intended project in Playground or Premium and check the path returned by `get_context`.

**Search misses recent code changes:** Run `npx infimium@latest index` or keep `watch` running. Check `.infimiumignore` and `.gitignore` if a file never appears. Refresh saved context after external edits.

**Playground cannot open or shows missing assets:** Use `npx infimium@latest playground` for the published package. From a source checkout, run `npm run build` before `npm run playground`. Check `npx infimium@latest doctor` if the command itself fails.

**The database reports a lock:** Stop duplicate Infimium processes that may be indexing or watching the same data, then retry. Do not delete the database as a first fix.

## 8. Premium Roadmap Status

Premium is a private preview. These labels describe the state of one selected project's roadmap:

| Label | Meaning | What to do |
| --- | --- | --- |
| Scheduled prompt | A saved request for a chosen date or the backlog. | A dated prompt generates a review-required draft when due and Premium is running; backlog items need manual generation. |
| Draft / review required | Requirements, design, or tasks may need clarification and review. | Check the intended outcome, references, missing evidence, and task coverage. |
| Approved roadmap | A user has accepted the plan for handoff. | Hand off one task and keep its scope visible to the agent. |
| Reported complete | The agent or operator recorded that a task was done. | Inspect the diff and test evidence. |
| Verified | The configured verification checks ran against an approved contract. | Read what was checked and what remains outside that contract. |

Security and Code Review scores show recorded checklist evidence for their respective sections. They are not a guarantee that a release is safe or that every defect was found. Current automatic roadmap generation still needs human review; a failed or incomplete draft should not be presented as ready.

## 9. Privacy and Data

**Free:** The code index, graph, and project memory are stored on your machine under `~/.infimium/`. Anonymous lifecycle telemetry is enabled by default; it records events such as setup and indexing success with an anonymous install ID, version, platform, and timestamp. It does not include source code, prompts, search terms, file paths, repository names, or memory notes. Disable it with `npx infimium@latest telemetry off`.

Optional features that fetch web content can contact external sites when you choose to use them. Review what an agent sends through those tools. The MCP `shell` tool only runs commands allowed by your local configuration.

**Premium private preview:** Current scheduled prompts and roadmaps are local to the preview. Public availability, billing, and future hosting terms have not been announced. Do not infer future data handling from the local preview.

## 10. Practical Questions

**Does Infimium replace my coding agent?** No. It prepares relevant code context and a reviewable work map. A connected agent still makes edits and runs tests after you hand off a task.

**Why use Infimium if my agent already searches the repository?** Infimium keeps a project-scoped index, dependency view, and memory that can be reused across tasks and clients. Premium adds a persistent schedule and roadmap so work can be resumed and reviewed later.

**Can it understand every feature request from one sentence?** Sometimes a request has several plausible targets. Infimium should ask for clarification or show evidence limitations when the index does not establish the right boundary. Review the draft before approval.

**Will a task run automatically on its scheduled date?** No code runs automatically. Premium generates a draft roadmap when a dated prompt is due and its local server is running, or on the next start. You review, approve, and hand it to an agent yourself.
