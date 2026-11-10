# Wildcard DNS + HTTPS Runbook — `*.sessions.<yourdomain>`

Phase 4 routes every session at `https://<session-id>.sessions.yourdomain.dev`
instead of `http://<session-id>.localhost`. This needs exactly **one** wildcard
DNS record, created **once**. After that there is zero DNS work per session: a
wildcard record matches every label under it, and TLS is issued **once** for the
whole wildcard (`*.sessions.yourdomain.dev`), not once per session.

Replace `yourdomain.dev` with your real domain throughout.

## 1. Decide the session zone

| Item             | Value                          |
|------------------|--------------------------------|
| Apex domain      | `yourdomain.dev`               |
| Session zone     | `sessions.yourdomain.dev`      |
| Wildcard pattern | `*.sessions.yourdomain.dev`    |

## 2. Create the wildcard record (once)

### Option A — wildcard A record (static public IP)

| Type | Host         | Value          | TTL |
|------|--------------|----------------|-----|
| A    | `*.sessions` | `<TRAEFIK_IP>` | 300 |

### Option B — wildcard CNAME (behind a load balancer / DNS name)

| Type  | Host         | Value                | TTL |
|-------|--------------|----------------------|-----|
| CNAME | `*.sessions` | `lb.yourdomain.dev.` | 300 |

Keep TTL at 300s while testing; raise to 3600+ once confirmed.

The machine behind that IP must have ports **80 and 443** open to the internet.

## 3. Why DNS-01

Let's Encrypt only issues wildcard certificates through the **DNS-01**
challenge. Traefik creates a temporary `_acme-challenge` TXT record through your
DNS provider's API, waits for it to propagate, then removes it. The provider is
configured in `packages/proxy/traefik/acme.yml` (Cloudflare by default).

## 4. Verify DNS

```bash
dig +short random-check-1.sessions.yourdomain.dev
dig +short @1.1.1.1 random-check-1.sessions.yourdomain.dev
```

Both must print your Traefik IP (or the CNAME target and its IP). Try a few
different random labels; they must all resolve.

## 5. Configure credentials and turn HTTPS on

1. **Create a Cloudflare API token** (My Profile → API Tokens) with
   `Zone → DNS → Edit` and `Zone → Zone → Read` on your zone. (Using another
   DNS provider? Change `provider:` in `acme.yml` and pass that provider's env
   var to the `traefik` service in `docker-compose.yml`. List:
   https://doc.traefik.io/traefik/https/acme/#providers)
2. `cp .env.example .env` and fill in:
   ```
   SESSION_HOST_SUFFIX=sessions.yourdomain.dev
   ACME_EMAIL=you@yourdomain.dev
   ACME_CA_SERVER=https://acme-staging-v02.api.letsencrypt.org/directory
   CF_DNS_API_TOKEN=<your token>
   ```
   **Start on the staging CA** (shown above) to avoid Let's Encrypt rate limits
   while you debug.
3. Start the stack and the orchestrator with the same `SESSION_HOST_SUFFIX`
   in its environment (`dockerManager.ts` reads it when spawning sessions):
   ```bash
   docker compose up -d
   ```
4. Start one real session, then watch issuance:
   ```bash
   docker compose logs -f traefik     # look for "acme" lines, no errors
   curl -v https://<session>.sessions.yourdomain.dev/
   ```
   On staging the certificate issuer will say `(STAGING)`; browsers will warn,
   which is expected.
5. When staging works, set `ACME_CA_SERVER` to the production URL
   (`https://acme-v02.api.letsencrypt.org/directory`), delete the staging
   certificate so it is re-issued, and restart Traefik:
   ```bash
   docker compose down traefik
   docker volume rm "$(docker volume ls -q | grep letsencrypt-storage)"
   docker compose up -d traefik
   ```

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Browser shows "certificate invalid / Traefik default cert" | Issuance failed or hasn't finished; check `docker compose logs traefik` |
| `unable to find zone` / `403` in Traefik logs | Cloudflare token lacks Zone:Read or Zone:DNS:Edit, or wrong zone |
| `DNS problem: NXDOMAIN` | Wildcard record missing or not yet propagated (step 4) |
| `too many certificates already issued` | Production rate limit hit; use staging until it works |
| Session URL is `.localhost`, not your domain | `SESSION_HOST_SUFFIX` not set in the orchestrator's environment |