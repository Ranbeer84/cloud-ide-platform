#!/usr/bin/env bash
# Pulls every registry image the gates need, with retries, BEFORE you run them.
# Images that are already on this machine are skipped, so it is cheap to re-run.
#
#   bash scripts/prefetch-images.sh          # through Phase 7
#   bash scripts/prefetch-images.sh --all    # also the Phase 8 images
#   PULL_ATTEMPTS=8 bash scripts/prefetch-images.sh
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
# shellcheck source=scripts/lib/docker-net.sh
. scripts/lib/docker-net.sh

IMAGES=("${REQUIRED_IMAGES[@]}")
[ "${1:-}" = "--all" ] && IMAGES+=("${OPTIONAL_IMAGES[@]}")
ATTEMPTS="${PULL_ATTEMPTS:-5}"

docker info > /dev/null 2>&1 || { echo "FAIL: cannot talk to Docker (run: bash scripts/doctor.sh)" >&2; exit 1; }

FAILED=()
for image in "${IMAGES[@]}"; do
  if docker image inspect "$image" > /dev/null 2>&1; then
    echo "  have:   $image"
    continue
  fi
  printf '  pulling %s (up to %s attempts)...\n' "$image" "$ATTEMPTS"
  if docker_pull_retry "$image" "$ATTEMPTS"; then
    echo "  pulled: $image"
  else
    echo "  FAILED: $image"
    echo "$PULL_LOG" | grep -vE '^$|docker run --help' | tail -n 3 | sed 's/^/          /'
    echo "          -> $(explain_pull_error "$PULL_LOG")"
    FAILED+=("$image")
  fi
done

echo
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "prefetch: ${#FAILED[@]} image(s) could not be pulled: ${FAILED[*]}"
  echo "Fix the cause above, then run this again; it only retries what is missing."
  exit 1
fi
echo "prefetch: all images are on this machine; the gates will not need the registry."
