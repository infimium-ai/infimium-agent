# Contributing

## Add a tree-sitter language

1. Decide whether the grammar should be bundled or downloaded on demand. Prefer on-demand WASM for new languages.

2. Add the file extension and grammar name in `src/indexer/code-parser.ts` and `src/indexer/dynamic-grammar.ts`.

3. Add symbol-node mappings for functions, classes, and methods.

4. Add the extension to the code indexer and dependency graph globs.

5. Add a fixture in `tests/fixtures/`.

6. Add parser assertions in `tests/code-parser.test.ts`.

7. If downloading a grammar, test cache reuse and invalid WASM handling in `tests/dynamic-grammar.test.ts`.

## Run tests

Unit tests:

```bash
npm test
```

Integration tests:

```bash
RUN_INTEGRATION=true npm test
```

Integration tests may require Ollama and `nomic-embed-text`. Vector storage is embedded; no external database is required.

## PR checklist

- Tests pass.
- Types are clean.
- One thing per PR.
