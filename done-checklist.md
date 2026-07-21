# Infimium Done Checklist

This tracks what has been built so far.

## Project Foundation

- [x] Created Node.js TypeScript MCP project structure.
- [x] Added `src/tools`, `src/indexer`, `src/commands`, `src/cli`, `tests`, `examples`, and `docs`.
- [x] Added `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, and MIT `LICENSE`.
- [x] Added CLI entrypoint with `serve`, `init`, `index`, `doctor`, `status`, and tool commands.
- [x] Added Claude/Cursor MCP config examples.

## Core MCP Server

- [x] Built MCP server using `@modelcontextprotocol/sdk`.
- [x] Added stdio transport.
- [x] Added health tool: `hello_infimium`.
- [x] Registered MCP tools with strict input schemas.
- [x] Added integration test that lists tools and calls each stub/tool.

## Web Tools

- [x] Implemented `web_search`.
- [x] Added Tinyfish search provider support.
- [x] Kept Brave/Serp config compatibility.
- [x] Added graceful missing API key and API error handling.
- [x] Implemented `fetch_url`.
- [x] Added HTML cleanup with Cheerio.
- [x] Added Markdown extraction with Turndown.
- [x] Added timeout, invalid URL, non-HTML, and HTTP status handling.
- [x] Added CLI commands for web search and fetch.

## Shell Tool

- [x] Implemented allowlisted `shell` execution with `spawn`.
- [x] Added blocked command patterns.
- [x] Added timeout support.
- [x] Added stdout/stderr truncation.
- [x] Added tests for allowed, blocked, unknown, and timeout cases.

## Local Docs

- [x] Implemented document indexer.
- [x] Supports `.md`, `.txt`, `.html`, and `.pdf`.
- [x] Added recursive, boundary-aware splitting.
- [x] Added local embeddings with Ollama `nomic-embed-text`.
- [x] Implemented `query_local_docs`.
- [x] Added deduplication and formatted MCP output.
- [x] Added tests for docs search and empty index cases.

## Semantic Code Search

- [x] Implemented Tree-sitter code parser.
- [x] Added JavaScript, TypeScript, Python, and Dart parsing.
- [x] Added dynamic grammar path for extra languages.
- [x] Implemented code indexer.
- [x] Added content hashing and incremental skip behavior.
- [x] Added AST-first semantic search.
- [x] `semantic_code_search` returns compact symbol skeletons first.
- [x] Added `expand_symbol` to fetch full implementation only when needed.
- [x] Added unit and integration tests.

## Dependency Graph

- [x] Implemented `dep_graph`.
- [x] Extracts imports for JS/TS, Python, and Dart.
- [x] Stores import relationships in SQLite.
- [x] Stores symbol locations.
- [x] Added caller/callee graph edges.
- [x] Added HTTP route edge support.
- [x] Wired graph build into indexing.
- [x] Added tests for graph lookup and unknown symbols.

## Embedded Storage

- [x] Removed ChromaDB as a required service.
- [x] Added embedded SQLite vector store.
- [x] Added local DB paths under `~/.infimium/data`.
- [x] Added tests for vector store behavior.
- [x] Updated `doctor` and status to use embedded storage.

## Project Memory And Context Layer

- [x] Implemented project memory store.
- [x] Stores notes, progress, decisions, blockers, plans, and active task.
- [x] Added `project_memory` MCP tool.
- [x] Added `remember` and `resume` CLI commands.
- [x] Implemented `get_context` MCP tool and CLI command.
- [x] Added YAML context output to reduce token usage.
- [x] Added context layer file at `context/layer.md`.
- [x] Added compressed working tree summaries.
- [x] Added recently touched files.
- [x] Added project overview generation.
- [x] Added auto context writer.

## Planning

- [x] Implemented `plan` MCP tool and CLI command.
- [x] Added `--dry-run` retrieval mode.
- [x] Added semantic search plus dependency context retrieval.
- [x] Added external prompt file for plan quality iteration.
- [x] Added optional `plan.md` writing.
- [x] Added local Ollama generation support.
- [x] Added clear missing-model diagnostics for `llama3.1`.
- [x] Added plan tests.

## Workspace Federation

- [x] Added `infimium.workspace.json` support.
- [x] Added workspace graph support.
- [x] Added automatic multi-project discovery during `infimium index`.
- [x] Detects sibling apps such as `UserApp`, `BrandApp`, and `AdminApp`.
- [x] Detects project roles from files like `pubspec.yaml`, `package.json`, and Supabase config.
- [x] Avoids nested build folders and nested project roots.
- [x] Suggests basic project relationships.
- [x] Indexes every accepted workspace project.
- [x] Added project-scoped context, graph, logs, and Playground views.

## Index Hygiene

- [x] Added auto-exclusion engine.
- [x] Added `.infimiumignore` support.
- [x] Excludes common noise: `node_modules`, `.git`, `dist`, `build`, `.dart_tool`, `ios/Pods`, generated app bundles, binaries, lock/build artifacts.
- [x] Reduced Flutter/iOS build artifact pollution.
- [x] Added tests for exclusion behavior.

## Auto Indexing

- [x] Added `infimium watch`.
- [x] Added background auto-indexing from MCP tool calls.
- [x] Added debounce behavior for watched project changes.
- [x] Added index progress memory events.
- [x] Added tests around watch command behavior.

## Doctor And Status

- [x] Added `infimium doctor`.
- [x] Checks Node/npm compatibility.
- [x] Checks Ollama install/running state.
- [x] Checks required embedding model.
- [x] Checks embedded vector store.
- [x] Checks config/env defaults.
- [x] Checks index status.
- [x] Prints copy-pasteable fix commands.
- [x] Added `infimium status`.
- [x] Shows docs, code, graph, projects, DB size, and last indexed.

## Playground

- [x] Added `infimium playground`.
- [x] Added Express local read-only server.
- [x] Added Vite/React frontend.
- [x] Added dark Infimium visual system.
- [x] Added The Pulse dashboard.
- [x] Added Knowledge Graph view.
- [x] Added Index & Logs view.
- [x] Added Token Economics view.
- [x] Added project selector for multiple watched projects.
- [x] Reduced graph noise and token economics info overload.
- [x] Added local API routes for health, pulse, workspace, index, metrics, and logs.

## Docker And Setup

- [x] Added Dockerfile.
- [x] Added docker-compose setup.
- [x] Added setup script.
- [x] Later moved main path toward embedded storage so Docker is optional instead of required.

## Open Source And Release Readiness

- [x] Added `README.md`.
- [x] Added `CONTRIBUTING.md`.
- [x] Added `SECURITY.md`.
- [x] Added `CODE_OF_CONDUCT.md`.
- [x] Added GitHub issue templates.
- [x] Added PR template.
- [x] Added GitHub Actions CI.
- [x] Published early npm versions.
- [x] Added launch-oriented README copy.
- [x] Added roadmap.
- [x] Added `todo-next.md` for future work.

## Website And Brand

- [x] Cloned and updated the Infimium waitlist website.
- [x] Updated website content from product review notes.
- [x] Fixed countdown reset behavior.
- [x] Added logo/title wiring.
- [x] Removed footer from community and updates pages.
- [x] Added sitemap/SEO work.
- [x] Hosted website on Firebase.
- [x] Prepared LinkedIn/X launch copy.

## Validations Completed

- [x] Ran TypeScript builds multiple times.
- [x] Ran unit and integration tests.
- [x] Tested MCP tools from Cursor.
- [x] Tested web search and fetch.
- [x] Tested docs/code search after indexing.
- [x] Tested `get_context`, memory, `hello_infimium`, and `project_memory`.
- [x] Tested Playground visually.
- [x] Tested real Flutter/Dart project indexing on Klubeats UserApp.
- [x] Validated workspace discovery against Klubeats Code structure.

## Planned But Not Built Yet

- [ ] Project inference engine for ambiguous multi-project tasks.
- [ ] Planning Agent v2 project disambiguation flow.
- [ ] Raw file change history table for exact watcher events.
- [ ] Paid `code_review` tool.
- [ ] `impact_analysis`.
- [ ] `test_gap`.
- [ ] `release_risk`.
- [ ] `repo_map`.
- [ ] `architecture_map`.
- [ ] Goal mode.
- [ ] Hosted Infimium team layer.
