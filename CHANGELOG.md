# Changelog

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
