#!/bin/sh
set -e

ollama serve &
OLLAMA_PID=$!

cleanup() {
  kill "$OLLAMA_PID" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

for i in $(seq 1 30); do
  if curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1; then
    break
  fi

  if [ "$i" -eq 30 ]; then
    echo "Ollama did not become ready within 30 seconds." >&2
    exit 1
  fi

  sleep 1
done

ollama pull nomic-embed-text

npm start -- serve
