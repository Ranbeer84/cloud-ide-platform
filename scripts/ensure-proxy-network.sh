#!/usr/bin/env bash
set -euo pipefail

NETWORK_NAME="${PROXY_NETWORK_NAME:-live-network}"

if ! command -v docker > /dev/null 2>&1; then
  echo "docker is required but was not found on PATH." >&2
  exit 1
fi

if docker network inspect "$NETWORK_NAME" > /dev/null 2>&1; then
  echo "Docker network '${NETWORK_NAME}' already exists."
else
  echo "Creating Docker network '${NETWORK_NAME}'..."
  docker network create --driver bridge "$NETWORK_NAME"
fi