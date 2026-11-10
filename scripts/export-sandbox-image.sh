#!/usr/bin/env bash
# Create a portable, verified sandbox image for an offline Docker host.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${SANDBOX_IMAGE_TAG:-live/sandbox-base:latest}"
OUTPUT_PATH="${1:-$REPO_ROOT/sandbox-image.tar}"

"$REPO_ROOT/scripts/seed-sandbox-image.sh"
mkdir -p "$(dirname "$OUTPUT_PATH")"
docker save --output "$OUTPUT_PATH" "$IMAGE_TAG"
echo "Wrote verified sandbox image archive: $OUTPUT_PATH"
echo "On the target host: SANDBOX_IMAGE_ARCHIVE=$OUTPUT_PATH bash scripts/seed-sandbox-image.sh"
