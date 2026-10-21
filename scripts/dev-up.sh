#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "Ensuring shared proxy network exists..."
./scripts/ensure-proxy-network.sh

echo "Starting docker compose stack (streaming + web + traefik)..."
docker compose up -d

HOST_URL="http://localhost:5173/host"

echo "Waiting for web dev server at ${HOST_URL}..."
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:5173" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "Opening host page: ${HOST_URL}"
if command -v open > /dev/null 2>&1; then
  open "$HOST_URL"
elif command -v xdg-open > /dev/null 2>&1; then
  xdg-open "$HOST_URL"
else
  echo "Could not auto-open a browser. Visit ${HOST_URL} manually."
  echo "Viewer page: http://localhost:5173/viewer"
fi

echo "Streaming server: http://localhost:4000/health"
echo "Tail logs with: docker compose logs -f"