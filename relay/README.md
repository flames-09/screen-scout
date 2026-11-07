# Screen Scout relay

A small Cloudflare Worker that lets people use Screen Scout **without bringing their own
API key**. It holds the upstream credentials, enforces a free quota per device, and streams
answers back. It stores no screenshots, prompts, or answers.

```
                              ┌─ text-only questions ───▶ Groq (gpt-oss-120b)
Screen Scout ──HTTPS/SSE──▶ Worker
                              └─ screenshot questions ──▶ Cloudflare Workers AI
                                                          (Llama 4 Scout, multimodal)
```

Image questions route to the multimodal provider; text-only turns can use the
text provider for extra free capacity. A provider that cannot serve an image is
never sent one.

## What it enforces

| Limit | Default | Where |
|---|---|---|
| Questions per device per day | 30 | `DEVICE_PER_DAY` |
| Questions per device per 5-hour window | 10 | `DEVICE_PER_WINDOW`, `WINDOW_HOURS` |
| Account-wide Groq requests/day | 900 | `GLOBAL_GROQ_PER_DAY` |
| Account-wide Workers AI requests/day | 130 | `GLOBAL_CF_PER_DAY` |
| Body size | 6 MB | `MAX_BODY_BYTES` |
| Registrations per IP/day | 20 | `REGISTRATIONS_PER_IP_PER_DAY` |

Change any of these in `wrangler.toml`, redeploy, done — the app reads the limits from
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

# 4. Deploy — note the printed https://screen-scout-relay.<subdomain>.workers.dev URL
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
| `POST` | `/v1/register` | `{deviceId, appVersion, os}` → short-lived HMAC token + quota |
| `GET` | `/v1/quota` | Remaining daily/window quota and reset times |
| `POST` | `/v1/chat/completions` | OpenAI-compatible streaming chat (`X-Device-Token`) |
| `GET` | `/health` | Config sanity check |
| `GET` | `/privacy`, `/terms` | Human-readable pages |

## Notes

- **Failover happens before the first byte.** Once a provider starts streaming the relay
  commits to it — switching mid-answer would duplicate text in the user's bubble.
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
- A `build.nvidia.com` trial key is **not** suitable for this: NVIDIA's API Trial Terms
  restrict it to evaluation, not production serving.
