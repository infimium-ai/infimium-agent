# Changelog

## 0.4.3

- Fixed Playground SPA fallback serving in global npm installs.

## 0.4.2

- Fixed packaged `infimium playground` static asset resolution.
- Added the Infimium app logo to the Playground shell.
- Added a persistent light/dark mode toggle for the Playground.

## 0.4.1

- Added privacy-safe PostHog lifecycle telemetry with opt-out controls.
- Added `infimium telemetry status|on|off`.
- Hardened Playground empty-index behavior on fresh installs.

## 0.4.0

- Added automatic multi-project discovery to `infimium index`, including role inference, dependency suggestions, confirmation, workspace manifest creation, and Playground launch.
- Replaced ChromaDB with an embedded SQLite vector store and removed the Docker service requirement.
- Added global optional configuration so projects no longer need their own `.env` file.
- Added recursive, boundary-aware document splitting and corrupt-document skipping.
- Added on-demand cached Tree-sitter WASM grammars for Go, Rust, and Java.
- Added symbol caller/callee and HTTP-route edges to the dependency graph.

## 0.3.1

- Protected MCP stdio by redirecting serve-mode application logs to stderr.
- Prevented background indexing progress from corrupting JSON-RPC responses.

## 0.3.0

- Added `infimium.workspace.json` for grouping related repositories.
- Added multi-root indexing and a SQLite workspace relationship graph.
- Added cross-project `get_context` summaries without sharing task memory or Git state.
- Added workspace-aware Dart package import resolution across Flutter repositories.
- Added `infimium workspace init`, `show`, `validate`, and `graph` commands.
- Hardened concurrent context reads across agents with bounded SQLite lock waiting.

## 0.2.1

- Fixed `expand_symbol` on fresh installations before the first index.
- Isolated MCP subprocess test data to prevent parallel CI database races.

## 0.2.0

### Context foundation

- Added project-aware build artifact exclusions and `.infimiumignore` support.
- Compressed project-scoped context with YAML output by default.
- Added deterministic project overviews and stale-index pruning.

### Dart and focused retrieval

- Added Dart and Flutter semantic indexing and dependency graph support.
- Added `expand_symbol` for loading a full implementation on demand.
- Changed semantic code search to return compact symbol skeletons first.
