# Infimium Roadmap

## Shipped

- `infimium.workspace.json` workspace federation.
- Multi-root indexing and project graph.
- Cross-project context without mixing task memory or Git state.

## Later

- Add `code_review`, `repo_map`, `architecture_map`, and goal mode.
- Replace the external ChromaDB service with an embedded vector store such as LanceDB, SQLite-vss, or PGlite with pgvector.
- Make project memory universal state shared by Cursor, Claude Code, Codex, Windsurf, and other MCP-compatible agents.
- Add diff-aware context focused on recent staged and uncommitted changes.
- Add dynamic language grammar downloads after Dart support validates the grammar lifecycle.
