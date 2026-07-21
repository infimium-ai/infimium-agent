#!/bin/bash
set -e

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22.5+ is required. Install it from https://nodejs.org and rerun." >&2
  exit 1
fi

npm ci
npm run build
node dist/src/index.js init

if ! command -v ollama >/dev/null 2>&1; then
  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew install ollama
  else
    curl -fsSL https://ollama.com/install.sh | sh
  fi
fi

if ! curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1; then
  ollama serve >/tmp/infimium-ollama.log 2>&1 &
  sleep 3
fi

ollama pull nomic-embed-text
node dist/src/index.js index

echo ""
echo "Infimium is ready. Run: npx infimium doctor"
