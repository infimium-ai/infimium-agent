<p align="center">
  <img src="public/infimium-logo.png" alt="Infimium" width="120" />
</p>

Private search MCP for AI agents. Web · code · local docs · dependency graph — one endpoint, your machine.

[![npm version](https://img.shields.io/npm/v/infimium.svg)](https://www.npmjs.com/package/infimium)
[![MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/infimium-ai/infimium-agent.svg?style=social)](https://github.com/infimium-ai/infimium-agent)

## The problem

Agents need precise context, but large repos make that expensive fast.
Keyword search is brittle: it misses intent, aliases, and the symbols that actually matter.

```
200,000 lines of code
Agent reads everything → 💀 context blown + $$$
grep "price calculation" → misses calcPropertyValue()
```

## With Infimium

Infimium indexes your docs, code symbols, and dependency graph locally.
Agents ask focused tools for the right context instead of reading the whole project.

```
tool: semantic_code_search
query: "price calculation logic"

→ services/property/calc.ts:142 · calcPropertyValue()
→ imported by: listing.ts, tax.ts, pdf-generator.ts, calc.test.ts
```

## Tools

`web_search` — Brave web search with retry and concise source snippets.

`fetch_url` — fetches HTML, strips noise, returns Markdown or text.

`query_local_docs` — local document RAG over `.md`, `.txt`, `.html`, and `.pdf`.

`semantic_code_search` — differentiator: tree-sitter symbols + local embeddings for meaning-based code search.

`dep_graph` — differentiator: SQLite import graph for "where is this defined and who imports it?"

`shell` — allowlisted command runner with blocked patterns, timeout, and output caps.

`plan` — differentiator: retrieves semantic code context and dependency edges, then drafts an implementation plan.

`status` — CLI health check for indexed docs, code symbols, dep graph relationships, watched projects, DB size, and last index time.

`doctor` — CLI setup check for Node/npm, Ollama, ChromaDB, `.env`, and index readiness.

## Why self-hosted

Your code index, your embeddings, your dep graph — all on your machine. Nothing leaves.

- Embeddings run locally with Ollama.
- No vendor lock-in: MCP, SQLite, ChromaDB, TypeScript.
- Works in air-gapped environments.

## Quick start

```bash
git clone https://github.com/infimium/infimium && cd infimium
cp .env.example .env  # add your SEARCH_API_KEY
./scripts/setup.sh
```

## Setup guide

### npm package

Requires Node.js 22.5+.

Install:

```bash
npm i infimium
```

Create `.env`:

```bash
cp .env.example .env
```

Configure:

```bash
SEARCH_API_KEY=your_brave_api_key
SEARCH_PROVIDER=brave
LOCAL_DOCS_PATH=/absolute/path/to/docs
CODEBASE_PATH=/absolute/path/to/code
OLLAMA_HOST=http://localhost:11434
CHROMADB_HOST=http://localhost:8000
SHELL_ALLOWLIST=ls,git,npm,npx
```

Start Ollama:

```bash
ollama serve
ollama pull nomic-embed-text
```

Start ChromaDB on `http://localhost:8000`:

```bash
chroma run --path ./chroma_db --host localhost --port 8000
```

Or with Docker:

```bash
docker run -p 8000:8000 -v ./chroma_db:/chroma/chroma chromadb/chroma
```

Index docs and code:

```bash
npx infimium index
```

Check status:

```bash
npx infimium status
```

Check setup health:

```bash
npx infimium doctor
```

Generate a grounded implementation plan:

```bash
npx infimium plan --dry-run "add rate limiting to the auth endpoint"
npx infimium plan --write "add rate limiting to the auth endpoint"
```

Serve MCP:

```bash
npx infimium serve
```

`infimium status` is not hardcoded. It reads local SQLite metadata and ChromaDB counts. If it shows `0 files`, run `npx infimium index` after setting `LOCAL_DOCS_PATH` and `CODEBASE_PATH`.

### Docker

```bash
cp .env.example .env
```

Set:

```bash
SEARCH_API_KEY=...
LOCAL_DOCS_PATH=./docs
CODEBASE_PATH=./code
```

Run:

```bash
./scripts/setup.sh
```

The setup script starts ChromaDB, starts Infimium, pulls `nomic-embed-text`, runs indexing, and prints the MCP config.

### Local development

Install dependencies:

```bash
npm install
```

Requires Node.js 22.5+.

Start Ollama:

```bash
ollama serve
ollama pull nomic-embed-text
```

Start ChromaDB on `http://localhost:8000`.

Create `.env`:

```bash
cp .env.example .env
```

Use local paths:

```bash
LOCAL_DOCS_PATH=/absolute/path/to/docs
CODEBASE_PATH=/absolute/path/to/code
OLLAMA_HOST=http://localhost:11434
CHROMADB_HOST=http://localhost:8000
```

Index:

```bash
npm run index
```

Serve:

```bash
npm start -- serve
```

Check status:

```bash
npm run status
```

Check setup:

```bash
npm run doctor
```

Plan a code change:

```bash
npm run plan -- --dry-run "add rate limiting to the auth endpoint"
```

## Tool brief

| Tool | Input | Requires | Output |
| --- | --- | --- | --- |
| `web_search` | `query`, `max_results` | Brave API key | ranked web results |
| `fetch_url` | `url`, `extract` | network access | cleaned Markdown/text |
| `query_local_docs` | `query`, `top_k` | indexed docs, Ollama, ChromaDB | matching document chunks |
| `semantic_code_search` | `query`, `language`, `top_k` | indexed code, Ollama, ChromaDB | matching symbols with file and line range |
| `dep_graph` | `symbol_name` | indexed code graph | definition file, importers, imports |
| `shell` | `command`, `cwd`, `timeout` | allowlisted command | stdout, stderr, exit code |
| `plan` | `task`, `dry_run`, `write_plan`, `output_path`, `top_k`, `language` | indexed code, Ollama, ChromaDB | implementation plan or retrieved context |
| `status` | none | local SQLite/ChromaDB state | index health summary |
| `doctor` | none | local environment | setup pass/fail report |

## Use the tools

After adding Infimium to Claude Desktop, Cursor, or Windsurf, ask the agent to use a specific Infimium tool by name. The MCP client sends the JSON input to Infimium; you do not call these tools with HTTP.

### `web_search`

Use it for current web results.

Prompt:

```text
Use Infimium web_search to find recent MCP server examples.
```

Tool input:

```json
{
  "query": "recent MCP server examples",
  "max_results": 5
}
```

Requires:

```bash
SEARCH_API_KEY=...
SEARCH_PROVIDER=brave
```

### `fetch_url`

Use it to fetch a page and extract readable content.

Prompt:

```text
Use Infimium fetch_url to fetch https://modelcontextprotocol.io and summarize it.
```

Tool input:

```json
{
  "url": "https://modelcontextprotocol.io",
  "extract": "markdown"
}
```

`extract` can be `markdown` or `text`.

### `query_local_docs`

Use it after indexing local documents.

Prompt:

```text
Use Infimium query_local_docs to find setup instructions for ChromaDB.
```

Tool input:

```json
{
  "query": "ChromaDB setup instructions",
  "top_k": 5
}
```

Before using:

```bash
LOCAL_DOCS_PATH=/absolute/path/to/docs
npm run index
```

### `semantic_code_search`

Use it to find code by meaning instead of exact text.

Prompt:

```text
Use Infimium semantic_code_search to find the price calculation logic.
```

Tool input:

```json
{
  "query": "price calculation logic",
  "language": "typescript",
  "top_k": 5
}
```

Before using:

```bash
CODEBASE_PATH=/absolute/path/to/code
npm run index
```

`language` is optional. Supported values depend on indexed files: `javascript`, `typescript`, `python`.

### `dep_graph`

Use it to see where a symbol is defined, who imports it, and what its file imports.

Prompt:

```text
Use Infimium dep_graph for calcPropertyValue.
```

Tool input:

```json
{
  "symbol_name": "calcPropertyValue"
}
```

Before using:

```bash
CODEBASE_PATH=/absolute/path/to/code
npm run index
```

### `shell`

Use it for safe, allowlisted local commands.

Prompt:

```text
Use Infimium shell to run git status.
```

Tool input:

```json
{
  "command": "git status",
  "cwd": "/absolute/path/to/repo",
  "timeout": 30
}
```

Allow commands explicitly:

```bash
SHELL_ALLOWLIST=ls,git,npm,npx
```

Blocked patterns include `rm -rf`, `sudo`, `curl`, `wget`, `eval`, and inline code execution.

### `plan`

Use it before editing code. It retrieves semantically relevant symbols, enriches them with dependency edges, and asks the local LLM for a safest-first implementation plan.

CLI dry run:

```bash
npx infimium plan --dry-run "add rate limiting to the auth endpoint"
```

Generate and write `plan.md`:

```bash
npx infimium plan --write "add rate limiting to the auth endpoint"
```

Tool input:

```json
{
  "task": "add rate limiting to the auth endpoint",
  "dry_run": false,
  "write_plan": true,
  "output_path": "plan.md",
  "top_k": 5
}
```

Before using:

```bash
npx infimium doctor
npx infimium index
```

Use `--dry-run` to inspect retrieved context without calling the LLM. If the context is bad, re-index before judging plan quality.

### `status`

Use it from the terminal to inspect local index health.

```bash
npm run status
```

### `doctor`

Use it first when setup feels broken.

```bash
npx infimium doctor
```

It checks, in order:

1. Node/npm version compatibility
2. Ollama installed and running
3. `nomic-embed-text` pulled
4. ChromaDB reachable
5. `.env` and required keys
6. whether the current repo has been indexed

Every failed check includes one copy-pasteable fix command. The command exits `1` if anything fails, so it works in scripts.

Example output:

```text
───────────────────────────
  Infimium status
───────────────────────────
  Docs         47 files · 312 chunks
  Code         847 symbols · 124 files
  Dep graph    312 relationships
  Projects     2 watched
  DB size      2.1 MB
  Last indexed 2 hours ago
───────────────────────────
```

## Connect to Claude Desktop

```json
{
  "mcpServers": {
    "infimium": {
      "command": "npx",
      "args": ["infimium", "serve"],
      "env": {
        "SEARCH_API_KEY": "your_brave_search_api_key",
        "LOCAL_DOCS_PATH": "/absolute/path/to/docs",
        "CODEBASE_PATH": "/absolute/path/to/code",
        "OLLAMA_HOST": "http://localhost:11434",
        "CHROMADB_HOST": "http://localhost:8000"
      }
    }
  }
}
```

## Connect to Cursor / Windsurf

```json
{
  "mcpServers": {
    "infimium": {
      "command": "npx",
      "args": ["infimium", "serve"],
      "env": {
        "SEARCH_API_KEY": "your_brave_search_api_key",
        "LOCAL_DOCS_PATH": "/absolute/path/to/docs",
        "CODEBASE_PATH": "/absolute/path/to/code",
        "OLLAMA_HOST": "http://localhost:11434",
        "CHROMADB_HOST": "http://localhost:8000"
      }
    }
  }
}
```

## Pricing

Self-host free forever (MIT). Need us to run it for you?

infimium.ai — starts at $12/mo, 14-day trial, no free hosted tier.

Paid hosted glimpse:

- Managed indexing workers for large repos and doc sets.
- Hosted project memory and `plan.md` generation.
- Team dashboards for index freshness, tool usage, and failures.
- Priority language/parser support.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md)

Adding a new language? Start here.
