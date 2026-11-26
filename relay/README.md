# Screen Scout relay

A small Cloudflare Worker that lets people use Screen Scout **without bringing their own
API key**. It holds the upstream credentials, enforces a free quota per device, and streams
answers back. It stores no screenshots, prompts, or answers.

```
                              | text-only questions ----> Groq (gpt-oss-120b)
Screen Scout --HTTPS/SSE--> Worker
                              | screenshot questions ---> NVIDIA (Llama 4 Scout)
                                                         fallback: Cloudflare Workers AI
                                                         (Llama 4 Scout, multimodal)
```

Image questions go to NVIDIA's hosted vision model first, with Cloudflare Workers
AI as the fallback pool; text-only turns can use the text provider for extra free
capacity. A provider that cannot serve an image is never sent one.

## What it enforces

| Limit | Default | Where |
|---|---|---|
| Questions per device per day | 30 | `DEVICE_PER_DAY` |
| Questions per device per 5-hour window | 10 | `DEVICE_PER_WINDOW`, `WINDOW_HOURS` |
| Account-wide Groq requests/day | 900 | `GLOBAL_GROQ_PER_DAY` |
| Account-wide NVIDIA requests/day | 400 | `GLOBAL_NVIDIA_PER_DAY` |
| Account-wide Workers AI requests/day | 130 | `GLOBAL_CF_PER_DAY` |
| Body size | 6 MB | `MAX_BODY_BYTES` |
| Registrations per IP/day | 20 | `REGISTRATIONS_PER_IP_PER_DAY` |

Change any of these in `wrangler.toml`, redeploy, done â€” the app reads the limits from
response headers, so it needs no release.

## One-time deploy

```powershell
cd relay
npm install
npx wrangler login

# 1. Create the D1 database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create screen-scout-relay

# 2. Create the tables
npx wrangler d1 execute screen-scout-relay --remote --file=./schema.sql

# 3. Secrets (paste the Groq key when prompted; generate a signing secret locally)
npx wrangler secret put GROQ_API_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put TOKEN_SIGNING_SECRET

# 3b. Optional: NVIDIA image pool (skipping it routes images to Workers AI only)
npx wrangler secret put NVIDIA_API_KEY

# 4. Deploy â€” note the printed https://screen-scout-relay.<subdomain>.workers.dev URL
npx wrangler deploy
```

Then bake the URL into the desktop app:

```powershell
cd ..
node scripts/set-relay-url.mjs https://screen-scout-relay.<subdomain>.workers.dev
npm run build
```

Until a URL is set, the app stays in **My own NVIDIA key** mode and the hosted option is hidden.

Verify:

```powershell
curl https://screen-scout-relay.<subdomain>.workers.dev/health
# {"ok":true,"version":"1.0.0","groqConfigured":true,"signingConfigured":true,...}
```

## Local development

```powershell
cd relay
"GROQ_API_KEY=...\nTOKEN_SIGNING_SECRET=..." | Out-File -Encoding utf8 .dev.vars
npx wrangler dev --local
npx wrangler d1 execute screen-scout-relay --local --file=./schema.sql
```

