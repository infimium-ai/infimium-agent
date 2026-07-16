#!/bin/bash
set -e

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker and rerun this script." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is required. Install Docker Compose and rerun this script." >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env — add your SEARCH_API_KEY"
fi

docker compose up -d

for i in {1..30}; do
  if curl -fsS http://localhost:8000/api/v1/heartbeat >/dev/null 2>&1; then
    break
  fi

  if [ "$i" -eq 30 ]; then
    echo "ChromaDB did not become healthy within 30 seconds." >&2
    exit 1
  fi

  sleep 1
done

docker compose exec infimium npm run index

echo ""
echo "✓ Infimium is ready."
echo ""
echo "Add to Claude Desktop config (~/.config/claude/claude_desktop_config.json):"
cat examples/claude_desktop_config.json
