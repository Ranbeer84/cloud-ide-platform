#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; exit 1; }

if ! command -v docker > /dev/null 2>&1; then
  fail "docker is required to run Phase 2 verification but was not found on PATH"
fi

echo "== Phase 2 verify: Phase 1 regression suite (includes Phase 0) =="
bash phases/p1-sandbox-execution/verify.sh
pass "Phase 1 regression suite"
echo

echo "== Phase 2 verify: pnpm install =="
pnpm install --frozen-lockfile=false > /tmp/p2-install.log 2>&1 \
  && pass "pnpm install" \
  || { cat /tmp/p2-install.log; fail "pnpm install"; }
echo

echo "== Phase 2 verify: build all packages (incl. updated sandbox-agent + web) =="
pnpm run build > /tmp/p2-build.log 2>&1 \
  && pass "pnpm build" \
  || { cat /tmp/p2-build.log; fail "pnpm build"; }
echo

echo "== Phase 2 verify: re-seed sandbox image with File API + watcher =="
export SANDBOX_IMAGE_TAG="${SANDBOX_IMAGE_TAG:-live/sandbox-base:latest}"
./scripts/seed-sandbox-image.sh > /tmp/p2-image-build.log 2>&1 \
  && pass "docker build ${SANDBOX_IMAGE_TAG}" \
  || { cat /tmp/p2-image-build.log; fail "sandbox image rebuild"; }
echo

echo "== Phase 2 verify: File API CRUD, tree sync, fs events, watcher =="
echo "   (create / edit+save / rename / delete, /fs/events, path-traversal guard, watcher)"
SANDBOX_IMAGE_TAG="$SANDBOX_IMAGE_TAG" node phases/p2-editor-filesystem/fsApiCheck.mjs
echo

echo "== Phase 2 verify: Monaco language mapping (static check) =="
for pair in ".js:javascript" ".ts:typescript" ".py:python"; do
  ext="${pair%%:*}"
  lang="${pair##*:}"
  if grep -q "\"${ext}\": \"${lang}\"" packages/web/src/host/Editor.tsx \
     && grep -q "\"${ext}\": \"${lang}\"" packages/web/src/viewer/ReadOnlyEditor.tsx; then
    pass "Editor + ReadOnlyEditor map ${ext} -> ${lang}"
  else
    fail "missing ${ext} -> ${lang} mapping in Editor.tsx / ReadOnlyEditor.tsx"
  fi
done
echo

echo "All Phase 2 checks passed."
