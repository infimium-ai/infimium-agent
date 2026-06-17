<div align="center">

<img src="public/infimium_logo.png" alt="infimium.ai" width="120" height="120"/>

# infimium

**Private search infrastructure for AI agents.**

Web search · Local RAG · Semantic code search · Dependency graph  
One self-hostable MCP server. Runs inside your firewall. Zero data egress.

[![License: MIT](https://img.shields.io/badge/License-MIT-6366f1.svg)](https://opensource.org/licenses/MIT)
[![Python](https://img.shields.io/badge/Python-3.11+-6366f1?logo=python&logoColor=white)](https://python.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-6366f1)](https://modelcontextprotocol.io)
[![Discord](https://img.shields.io/badge/Discord-Join-6366f1?logo=discord&logoColor=white)](https://discord.gg/infimium)
[![Stars](https://img.shields.io/github/stars/infimium-ai/infimium?color=6366f1)](https://github.com/infimium-ai/infimium/stargazers)

[Website](https://infimium.ai) · [Docs](https://infimium.ai/docs) · [Discord](https://discord.gg/infimium) · [Join Waitlist](https://infimium.ai/#waitlist)

---

![infimium demo](public/demo.gif)

</div>

---

## What is infimium?

AI agents need to search — the web, your docs, and your codebase. Today that means stitching together 3–5 different APIs, all of which send your data to the cloud.

**infimium is one MCP server that does all of it, locally.**

```bash
# Connect once in your claude_desktop_config.json or cursor settings
# Then your agent can call:

infimium_search("latest HTTP/3 spec changes")          # web search + cited context
infimium_fetch("https://docs.stripe.com/api")          # clean text from any URL  
infimium_query_docs("onboarding flow", ns="internal")  # local doc RAG
infimium_code_search("price calculation logic")         # semantic code search ⭐
infimium_deps("services/property/calc.js")             # dependency graph ⭐
infimium_understand("what does this codebase do?")     # full codebase map ⭐
infimium_shell(cmd="ripgrep", pattern="TODO")          # shell tools
```

Everything runs on your machine. Your code, your docs, and your embeddings **never leave your infrastructure.**

---

## The problem we solve

### For AI agents
```
Without infimium                    With infimium
─────────────────────────────────   ─────────────────────────────────
Agent reads 200,000 lines           Agent calls infimium_code_search()
→ Context limit blown               → Gets back: calc.js line 142–189
→ Thousands of tokens wasted        → Reads 47 lines. Done.
→ Hallucination on stale code       → Accurate. Fast. Local.
```

### For developers joining a new codebase
```
Without infimium                    With infimium
─────────────────────────────────   ─────────────────────────────────
2 weeks reading files               1 day with infimium_understand()
Grep-ing for "price" hoping         "Feature: Property Pricing → 7 files
  to find calcPropertyValue()         Core: services/property/calc.js
Ask senior dev for context            calcPropertyValue() → tax + discounts"
```

---

## Features

### 🌐 Web Search
Real-time web search via SerpAPI or Brave Search. Results are fetched, cleaned, ranked by relevance to your query, trimmed to a token budget, and returned with inline citations `[1][2]`.

### 📄 URL Fetcher  
`httpx` for static pages, `Playwright` for JS-heavy SPAs. HTML is cleaned via `trafilatura` — no nav, no ads, just the content. Per-session cache, 10s timeout.

### 📚 Local Doc RAG
Embed your markdown files, PDFs, and text documents with `sentence-transformers`. Indexed in `ChromaDB` locally. Query by semantic similarity. Fully offline. Private namespaces per team.

### 🔍 Semantic Code Search ⭐
`tree-sitter` parses your entire codebase into AST chunks (functions, classes, blocks). Each chunk is embedded with `nomic-embed-code`. Search by what code **does**, not what it's named.

```
Query: "real estate price calculation logic"
Match: services/property/calc.js → calcPropertyValue() → line 142–189
Confidence: 0.94
```

Works on codebases with 200,000+ lines. Query time is under 2 seconds.

### 🕸️ Dependency Graph ⭐
AST import resolution stored in SQLite. Know not just **where** the code lives but **what breaks if you change it**.

```json
{
  "file": "services/property/calc.js",
  "dependents": [
    "api/routes/listing.js",
    "utils/tax.js", 
    "reports/pdf_generator.js",
    "tests/calc.test.js"
  ],
  "dependencies": [
    "utils/constants.js → PROPERTY_TAX_RATE"
  ]
}
```

### 🧠 Codebase Intelligence ⭐
Ask infimium what a codebase does. It maps every file, summarizes every function, and groups them into features — entirely on your machine.

```
infimium_understand("what does this codebase do?")

→ This is a real estate platform. 4 feature areas:

  1. Property Pricing (7 files)
     Core: services/property/calc.js
     calcPropertyValue() → applies tax + area pricing + discounts

  2. User Auth (5 files)
     Core: auth/jwt.js — login, token refresh, RBAC

  3. PDF Reports (3 files)  
     Core: reports/pdf_generator.js — depends on pricing + property data

  4. Admin Dashboard (12 files)
     Core: pages/admin/index.js
```

New dev understands the entire codebase in one day instead of two weeks.

### 🐚 Shell Tools
Direct wrappers for `ripgrep`, `git log`, `find`. Exact pattern matching and git history lookups. Complements semantic search for precise queries.

---

## Why not just use Tavily / Exa / Perplexity?

| | Tavily | Exa | Perplexity | Cursor | **infimium** |
|---|:---:|:---:|:---:|:---:|:---:|
| Web search | ✅ | ✅ | ✅ | ➖ | ✅ |
| Local doc RAG | ❌ | ❌ | ❌ | ✅ | ✅ |
| Semantic code search | ❌ | ❌ | ❌ | ✅ | ✅ |
| Dependency graph | ❌ | ❌ | ❌ | ❌ | ✅ |
| Codebase intelligence | ❌ | ❌ | ❌ | ❌ | ✅ |
| Self-hostable | ❌ | ❌ | ❌ | ❌ | ✅ |
| Zero data egress | ❌ | ❌ | ❌ | ❌ | ✅ |
| MCP native | ✅ | ✅ | ➖ | ❌ | ✅ |
| Free tier | ➖ | ➖ | ❌ | ➖ | ✅ MIT |

Tavily, Exa, and Perplexity are web-only and cloud-only. Cursor's code indexing is locked inside their editor. **infimium is the only tool that does web + code + docs in one private MCP server.**

---

## Quickstart

### 1. Install

```bash
pip install infimium
```

Or with Docker (recommended):

```bash
git clone https://github.com/infimium-ai/infimium
cd infimium
docker-compose up
```

### 2. Index your codebase

```bash
infimium index ./your-project
# Parsing files... ████████████████ 2,847 files
# Building embeddings... (one-time, ~15 mins for 200k lines)
# Building dependency graph...
# Done. Index stored at ~/.infimium/index.db
```

### 3. Connect to Claude Code

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "infimium": {
      "command": "infimium",
      "args": ["serve"],
      "env": {
        "INFIMIUM_REPO": "/path/to/your/project",
        "INFIMIUM_DOCS": "/path/to/your/docs",
        "SEARCH_API_KEY": "your-serpapi-or-brave-key"
      }
    }
  }
}
```

### 4. Connect to Cursor

Add to your Cursor MCP settings:

```json
{
  "infimium": {
    "command": "infimium serve --transport stdio"
  }
}
```

That's it. Your agent now has web search, codebase intelligence, and local RAG.

---

## Configuration

```toml
# infimium.toml

[core]
model = "ollama/llama3.2"        # local model via Ollama
transport = "stdio"              # stdio | sse
port = 8765                      # for SSE transport

[search]
provider = "brave"               # brave | serpapi
api_key = "your-key-here"
max_results = 10
depth = "standard"               # standard | deep

[code]
repo_path = "./src"
languages = ["python", "typescript", "go", "rust"]
embed_model = "nomic-embed-code"
index_path = "~/.infimium/index.db"
watch = true                     # auto re-index on file change

[rag]
docs_path = "./docs"
namespace = "default"
embed_model = "sentence-transformers/all-MiniLM-L6-v2"
chunk_size = 512
chunk_overlap = 64

[context]
token_budget = 12000             # max tokens sent to LLM
rerank = true                    # hybrid BM25 + vector reranking
```

---

## Architecture

```
MCP Clients (Claude Code · Cursor · Windsurf · custom agents)
        │
        │  MCP protocol (stdio / SSE)
        ▼
┌───────────────────────────────────────────────────────┐
│                  Infimium MCP Server                  │
│         7 tools exposed as MCP endpoints              │
└───────────────────────┬───────────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────────────┐
│                    Orchestrator                       │
│     Intent parse · Query plan · Tool dispatch         │
│     Context builder · Token budget · Citations        │
└──┬──────────┬──────────┬──────────┬──────────┬────────┘
   │          │          │          │          │
   ▼          ▼          ▼          ▼          ▼
Web        URL        Local      Code      Dep
Search    Fetcher      RAG      Search    Graph
SerpAPI   httpx/    ChromaDB  tree-sitter SQLite
/Brave    Playwright sentence-  nomic-    AST
          trafilatr  transformr  embed    imports
                        │          │         │
                        └──────────┴─────────┘
                                   │
                              ~/.infimium/
                              (all local)
```

---

## Security

infimium is built privacy-first. Here's exactly what leaves your machine:

| Data | Leaves machine? |
|---|---|
| Your source code | ❌ Never |
| Code embeddings | ❌ Never |
| Dependency graph | ❌ Never |
| Local documents | ❌ Never |
| Doc embeddings | ❌ Never |
| Web search query | ✅ Query string only (anonymised) |
| Fetched URL content | ❌ Never — goes directly to agent |

**infimium never stores, logs, or transmits your private code or documents.**

This is why infimium is the only option for teams in banking, healthtech, defence, and govtech — cloud-only competitors are legally blocked from those customers.

---

## Roadmap

- [x] Web search + URL fetcher
- [x] Local doc RAG
- [x] MCP server (stdio + SSE)
- [ ] Semantic code search (Python, TypeScript, Go)
- [ ] Dependency graph
- [ ] Codebase intelligence (`infimium_understand()`)
- [ ] File watcher (auto re-index on change)
- [ ] More language grammars (Rust, Java, Dart)
- [ ] Notion / Confluence as RAG sources
- [ ] Team namespaces
- [ ] infimium.ai hosted cloud tier

---

## Contributing

infimium is MIT licensed and built in public. Contributions welcome.

```bash
git clone https://github.com/infimium-ai/infimium
cd infimium
pip install -e ".[dev]"
pre-commit install
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.  
Join the [Discord](https://discord.gg/infimium) to discuss ideas and get help.

---

## Self-hosting vs infimium.ai

| | Self-host (free) | [infimium.ai](https://infimium.ai) Pro |
|---|---|---|
| All 7 MCP tools | ✅ | ✅ |
| Local Ollama models | ✅ | ✅ |
| Web searches/day | 50 | Unlimited |
| Hosted MCP endpoint | ❌ | ✅ |
| Uptime SLA | ❌ | ✅ |
| Team namespaces | ❌ | ✅ |
| Cloud model routing | ❌ | ✅ |
| Support | Community | Priority |
| Price | Free | $12/mo |

[Join the waitlist →](https://infimium.ai/#waitlist)

---

## License

MIT © [infimium-ai](https://github.com/infimium-ai)

---

<div align="center">

Built by [@aryankumar06](https://github.com/aryankumar06) · [infimium.ai](https://infimium.ai) · [Star us ⭐](https://github.com/infimium-ai/infimium)

</div>
