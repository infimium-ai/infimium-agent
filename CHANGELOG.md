# Changelog

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
