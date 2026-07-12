# Infimium To-Do

## Current Checkpoints

- [ ] Create a Brave Search API key and paste it into `.env` as `SEARCH_API_KEY=...`.
- [ ] Keep `SEARCH_PROVIDER=brave` in `.env`.
- [ ] Start a local ChromaDB server before running `infimium index`.
- [ ] Set `LOCAL_DOCS_PATH=/path/to/docs` in `.env` before indexing docs.
- [ ] Run `npm test` after each tool implementation.

## Done

- [x] Implemented the `web_search` tool using Brave Search.
- [x] Added mocked unit tests for normal, empty, and API-error Brave responses.
- [x] Implemented the `fetch_url` tool using native fetch, Cheerio, and Turndown.
- [x] Added mocked unit tests for HTML extraction, 404 handling, and timeout handling.
- [x] Implemented the `shell` tool using allowlisted `spawn` execution.
- [x] Added shell tests for allowlist, blocked patterns, unknown commands, and timeout.
- [x] Implemented the local document indexer with glob, pdf-parse, Ollama embeddings, and ChromaDB storage.
- [x] Added `infimium index` CLI command for document indexing progress and summary output.
- [x] Implemented `query_local_docs` using Ollama embeddings and ChromaDB reads.
- [x] Added query-local-docs tests for formatting, adjacent deduplication, empty collection, and ChromaDB down.
