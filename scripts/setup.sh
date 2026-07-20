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
  echo "Created .env. Tinyfish SEARCH_API_KEY is optional for web_search."
fi

docker compose up -d chromadb

for i in {1..30}; do
  if curl -fsS http://localhost:8000/api/v2/heartbeat >/dev/null 2>&1 || curl -fsS http://localhost:8000/api/v1/heartbeat >/dev/null 2>&1; then
    break
  fi

  if [ "$i" -eq 30 ]; then
    echo "ChromaDB did not become healthy within 30 seconds." >&2
    exit 1
  fi

  sleep 1
done

docker compose build infimium
docker compose run --rm infimium npm run index

echo ""
echo "✓ Infimium is ready."
echo ""
echo "Add this MCP server to Cursor, Windsurf, or Claude Desktop:"
cat <<EOF
{
  "mcpServers": {
    "infimium": {
      "command": "docker",
      "args": [
        "compose",
        "-f",
        "$(pwd)/docker-compose.yml",
        "run",
        "--rm",
        "-T",
        "infimium",
        "npm",
        "start",
        "--",
        "serve"
      ]
    }
  }
}
EOF
