<p align="center">
  <img src="public/infimium-logo.png" alt="Infimium" width="110" />
</p>

# Infimium

Private context layer for AI agents. Web search, local docs, semantic code search, dependency graph, memory, and planning from one MCP server on your machine.

[![npm version](https://img.shields.io/npm/v/infimium.svg)](https://www.npmjs.com/package/infimium)
[![MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/infimium-ai/infimium-agent.svg?style=social)](https://github.com/infimium-ai/infimium-agent)

## Demo

[![Infimium demo](docs/assets/infimium-demo.gif)](docs/assets/infimium-demo.mp4)

[Watch the full demo video](docs/assets/infimium-demo.mp4)

## Why

Agents lose context when repos get big. They either read too much, burn tokens, or miss the real function because keyword search is not enough.

```text
200,000 lines of code
Agent reads everything -> context blown + expensive
grep "price calculation" -> misses calcPropertyValue()
```

With Infimium, the agent asks targeted tools first:

```text
tool: semantic_code_search
query: "price calculation logic"

-> services/property/calc.ts:142 · calcPropertyValue()
-> imported by: listing.ts, tax.ts, pdf-generator.ts, calc.test.ts
```

## What Works Now

- MCP server with 11 tools.
- CLI for the same tools.
- Local code/doc indexing with Ollama + ChromaDB for JavaScript, TypeScript, Python, and Dart.
- Dependency graph from imports.
- Automatic exclusion of build output, dependencies, caches, Flutter artifacts, and binaries.
- Auto-index while the MCP server runs.
- Project memory across chats, agents, and IDEs.
- Project-scoped YAML context with repo overview, task, Git state, and index health.
- Setup checker with copy-paste fixes: `npx infimium doctor`.

## Quick Start

Beginner path: install Docker, then run one command.

```bash
git clone https://github.com/infimium-ai/infimium-agent.git
cd infimium-agent
./scripts/setup.sh
```

This creates `.env`, starts ChromaDB/Ollama, pulls `nomic-embed-text`, indexes the repo, and prints MCP config.

Optional web search:

```env
SEARCH_PROVIDER=tinyfish
SEARCH_API_KEY=your_tinyfish_key
```

No search key? Fine. Code search, docs search, dep graph, memory, context, fetch, shell, status, and doctor still work.

Infimium respects `.gitignore`. Add optional project-specific exclusions to `.infimiumignore`.

## Connect To Cursor, Windsurf, Or Claude

Use the config printed by `./scripts/setup.sh`, or paste this and change the path:

```json
{
  "mcpServers": {
    "infimium": {
      "command": "npx",
      "args": ["infimium", "serve"],
      "env": {
        "CODEBASE_PATH": "/absolute/path/to/your/repo",
        "LOCAL_DOCS_PATH": "/absolute/path/to/your/repo/docs",
        "CHROMADB_HOST": "http://localhost:8000",
        "OLLAMA_HOST": "http://localhost:11434",
        "SHELL_ALLOWLIST": "ls,git,pwd,npm,npx"
      }
    }
  }
}
```

Restart your IDE after editing MCP config.

First prompt to test:

```text
Use Infimium hello_infimium.
Use Infimium get_context before starting.
Use Infimium semantic_code_search to explain this repo.
```

If the agent is in a different workspace than the MCP server, ask it to pass `project_path` once. Infimium remembers that as the active project.

## Tools

| Tool | Use |
| --- | --- |
| `hello_infimium` | Health check. Returns `hey-dude`. |
| `web_search` | Tinyfish web search. Requires `SEARCH_API_KEY`. |
| `fetch_url` | Fetch a URL and extract readable Markdown/text. |
| `query_local_docs` | Search indexed `.md`, `.txt`, `.html`, and `.pdf` docs. |
| `semantic_code_search` | Search code by meaning and return compact symbol signatures. |
| `expand_symbol` | Load one full implementation after semantic search identifies it. |
| `dep_graph` | Find where a symbol is defined, who imports it, and what it imports. |
| `shell` | Run allowlisted shell commands with timeout and output caps. |
| `plan` | Build a grounded implementation plan from code search + dep graph context. |
| `project_memory` | Save or resume task notes across chats and IDEs. |
| `get_context` | Return compact repo context: task, memory, index health, git changes, touched files. |

## CLI

```bash
npx infimium doctor
npx infimium status
npx infimium index
npx infimium watch
npx infimium hello
npx infimium search "latest MCP registry news"
npx infimium fetch https://example.com
npx infimium code-search "context layer writer"
npx infimium expand-symbol ContextLayerWriter
npx infimium docs-search "setup"
npx infimium dep-graph startServer
npx infimium plan --dry-run "add rate limiting"
npx infimium remember "Finished setup" --type progress --task "Launch prep"
npx infimium resume
npx infimium get-context                    # YAML by default
npx infimium get-context --format json      # optional compatibility output
```

Check health:

```bash
npx infimium doctor
```

Expected shape:

```text
1. ✅ Node/npm version
2. ✅ Ollama
3. ✅ Required embedding model
4. ✅ ChromaDB
5. ✅ Config/env
6. ✅ Index status
Summary: 6/6 checks passed
```

## Manual Local Setup

Use this only if Docker setup fails.

```bash
npm install
cp .env.example .env
docker compose up -d chromadb
ollama serve
ollama pull nomic-embed-text
npm run build
npx infimium index
npx infimium doctor
```

Minimal `.env`:

```env
SEARCH_PROVIDER=tinyfish
SEARCH_API_KEY=
LOCAL_DOCS_PATH=./docs
CODEBASE_PATH=.
SHELL_ALLOWLIST=ls,git,pwd,npm,npx
OLLAMA_HOST=http://localhost:11434
CHROMADB_HOST=http://localhost:8000
INFIMIUM_AUTO_INDEX=true
```

## If Setup Fails

Paste this into Cursor, Claude Code, Codex, or any coding agent:

```text
Set up Infimium in this repo.

Run ./scripts/setup.sh. If it fails, fix the missing dependency.
Make .env exist.
Start ChromaDB.
Start Ollama.
Pull nomic-embed-text.
Run npx infimium index.
Run npx infimium doctor and make all 6 checks pass.
Show me the MCP JSON for this machine.
Do not commit secrets.
```

## How The Context Layer Works

Infimium indexes your repo into:

- SQLite: index metadata, project memory, dependency graph.
- ChromaDB: local vector search over docs and code symbols.
- `context/<projectId>/layer.md`: compact YAML handoff for the active project.

The context includes a centralized repo overview, current task, recent memory, project-only index health, and a capped summary of relevant Git activity. When `infimium serve` is running, it refreshes every 5 minutes and auto-indexes changed files. A fresh agent should call `get_context` first, use `semantic_code_search` for signatures, and call `expand_symbol` only when full code is required.

## Privacy

Self-hosted means your code index, embeddings, docs, dependency graph, and memory stay on your machine.

- Embeddings run locally with Ollama.
- ChromaDB and SQLite run locally.
- Web search only sends the search query to your configured provider.
- Telemetry is off unless configured in a future release.

## Upcoming MCP Tools

`code_review` — review a change and its graph-connected impact, not the entire repository.

It extends the Infimium context layer by combining semantic code search, dependency graph context, and changed-file detection. The goal is grounded reviews with less unnecessary context usage across Cursor, Claude, Codex, Windsurf, and other MCP-compatible agents.

## Paid Hosted Glimpse

Self-host is free forever under MIT.

Hosted Infimium will focus on:

- managed indexing for teams,
- shared project memory,
- larger repo indexing workers,
- team dashboards for index health and tool usage.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md)

Adding a new language? Start there.

Future architecture work is tracked in [docs/roadmap.md](docs/roadmap.md).
