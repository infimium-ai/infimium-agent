<div align="center">

<img src="public/infimium_logo.png" alt="infimium.ai" width="120" height="120"/>

# Infimium

**Self-hostable TypeScript MCP server for AI agents.**

Web search | URL fetch | Local document RAG | Semantic code search | Dependency graph | Safe shell

</div>

## What Is Infimium?

Infimium is a local-first MCP (Model Context Protocol) server written in TypeScript. It gives AI agents a private, self-hostable tool layer for searching the web, fetching clean page content, querying local documents, searching code semantically, inspecting dependency relationships, and running allowlisted shell commands.

The server currently exposes exactly six MCP tools:

1. `web_search`
2. `fetch_url`
3. `query_local_docs`
4. `semantic_code_search`
5. `dep_graph`
6. `shell`

## Current Status

The core tool surface is implemented:

- Brave-powered web search
- HTML fetching and Markdown extraction
- Local document indexing and retrieval with Ollama embeddings and ChromaDB
- Tree-sitter code parsing for JavaScript, TypeScript, and Python
- Semantic code indexing and search with ChromaDB
- SQLite-backed dependency graph lookup
- Allowlisted shell execution with safety blocks and timeouts

## Requirements

- Node.js 18+
- npm or pnpm
- Ollama running locally
- Ollama model: `nomic-embed-text`
- ChromaDB running locally on `http://localhost:8000`
- Brave Search API key for `web_search`

Start Ollama and pull the embedding model:

```bash
/Applications/Ollama.app/Contents/Resources/ollama serve
/Applications/Ollama.app/Contents/Resources/ollama pull nomic-embed-text
```

Start ChromaDB separately before indexing or querying local docs/code.

## Setup

Install dependencies:

```bash
npm install
```

Create `.env` from `.env.example`:

```bash
npx tsx src/index.ts init
```

Configure:

```bash
SEARCH_API_KEY=
SEARCH_PROVIDER=brave
LOCAL_DOCS_PATH=
CODEBASE_PATH=
OLLAMA_HOST=http://localhost:11434
SHELL_ALLOWLIST=ls,git,npm,npx
```

`SEARCH_API_KEY` is required for Brave search. `LOCAL_DOCS_PATH` enables document RAG. `CODEBASE_PATH` enables semantic code search and dependency graph indexing.

## CLI

Run the MCP server:

```bash
npx tsx src/index.ts serve
```

Initialize `.env`:

```bash
npx tsx src/index.ts init
```

Index configured docs and code:

```bash
npx tsx src/index.ts index
```

The index command reads `LOCAL_DOCS_PATH` and `CODEBASE_PATH`. It indexes docs first, then code. The MCP server reads from ChromaDB and SQLite; indexing is the write path.

## MCP Tools

### `web_search`

Uses the Brave Search API:

- Input: `{ query: string, max_results?: number }`
- Retries once on rate limits or server errors
- Returns formatted title, URL, and snippet results

### `fetch_url`

Fetches and extracts readable web page content:

- Input: `{ url: string, extract?: "text" | "markdown" }`
- Removes noisy HTML elements such as nav, headers, scripts, sidebars, and ads
- Converts cleaned HTML to Markdown with Turndown
- Truncates output at 40,000 characters

### `query_local_docs`

Searches indexed local documents:

- Input: `{ query: string, top_k?: number }`
- Embeds the query with Ollama `nomic-embed-text`
- Queries ChromaDB collection `infimium_docs`
- Deduplicates adjacent chunks from the same file

### `semantic_code_search`

Searches indexed code by meaning, not just keywords:

- Input: `{ query: string, language?: string, top_k?: number }`
- Supports JavaScript, TypeScript, and Python
- Embeds parsed symbols and stores them in ChromaDB collection `infimium_code`
- Returns matching symbols with file path, line range, score, and snippet

### `dep_graph`

Inspects dependency relationships for indexed code symbols:

- Input: `{ symbol_name: string }`
- Looks up the symbol definition in SQLite
- Returns files that import the defining file
- Returns the files imported by the defining file

### `shell`

Runs safe shell commands:

- Input: `{ command: string, cwd?: string, timeout?: number }`
- Only allows base commands listed in `SHELL_ALLOWLIST`
- Blocks dangerous patterns such as `rm -rf`, `sudo`, `curl`, `wget`, `eval`, and inline code execution
- Uses `child_process.spawn`
- Caps stdout and stderr output

## Indexing Details

Document indexing:

- Reads `.md`, `.txt`, `.html`, and `.pdf`
- Skips `node_modules`, `.git`, `dist`, database files, and generated folders
- Chunks content using a simple token approximation
- Stores metadata in SQLite and vectors in ChromaDB
- Skips unchanged files on later runs

Code indexing:

- Reads `.ts`, `.tsx`, `.js`, `.jsx`, and `.py`
- Skips `node_modules`, `.git`, `dist`, `*.test.ts`, and `*.spec.ts`
- Parses symbols with tree-sitter
- Hashes files to skip unchanged code
- Embeds each symbol body with Ollama
- Stores symbol vectors in ChromaDB
- Builds the dependency graph after indexing

## Claude Desktop Example

See `examples/claude_desktop_config.json`.

Example shape:

```json
{
  "mcpServers": {
    "infimium": {
      "command": "npx",
      "args": ["tsx", "/path/to/infimium/src/index.ts", "serve"]
    }
  }
}
```

## Development

Run tests:

```bash
npm test
```

Run type checks:

```bash
npx tsc --noEmit
```

Run the semantic code search integration test with real Ollama and ChromaDB:

```bash
RUN_INTEGRATION=true npm test -- tests/semantic-code-search.integration.test.ts
```

The integration test indexes the property fixture and verifies that the query `price calculation logic` returns `calcPropertyValue` in the top results.

## Storage

Infimium uses:

- ChromaDB collection `infimium_docs` for document chunks
- ChromaDB collection `infimium_code` for parsed code symbols
- `infimium.db` for dependency graph tables
- `infimium_code.db` for code index hash state

Generated database files are ignored by Git.

## License

MIT
