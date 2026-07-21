# Infimium Roadmap

Infimium is a local-first context layer for AI coding agents. The free product should make agents understand a repo quickly. The paid product should help senior engineers ship safer changes.

## Phase 0: Core Context Layer

Status: shipped

- MCP server with `hello_infimium`, `get_context`, `semantic_code_search`, `expand_symbol`, `query_local_docs`, `dep_graph`, `project_memory`, `plan`, `web_search`, `fetch_url`, and `shell`.
- Project memory that stores progress, decisions, blockers, current task, and last plan.
- YAML context layer for compact handoff between Cursor, Claude Code, Codex, Windsurf, and other MCP clients.
- AST-first semantic search that returns symbol skeletons before full implementations.
- `expand_symbol` for lazy loading full code only when needed.
- Embedded SQLite vector storage. No ChromaDB service required.
- `infimium doctor`, `infimium index`, `infimium watch`, `infimium status`, and `infimium playground`.

## Phase 1: Launch Quality

Status: current release focus

- Beginner-friendly setup: install, doctor, index, connect MCP.
- Automatic multi-project workspace discovery during `infimium index`.
- Generate `infimium.workspace.json` for sibling apps such as `UserApp`, `BrandApp`, and `AdminApp`.
- Project-scoped Playground views so index, logs, graph, and memory do not mix unrelated projects.
- Auto-exclusion engine for noisy folders: `build/`, `node_modules/`, `.dart_tool/`, `ios/Pods/`, generated apps, binaries, and lock/build artifacts.
- Clear plan model diagnostics: `plan --dry-run` works with embeddings; full `plan` asks for `ollama pull llama3.1` when needed.

## Phase 2: Free Flagship

Status: next polish cycle

- Make `plan` the free flagship workflow.
- Improve plan quality with stronger prompts, better dependency summaries, and fewer irrelevant search hits.
- Add a `--write` flow that produces clean `plan.md` files for agents to execute.
- Add diff-aware context: staged and uncommitted changes should be summarized inside `get_context`.
- Improve auto-index reliability so new files become searchable quickly during `infimium watch`.
- Add better workspace onboarding when users do not know `infimium.workspace.json` exists.

## Phase 3: Paid Flagship

Status: planned

- `code_review`: graph-aware review of the current diff, not the whole repository.
- Review changed files plus importers, callers, routes, tests, and workspace-connected projects.
- Output senior-engineer style findings: blockers, risks, missing tests, unsafe edits, and architecture drift.
- Add PR summary and changelog generation.
- Add configurable team rules for risky areas such as auth, payments, migrations, and public APIs.

## Phase 4: Impact Tools

Status: planned

- `impact_analysis`: answer what breaks if a function, route, screen, schema, or package changes.
- `test_gap`: find missing tests around changed code and dependency-connected behavior.
- `release_risk`: score a PR or release based on touched files, graph reach, test coverage, and migrations.
- `migration_guard`: connect database schema changes to affected frontend/backend code.

## Phase 5: Architecture Intelligence

Status: later

- `repo_map`: compact repository map for onboarding and navigation.
- `architecture_map`: generate maps for auth, payments, notifications, data flow, and frontend/backend boundaries.
- Workspace-level knowledge graph for routes, schemas, APIs, imports, callers, and project relationships.
- Better visualization inside Playground with filtered graph views instead of noisy full graphs.

## Phase 6: Goal Mode

Status: later

- `goal`: user defines the desired outcome once.
- Infimium creates a plan, hands it to the coding agent, reads the result, checks it against the goal, and produces the next prompt if the goal is not satisfied.
- Keep this opt-in and reviewable; the user should always see what Infimium is asking the agent to do next.

## Monetization Direction

- Free forever: local context, semantic search, dependency graph, docs search, memory, Playground, and `plan`.
- Pro: `code_review`, `impact_analysis`, `test_gap`, `release_risk`, PR summaries, and team rules.
- Early pricing target: Solo Pro at $12/month, with a founder discount for first users.