Point the app at it with `SCREEN_SCOUT_RELAY_URL=http://127.0.0.1:8787` (runtime override,
used by the E2E tests) or `node scripts/set-relay-url.mjs`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/register` | `{deviceId, appVersion, os}` â†’ short-lived HMAC token + quota |
| `GET` | `/v1/quota` | Remaining daily/window quota and reset times |
| POST | /v1/chat/completions | OpenAI-compatible streaming chat (X-Device-Token) |
| POST | /v1/account/delete | Delete the caller's device/account row + all its usage counters |
| `GET` | `/health` | Config sanity check |
| `GET` | `/privacy`, `/terms`, `/guidelines` | Human-readable pages (guidelines incl. crisis resources) |
| `GET` | `/updates/latest.json` | Update manifest (top-level = win entry + `platforms` map from D1) |
| `GET` | `/updates/<file>` | 302 to the matching installer on GitHub Releases |

## Notes

- **Failover happens before the first byte.** Once a provider starts streaming the relay
  commits to it â€” switching mid-answer would duplicate text in the user's bubble.
- **Upstream requests are rebuilt from an allow-list** (`model`, `messages`, `temperature`,
  `max_tokens`, `stream`), so a public caller cannot smuggle in `n`, `tools`, a 32k
  `max_tokens`, etc. and multiply the cost of one quota unit.
- **Provider budgets only refund pre-response failures.** A network error/timeout returns the
  slot; any HTTP answer from Groq (including 429/5xx) stays counted, because Groq already
  accounted for it. Otherwise real upstream traffic could exceed the account-wide cap.
- **Counters live in D1.** KV's free tier allows only 1,000 writes/day, which is below the
  Groq allowance; D1 gives 100k writes/day and atomic `count < limit RETURNING`.
- **No content logging.** The relay stores only a random device id (plus coarse app version
  and OS at registration) and usage counters. Usage rows expire within a day; idle device
  rows are pruned after 30 days.
- **Fair use, not a hard identity boundary.** The per-device limit is keyed on a device id
  the client generates; the per-IP registration throttle (20/day) is what bounds id rotation,
  and the account-wide caps bound total spend. Treat "30/day per device" as a fair-use limit,
  not an anti-abuse control.
- **Privacy:** Cloudflare states Workers AI does not train on customer inputs. Groq's
  services agreement forbids training on API inputs/outputs and it does not retain
  inference data by default.
- **NVIDIA caveat (operator decision):** NVIDIA's API Trial Terms restrict free keys to
  evaluation, "without use of the API Service or Generated Content in production", and
  Â§3.3 lets NVIDIA use submitted content to improve its products. Serving the free tier
  through one is a deliberate risk acceptance by the operator â€” the relay's privacy page
  discloses this and points privacy-sensitive users at BYOK. BYOK remains untouched:
  a user's own key is exercised directly by the app and never sees this relay.
- **Capacity:** pools are independent, so worst-case hosted throughput is
  400 NVIDIA + 130 Workers AI image questions plus 900 Groq text answers per day.
  Workers AI additionally meters compute in "neurons" (10,000/day free) â€” roughly
  45â€“350 neurons per image question depending on crop size â€” so the 130-request cap
  keeps that budget safe; when NVIDIA absorbs image traffic, the neuron budget is
  preserved as fallback headroom. All caps are header-driven: change `wrangler.toml`
  and redeploy, no app release needed.

## Operations runbook

### Kill switch (pause the whole free tier)

Set `HOSTED_ENABLED = "false"` in `wrangler.toml`, then `npx wrangler deploy`.
Register, quota, and chat all answer `503 hosted-disabled`; the app shows a
maintenance message and points users at BYOK. Flip back to `"true"` and redeploy
to resume. (Verified live on staging.)

### Minimum app version

Set `MIN_APP_VERSION = "0.1.0"` (for example) and redeploy: older clients get
`426 update-required` on register/quota/chat â€” the app's version rides inside
its signed token, so the gate cannot be spoofed without a valid new token. Use
this when a relay change breaks an old app release. `"0.0.0"` disables the gate.

### Staging

```powershell
npx wrangler deploy --env staging     # worker screen-scout-relay-staging
```

Staging has its own D1 (same schema) and its own `TOKEN_SIGNING_SECRET`; it has
no Groq secret, so chat fails upstream â€” it exists to prove deploys, gates, and
quota paths before production. Probe it:

```powershell
curl -X POST https://screen-scout-relay-staging.<subdomain>.workers.dev/v1/register `
  -H "Content-Type: application/json" -d '{"deviceId":"probe-device-000000001","appVersion":"0.1.0","os":"probe"}'
```

### Monitoring & alerts

- `node scripts/check-relay.mjs` probes `/health` + the update feed; GitHub
  Actions runs it every 30 minutes (`.github/workflows/relay-monitor.yml`) and
  a failed run notifies the repo owner.
- Cloudflare dashboard: set a **budget/alert notification** on the account and
  watch Workers â†’ Metrics (error rate) and D1 â†’ Metrics (storage). `npx wrangler tail`
  streams live request logs when investigating.

### Secret rotation

```powershell
# Groq key (regenerate on groq.com first)
npx wrangler secret put GROQ_API_KEY
# Token signing secret â€” INVALIDATES all device tokens (clients re-register automatically)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put TOKEN_SIGNING_SECRET
```

Rotate either secret without touching code or downtime (tokens refresh on the
next 401; the app re-registers and continues).
