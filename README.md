# Infimium

Private search MCP for AI agents. Web · code · local docs · dependency graph — one endpoint, your machine.

[![npm version](https://img.shields.io/npm/v/infimium.svg)](https://www.npmjs.com/package/infimium)
[![MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/infimium/infimium.svg?style=social)](https://github.com/infimium/infimium)

## The problem

```
200,000 lines of code
Agent reads everything → 💀 context blown + $$$
grep "price calculation" → misses calcPropertyValue()
```

## With Infimium

```
tool: semantic_code_search
query: "price calculation logic"

→ services/property/calc.ts:142 · calcPropertyValue()
→ imported by: listing.ts, tax.ts, pdf-generator.ts, calc.test.ts
```

## The 7 tools

`web_search` — Brave web search with retry and concise source snippets.

`fetch_url` — fetches HTML, strips noise, returns Markdown or text.

`query_local_docs` — local document RAG over `.md`, `.txt`, `.html`, and `.pdf`.

`semantic_code_search` — differentiator: tree-sitter symbols + local embeddings for meaning-based code search.

`dep_graph` — differentiator: SQLite import graph for "where is this defined and who imports it?"

`shell` — allowlisted command runner with blocked patterns, timeout, and output caps.

`plan` — scans changed projects, disambiguates, writes plan.md, hands it to Cursor or Claude Code.

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

## Connect to Claude Desktop

```json
{
  "mcpServers": {
    "infimium": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/infimium/src/index.ts", "serve"],
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
      "args": ["tsx", "/absolute/path/to/infimium/src/index.ts", "serve"],
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

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md)

Adding a new language? Start here.
