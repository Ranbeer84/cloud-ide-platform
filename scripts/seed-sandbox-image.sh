#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${SANDBOX_IMAGE_TAG:-live/sandbox-base:latest}"
BUILD_CONTEXT="$REPO_ROOT/packages/sandbox-agent"

if ! command -v docker > /dev/null 2>&1; then
  echo "docker is required but was not found on PATH." >&2
  exit 1
fi

echo "Building sandbox base image: ${IMAGE_TAG}"
echo "Build context: ${BUILD_CONTEXT}"

docker build \
  -f "${BUILD_CONTEXT}/Dockerfile.sandbox-base" \
  -t "${IMAGE_TAG}" \
  "${BUILD_CONTEXT}"

echo "Built ${IMAGE_TAG}"
docker image inspect "${IMAGE_TAG}" --format 'Image ID: {{.Id}}' 2>/dev/null || true
