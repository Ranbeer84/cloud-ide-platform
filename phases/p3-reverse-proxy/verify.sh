#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; exit 1; }

if ! command -v docker > /dev/null 2>&1; then
  fail "docker is required to run Phase 3 verification but was not found on PATH"
fi
if ! docker compose version > /dev/null 2>&1; then
  fail "docker compose (v2 plugin) is required to run Phase 3 verification"
fi

NETWORK_NAME="live-network"
SANDBOX_IMAGE_TAG="${SANDBOX_IMAGE_TAG:-live/sandbox-base:latest}"
TEST_A="p3-verify-session-a"
TEST_B="p3-verify-session-b"

cleanup() {
  docker rm -f "$TEST_A" "$TEST_B" > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== Phase 3 verify: Phase 2 regression suite (includes Phase 0 + Phase 1) =="
bash phases/p2-editor-filesystem/verify.sh
pass "Phase 2 regression suite (editor + filesystem, and everything under it)"
echo

echo "== Phase 3 verify: pnpm install =="
pnpm install --frozen-lockfile=false > /tmp/p3-install.log 2>&1 \
  && pass "pnpm install" \
  || { cat /tmp/p3-install.log; fail "pnpm install"; }
echo

echo "== Phase 3 verify: build all packages (incl. proxyLabels + dockerManager) =="
pnpm run build > /tmp/p3-build.log 2>&1 \
  && pass "pnpm build" \
  || { cat /tmp/p3-build.log; fail "pnpm build"; }
echo

echo "== Phase 3 verify: shared proxy network exists =="
if [ -f "./scripts/ensure-proxy-network.sh" ]; then
  PROXY_NETWORK_NAME="$NETWORK_NAME" bash ./scripts/ensure-proxy-network.sh > /tmp/p3-network.log 2>&1 \
    && pass "docker network ${NETWORK_NAME} exists" \
    || { cat /tmp/p3-network.log; fail "could not ensure docker network ${NETWORK_NAME} exists"; }
else
  docker network inspect "$NETWORK_NAME" > /dev/null 2>&1 || docker network create --driver bridge "$NETWORK_NAME" > /dev/null
  pass "docker network ${NETWORK_NAME} created/verified"
fi
echo

echo "== Phase 3 verify: bring up docker compose stack (traefik + streaming + web) =="
docker compose up -d > /tmp/p3-compose-up.log 2>&1 \
  && pass "docker compose up" \
  || { cat /tmp/p3-compose-up.log; fail "docker compose up"; }
echo

echo "== Phase 3 verify: Traefik dashboard/API is reachable =="
TRAEFIK_READY=false
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:8080/api/rawdata" > /dev/null 2>&1; then
    TRAEFIK_READY=true
    break
  fi
  sleep 1
done
[ "$TRAEFIK_READY" = true ] \
  && pass "Traefik API reachable on :8080" \
  || fail "Traefik API never became reachable on :8080"
echo

echo "== Phase 3 verify: spawn two labeled sandbox containers on ${NETWORK_NAME} =="
docker rm -f "$TEST_A" "$TEST_B" > /dev/null 2>&1 || true

docker run -d --name "$TEST_A" \
  --network "$NETWORK_NAME" \
  --expose 8080 \
  --label "traefik.enable=true" \
  --label "traefik.http.routers.session-verify-a.rule=Host(\`verify-a.localhost\`)" \
  --label "traefik.http.routers.session-verify-a.entrypoints=web" \
  --label "traefik.http.services.session-verify-a.loadbalancer.server.port=8080" \
  --label "traefik.docker.network=${NETWORK_NAME}" \
  node:20-bookworm-slim \
  node -e "require('http').createServer((_req,res)=>{res.end('hello-from-verify-a');}).listen(8080, '0.0.0.0', () => console.log('A ready'));" \
  > /tmp/p3-run-a.log 2>&1 \
  && pass "spawned ${TEST_A}" \
  || { cat /tmp/p3-run-a.log; fail "failed to spawn ${TEST_A}"; }

docker run -d --name "$TEST_B" \
  --network "$NETWORK_NAME" \
  --expose 8080 \
  --label "traefik.enable=true" \
  --label "traefik.http.routers.session-verify-b.rule=Host(\`verify-b.localhost\`)" \
  --label "traefik.http.routers.session-verify-b.entrypoints=web" \
  --label "traefik.http.services.session-verify-b.loadbalancer.server.port=8080" \
  --label "traefik.docker.network=${NETWORK_NAME}" \
  node:20-bookworm-slim \
  node -e "require('http').createServer((_req,res)=>{res.end('hello-from-verify-b');}).listen(8080, '0.0.0.0', () => console.log('B ready'));" \
  > /tmp/p3-run-b.log 2>&1 \
  && pass "spawned ${TEST_B}" \
  || { cat /tmp/p3-run-b.log; fail "failed to spawn ${TEST_B}"; }
echo

echo "== Phase 3 verify: routes auto-register, distinct subdomains, no collisions =="
ROUTE_A_OK=false
ROUTE_B_OK=false
for _ in $(seq 1 30); do
  BODY_A="$(curl -sf -H 'Host: verify-a.localhost' http://127.0.0.1:80/ || true)"
  BODY_B="$(curl -sf -H 'Host: verify-b.localhost' http://127.0.0.1:80/ || true)"
  [ "$BODY_A" = "hello-from-verify-a" ] && ROUTE_A_OK=true
  [ "$BODY_B" = "hello-from-verify-b" ] && ROUTE_B_OK=true
  { [ "$ROUTE_A_OK" = true ] && [ "$ROUTE_B_OK" = true ]; } && break
  sleep 1
done

if [ "$ROUTE_A_OK" != true ] || [ "$ROUTE_B_OK" != true ]; then
  echo "--- DIAGNOSTIC DUMP ---"
  echo "Container A logs:"
  docker logs "$TEST_A" || true
  echo "Container B logs:"
  docker logs "$TEST_B" || true
  echo "Traefik Routers:"
  curl -s http://127.0.0.1:8080/api/http/routers || true
  echo
  echo "Traefik Services:"
  curl -s http://127.0.0.1:8080/api/http/services || true
  echo
fi

[ "$ROUTE_A_OK" = true ] \
  && pass "http://verify-a.localhost/ -> ${TEST_A}:8080" \
  || fail "verify-a.localhost route never came up"

[ "$ROUTE_B_OK" = true ] \
  && pass "http://verify-b.localhost/ -> ${TEST_B}:8080 (distinct subdomain, no collision with verify-a)" \
  || fail "verify-b.localhost route never came up"
echo

echo "== Phase 3 verify: routes auto-deregister on container stop, no restart needed =="
docker rm -f "$TEST_A" > /dev/null 2>&1

DEREGISTERED=false
for _ in $(seq 1 30); do
  if ! curl -sf -H 'Host: verify-a.localhost' http://127.0.0.1:80/ > /dev/null 2>&1; then
    DEREGISTERED=true
    break
  fi
  sleep 1
done
[ "$DEREGISTERED" = true ] \
  && pass "verify-a.localhost route deregistered after container removal" \
  || fail "verify-a.localhost route still resolved after container removal"

STILL_UP="$(curl -sf -H 'Host: verify-b.localhost' http://127.0.0.1:80/ || true)"
[ "$STILL_UP" = "hello-from-verify-b" ] \
  && pass "verify-b.localhost still routes correctly (unaffected by verify-a's removal)" \
  || fail "verify-b.localhost route was unexpectedly affected by verify-a's removal"
echo

docker rm -f "$TEST_B" > /dev/null 2>&1 || true

echo "All Phase 3 checks passed."
