#!/usr/bin/env bash
# Report whether the locally tagged sandbox image was built from this checkout.
#
# Exit status: 0 current, 2 missing, 3 stale/unidentified, 4 bad invocation.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_CONTEXT="$REPO_ROOT/packages/sandbox-agent"
IMAGE_TAG="${SANDBOX_IMAGE_TAG:-live/sandbox-base:latest}"

source_sha() {
  (
    cd "$BUILD_CONTEXT"
    {
      printf '%s\n' Dockerfile.sandbox-base package.json tsconfig.json
      find src -type f -print
    } | LC_ALL=C sort | while IFS= read -r file; do
      printf '%s\0' "$file"
      sha256sum "$file" | awk '{print $1}'
    done
  ) | sha256sum | awk '{print $1}'
}

case "${1:-status}" in
  --print-source-sha)
    source_sha
    exit 0
    ;;
  status) ;;
  *)
    echo "usage: $0 [status|--print-source-sha]" >&2
    exit 4
    ;;
esac

expected_sha="$(source_sha)"
if ! docker image inspect "$IMAGE_TAG" > /dev/null 2>&1; then
  echo "sandbox image is missing: $IMAGE_TAG"
  exit 2
fi

actual_sha="$(docker image inspect --format '{{ index .Config.Labels "org.live.sandbox.source-sha" }}' "$IMAGE_TAG" 2>/dev/null || true)"
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "sandbox image is stale or predates build identity labels: $IMAGE_TAG"
  echo "  expected source sha: $expected_sha"
  echo "  image source sha:    ${actual_sha:-<none>}"
  exit 3
fi

echo "sandbox image is current: $IMAGE_TAG (source sha $actual_sha)"
