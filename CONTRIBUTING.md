# Contributing

## Add a tree-sitter language

1. Install the grammar package:

   ```bash
   npm install tree-sitter-<language>
   ```

2. Add the file extension mapping in `src/indexer/code-parser.ts`.

3. Import the grammar in `src/indexer/code-parser.ts`.

4. Update the parser language switch so the new extension loads the new grammar.

5. Add symbol extraction for the language:
   - functions
   - classes
   - methods
   - language-specific function forms worth indexing

6. Add a fixture in `tests/fixtures/`.

7. Add parser assertions in `tests/code-parser.test.ts`.

8. If indexing metadata changes, update `tests/code-indexer.test.ts`.

## Run tests

Unit tests:

```bash
npm test
```

Integration tests:

```bash
RUN_INTEGRATION=true npm test
```

Integration tests may require Ollama, `nomic-embed-text`, and ChromaDB.

## PR checklist

- Tests pass.
- Types are clean.
- One thing per PR.
