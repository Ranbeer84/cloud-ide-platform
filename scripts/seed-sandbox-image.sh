#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${SANDBOX_IMAGE_TAG:-live/sandbox-base:latest}"
BASE_IMAGE="${SANDBOX_RUNTIME_BASE:-node:20-bookworm}"
BUILD_CONTEXT="$REPO_ROOT/packages/sandbox-agent"
STATUS_SCRIPT="$REPO_ROOT/scripts/sandbox-image-status.sh"

if ! command -v docker > /dev/null 2>&1; then
  echo "docker is required but was not found on PATH." >&2
  exit 1
fi

# An archive is the supported bootstrap path for hosts whose registry route is
# unavailable.  It is deliberately loaded before checking freshness so it can
# satisfy a clean host without any registry access.
if [ -n "${SANDBOX_IMAGE_ARCHIVE:-}" ] && [ -f "$SANDBOX_IMAGE_ARCHIVE" ]; then
  echo "Loading sandbox image archive: ${SANDBOX_IMAGE_ARCHIVE}"
  docker load -i "$SANDBOX_IMAGE_ARCHIVE"
fi

if "$STATUS_SCRIPT" status; then
  echo "Reusing verified local sandbox image; no registry request was made."
  exit 0
fi

if [ "${SANDBOX_OFFLINE:-0}" = "1" ]; then
  echo "Sandbox image is not current and SANDBOX_OFFLINE=1 forbids a build." >&2
  echo "Create an archive on a healthy machine with scripts/export-sandbox-image.sh," >&2
  echo "copy it to this host, then set SANDBOX_IMAGE_ARCHIVE=/path/to/sandbox-image.tar." >&2
  exit 1
fi

# Fail before invoking docker build when the base is absent.  Docker's usual
# error otherwise looks like a build error even though it is a registry outage.
if ! docker image inspect "$BASE_IMAGE" > /dev/null 2>&1; then
  echo "Required local base image is missing: ${BASE_IMAGE}" >&2
  echo "This build is intentionally configured not to pull it automatically." >&2
  echo "On a machine with registry access run: docker pull ${BASE_IMAGE}" >&2
  echo "Or import a prepared sandbox image: SANDBOX_IMAGE_ARCHIVE=/path/to/sandbox-image.tar $0" >&2
  exit 1
fi

SOURCE_SHA="$($STATUS_SCRIPT --print-source-sha)"
BASE_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$BASE_IMAGE")"

echo "Building sandbox base image: ${IMAGE_TAG}"
echo "Build context: ${BUILD_CONTEXT}"
echo "Using local base image: ${BASE_IMAGE} (${BASE_IMAGE_ID})"

docker build \
  --pull=false \
  --build-arg "SANDBOX_RUNTIME_BASE=${BASE_IMAGE}" \
  --build-arg "SANDBOX_SOURCE_SHA=${SOURCE_SHA}" \
  --build-arg "SANDBOX_BASE_IMAGE_ID=${BASE_IMAGE_ID}" \
  -f "${BUILD_CONTEXT}/Dockerfile.sandbox-base" \
  -t "${IMAGE_TAG}" \
  "${BUILD_CONTEXT}"

"$STATUS_SCRIPT" status
echo "Built and verified ${IMAGE_TAG}"
docker image inspect "${IMAGE_TAG}" --format 'Image ID: {{.Id}}' 2>/dev/null || true
