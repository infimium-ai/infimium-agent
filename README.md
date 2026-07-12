<div align="center">

<img src="public/infimium_logo.png" alt="infimium.ai" width="120" height="120"/>

# Infimium

**Self-hostable TypeScript MCP server for AI agents.**

Web search | URL fetch | Local document RAG | Semantic code search | Dependency graph | Safe shell

</div>

## What Is Infimium?

Infimium is a local-first MCP (Model Context Protocol) server written in TypeScript. It gives AI agents a private, self-hostable tool layer for searching the web, fetching clean page content, querying local documents, inspecting code, and running allowlisted shell commands.

The current server exposes six MCP tools:

1. `web_search`
2. `fetch_url`
3. `query_local_docs`
4. `semantic_code_search`
5. `dep_graph`
6. `shell`

## Implemented Tools

### `web_search`

Uses the Brave Search API and returns formatted search results. Requires `SEARCH_API_KEY` in `.env`.

### `fetch_url`

Fetches HTML with native `fetch`, removes noisy page elements with Cheerio, converts main content to Markdown with Turndown, and truncates large pages safely.

### `query_local_docs`

Embeds a query with Ollama `nomic-embed-text`, reads from ChromaDB collection `infimium_docs`, deduplicates adjacent chunks, and returns ranked local document snippets.

### `shell`

Runs allowlisted commands with `child_process.spawn`, blocks dangerous patterns, enforces timeout, and caps stdout/stderr output.

## Indexing Local Docs

The document indexer runs separately from the MCP server:

```bash
npx tsx src/index.ts index
```

It reads `LOCAL_DOCS_PATH`, walks `.md`, `.txt`, `.pdf`, and `.html` files, chunks content, embeds chunks with Ollama, and stores them in ChromaDB.

Before indexing:

```bash
/Applications/Ollama.app/Contents/Resources/ollama serve
/Applications/Ollama.app/Contents/Resources/ollama pull nomic-embed-text
```

Also start a local ChromaDB server and set `LOCAL_DOCS_PATH` in `.env`.

## Setup

```bash
npm install
npm run build
npm test
```

Create `.env`:

```bash
npx tsx src/index.ts init
```

Expected fields:

```bash
SEARCH_API_KEY=
SEARCH_PROVIDER=brave
LOCAL_DOCS_PATH=
CODEBASE_PATH=
SHELL_ALLOWLIST=ls,git,npm,npx
```

## Claude Desktop Example

See `examples/claude_desktop_config.json`.

## Development

Run the MCP server:

```bash
npx tsx src/index.ts serve
```

Run tests:

```bash
npm test
```

Run type checks:

```bash
npx tsc --noEmit
```

## Notes

- The MCP server reads from ChromaDB but does not write to it.
- `infimium index` is the only current path that writes local document chunks into ChromaDB.
- Ollama is used locally for embeddings.

## License

MIT
