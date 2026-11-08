# Screen Scout

A lightweight Windows desktop AI assistant that lives in your system tray.
Press **Shift+R** from anywhere, drag a rectangle around any part of your
screen, ask a question, and a vision-capable AI model answers — either through
the free **hosted tier** (no key, no account; routed via Screen Scout's relay)
or **your own NVIDIA NIM key** in BYOK mode, where requests go directly to
NVIDIA and nowhere else.

- **Background-first** — starts quietly in the tray; no window opens at launch.
- **Select → Ask → Answer** — capture a region, preview it, then choose to send.
- **Capture without the popup** — a second global shortcut (**Shift+C**) jumps
  straight to region selection; the popup opens with the crop attached.
- **Paste or drop images** — Ctrl+V a screenshot or drop a PNG/JPEG file onto
  the popup to attach it, same privacy rules as a capture.
- **Redact before sending** — drag boxes over private content (solid patch or
  pixelate); the patches are baked into the image before it ever leaves the
  machine.
- **Nothing is uploaded until you press Send.** Closing the popup discards the
  unsent capture.
- **Free hosted mode** — no account, no key. Questions are relayed through
  Screen Scout's Cloudflare Worker under fair-use quotas; screenshot questions
  are served by Cloudflare Workers AI (Llama 4 Scout), text-only turns by Groq
  (GPT-OSS 120B). The relay stores no screenshots, prompts, or answers — only
  a random device id and usage counters.
- **Your own NVIDIA key**, stored with OS-backed encryption (Windows DPAPI),
  never in the renderer, logs, or plaintext config.
- **Premium glass UI** — Apple-inspired frosted vibrancy, system-green accent,
  Inter Variable type, truly rounded frameless windows, and a real frosted-glass
  backdrop: the desktop behind the popup is captured just before show and
  blurred in-page (works on every machine, even where the OS acrylic material
  silently falls back to a flat surface), and it re-captures when you move or
  resize the window so the blur always matches what is actually behind it.

---

## Requirements

- Windows 10/11 (the capture layer is platform-isolated so macOS can be added later)
- Node.js 18+ (built and tested with Node 24)
- **Nothing else** when the build ships with hosted mode: the free tier uses
  Screen Scout's relay, so there is no key to obtain.
- Built without a relay URL (or when you choose **My own NVIDIA key**): an
  NVIDIA API key from [build.nvidia.com](https://build.nvidia.com) — the free
  API credits work fine.

## Install & run (development)

```bash
npm install
npm run dev        # starts Vite + Electron with hot reload
```

The first `npm run dev` may take a moment while Electron downloads.

## Production build & packaging

```bash
npm run build        # bundles main/preload/renderer to out/
npm run dist         # builds a Windows NSIS installer (dist/)
npm run smoke        # headless boot check of the real app (tray, window, shortcut)
npm run integration  # in-app E2E: preload bridge, React mount, IPC validation,
                     # no-key error path, hide event, settings+overlay pages,
                     # and the real quit path (tray Quit)
npm run e2e          # full user-journey E2E in an isolated profile: capture flow
                     # (overlay drag → crop → attachment), cancel + too-small paths,
                     # paste/clipboard/drop image imports, redaction editor,
                     # chat error/retry, settings flows, hosted mode against a
                     # local mock relay, direct-capture shortcut cold start,
                     # frosted backdrop, layout, console errors
npm test             # unit tests (190 tests, app + relay)
npm run typecheck    # strict TypeScript check, main + renderer
npm run test:persistence  # proves the API key is remembered across real
                          # app restarts and stored encrypted on disk
```

### Packaging notes

- The installer builds to `dist/Screen-Scout-<version>-setup.exe` (one-click
  NSIS). The exe is unsigned, so Windows Smart App Control / AppLocker may
  block it on machines with strict Application Control policies — sign the
  installer with a code-signing certificate for distribution.
- If `npm run dist` fails while extracting `winCodeSign-2.6.0.7z` with
  *"Cannot create symbolic link: A required privilege is not held by the
  client"* (common on non-admin Windows), pre-extract the cache once and
  rebuild:

  ```powershell
  $cache = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
  New-Item -ItemType Directory -Force -Path "$cache\winCodeSign-2.6.0" | Out-Null
  & node_modules\7zip-bin\win\x64\7za.exe x -y -bd "$cache\<name>.7z" "-o$cache\winCodeSign-2.6.0"
  # exit code 2 about two macOS .dylib symlinks is expected and harmless for Windows builds
  ```

## First-run setup

1. Launch Screen Scout (it appears in the system tray).
2. Press **Shift+R** — the assistant popup opens.
3. Click the gear icon (or tray → **Settings**).
4. Choose an access mode:
   - **Free hosted mode** (when the build includes a relay URL) — no key needed.
     Settings shows how many of the daily and 5-hour questions are left.
   - **My own NVIDIA key** — paste a key → **Save key securely**.
     - Status shows *protected by OS-backed secure storage* when Windows DPAPI
       is available. If OS encryption is unavailable, the key is kept **in memory
       for the current session only** and Settings says so — it never falls back
       to plaintext.
5. In BYOK mode, pick a vision model (default: `meta/llama-3.2-90b-vision-instruct`)
   and press **Test connection**. This sends a minimal request with a tiny 16×16
   PNG so you can see — before asking a real question — that the model really
   accepts image input on your account. In hosted mode the same button checks
   relay reachability and the remaining quota without spending a question.
6. Optional: change the global shortcuts (record a new key combination for
   opening the popup and for direct capture, or disable direct capture) or
   enable **Launch on sign-in**.

### Hosted mode (free tier)

The hosted relay lives in [`relay/`](relay/README.md) and runs on Cloudflare
Workers. It holds the upstream credential so no key ships in the app:

```
                              ┌─ text-only questions ───▶ Groq (gpt-oss-120b)
Screen Scout ──HTTPS/SSE──▶ Worker
                              └─ screenshot questions ──▶ Cloudflare Workers AI
                                                          (Llama 4 Scout, multimodal)
```

- Defaults: **30 questions/day per device**, **10 per 5-hour window**, plus
  account-wide daily caps per provider. Limits live in `relay/wrangler.toml`.
- The relay stores no screenshots, prompts, or answers — only a random device
  id, counters, and which provider served the request.
- Failover happens only before the first byte reaches the app, so an answer is
  never duplicated mid-stream.
- Bake the deployed URL in at build time:
  `node scripts/set-relay-url.mjs https://your-worker.workers.dev` then
  `npm run build`. Without it the app stays in BYOK mode and hides the option.
- `SCREEN_SCOUT_RELAY_URL` overrides the baked URL at runtime (used by the E2E
  mock relay and useful for staging).

## Choosing a vision model

Suggested (verified request schema on the NVIDIA API Catalog — availability can
change, so use Test connection):

| Model ID | Notes |
| --- | --- |
| `meta/llama-3.2-90b-vision-instruct` | Default; strong general vision model |
| `nvidia/nemotron-nano-12b-v2-vl` | Smaller and faster |
| `microsoft/phi-3.5-vision-instruct` | Lightweight |

You can also type any custom model ID. Requests are sent to
`https://integrate.api.nvidia.com/v1/chat/completions` (configurable in
Settings if you run a self-hosted NIM endpoint) using the documented image
payload:

```json
{
  "type": "image_url",
  "image_url": { "url": "data:image/png;base64,…" }
}
```

## The workflow

1. `Shift+S` peeks: hides the assistant WITHOUT clearing anything —
   press it again to reopen exactly where you left off (conversation,
   attachment, draft, even an in-flight answer). Editable in Settings.
1. `Shift+R` opens (or hides) the floating assistant — by default it pops up
   in the bottom-right corner of your screen (tray-adjacent, with a margin
   from the screen edges) on the display the pointer is on.
   `Shift+C` skips the popup and jumps straight to screen selection — the
   popup then opens focused with the crop attached. Both shortcuts are
   editable in Settings (the capture shortcut can be turned off).
2. **Select screen area** → the screen dims, drag a rectangle
   (live dimensions shown), release. `Esc` or right-click cancels.
3. The crop appears as a preview with **Redact** / **Retake** / **Remove**.
   You can also **paste an image (Ctrl+V)** or **drop a PNG/JPEG file** onto
   the popup — it becomes the attachment, validated and size-capped in the
   main process. Quick prompts are offered; you can also just type.
   (Sending a capture with an empty prompt uses
   *"Describe this screen area and point out anything important."*)
4. Optional: press **Redact** and drag boxes over anything private — choose a
   solid patch (blends with the area) or pixelate. **Apply** bakes the patches
   into a new image locally; the untouched original is discarded. `Esc`
   cancels the editor and keeps the original.
5. The **first** time you send a screenshot you confirm the upload
   (**Send once** / **Always allow**). The crop + prompt go to NVIDIA.
6. The answer streams in with Markdown rendering. Copy any response, ask
   follow-ups (the image stays in context while attached), press the **Stop**
   button to cancel a slow generation, or start a **New chat**.
7. Hiding the popup (`Esc`, close button, or the shortcut) cancels any
   in-flight request and clears the conversation and unsent capture. The
   app keeps running in the tray.

## Security & privacy design

- **Your key is remembered, safely.** After *Save key securely* the key lives
  encrypted in `%APPDATA%\Screen Scout\api-key.bin` (Windows DPAPI), survives
  every restart, and is removed only when you press **Remove key** — or you
  can delete that file yourself. `npm run test:persistence` proves this with
  three real app launches (save → restart → still remembered → remove). If
  OS encryption is ever unavailable the app refuses plaintext: it keeps the
  key in memory for the session only and says so.
- **Edge case, honestly:** the DPAPI storage key is committed to disk shortly
  after the first save and on every normal quit. A hard crash within the
  first few seconds of the very first save could lose that key — the app
  then simply shows "No key saved yet" and you paste it again. Nothing is
  ever written in plaintext as a fallback.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` in every
  window; strict CSP; navigation/popups blocked.
- All IPC payloads validated with Zod in the main process.
- The API key is encrypted via Electron `safeStorage` (DPAPI on Windows);
  the renderer only ever receives a `hasApiKey` boolean.
- All NVIDIA HTTP traffic happens in the **main process**. Error messages and
  logs never contain the key or base64 payloads.
- Screen capture happens only when you start a selection, and the capture is
  taken *before* the overlay appears so the dimming UI is never in the crop.
- Pasted/dropped images are validated and re-encoded in the main process
  (PNG/JPEG only, 32 MB input cap, size-capped output) — the renderer never
  decides what is attachable.
- Redaction is baked in locally before the image can be sent, and the
  untouched original is discarded from memory the moment the redacted image
  replaces it.
- **Invisible to screen sharing and recording.** Every app window (popup,
  settings, selection overlay) is excluded from screen captures at the OS
  level - screen shares in Zoom/Teams, screenshots from other apps, and
  recordings show only your desktop, never this app. Locally the windows
  behave exactly the same: fully visible and clickable.
- Crops live in memory only; they are dropped when the popup closes or the chat
  is cleared. No telemetry, no disk cache, no background capture.
- **Hosted mode is explicit.** The relay holds the upstream credentials (they are
  never in the app bundle). Screenshot questions are forwarded to Cloudflare
  Workers AI (Llama 4 Scout); text-only questions may be served by Groq. It
  stores no content — only a random device id plus usage counters. The device
  token is stored with the same OS-backed encryption as a BYOK key. Switching
  to **My own NVIDIA key** bypasses the relay entirely; the app then talks
  straight to NVIDIA.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `Shift+R` does nothing | Another app owns the shortcut. Open Settings → Global shortcuts → record a new combination; the registration failure is reported there, never silently ignored. |
| `Shift+C` does nothing | Same shortcut-conflict rule (Settings → the second shortcut row shows the registration status), or the direct-capture shortcut is set to **Off**. |
| `NVIDIA rejected this API key` | Re-copy the key from build.nvidia.com; keys are long (`nvapi-…`). |
| `The free limit is used up for now` | Hosted mode hit its daily or 5-hour cap. Wait for the reset shown in Settings, or switch to **My own NVIDIA key**. |
| `Couldn't reach the free hosted service` | The relay is unreachable or at capacity. Check your connection and retry, or switch to your own key. |
| `This model does not support screenshots` | The model rejected the image payload — choose one of the suggested vision models or run Test connection. |
| `Couldn't reach NVIDIA` | Check your connection/proxy. `requestTimeoutSec` in settings is the maximum wait **without progress** — it applies until the first data arrives and restarts on every chunk, so a long answer is never cut off while it is actively streaming; only a stalled connection is stopped. |
| Capture comes out black / empty | Apps using hardware-overlay protection can block capture. Try selecting a different region or app. |
| Tray icon missing after crash | Kill any leftover `electron.exe` in Task Manager, then relaunch (single-instance lock prevents duplicates). |
| Installed app blocked by Windows | Smart App Control / AppLocker blocks unsigned binaries. Use the dev commands, or sign the installer before distributing. |

## Project structure

```text
src/
├─ main/                 # trusted desktop process
│  ├─ index.ts            # lifecycle, tray wiring, IPC + validation
│  ├─ windows.ts          # assistant/settings/overlay windows (transparent, rounded)
│  ├─ backdrop.ts         # capture-the-desktop frosted-glass backdrop
│  ├─ backdrop-geometry.ts  # pure crop math for the backdrop (unit-tested)
│  ├─ tray.ts             # tray icon + menu
│  ├─ shortcuts.ts         # global hotkey registration with honest status
│  ├─ capture/            # pre-overlay capture, DPI-safe mapping, crop/encode
│  ├─ images/             # clipboard/dropped-image import (validated, size-capped)
│  ├─ ai/                 # NIM client (SSE), hosted relay client, chat service
│  ├─ security/secrets.ts # safeStorage key + device-token storage (DPAPI)
│  └─ settings/            # non-secret preferences store
├─ preload/index.ts       # typed contextBridge — the only renderer API
├─ renderer/
│  ├─ assistant/          # popup app + chat state machine
│  ├─ settings/           # settings window + shortcut recorder + quota meter
│  ├─ overlay/            # fullscreen selection layer
│  └─ styles/             # design tokens + glass theme
└─ shared/                # types + Zod schemas used on both sides
relay/                     # Cloudflare Worker free-tier relay (own package)
├─ src/                   # router, quota (D1), SSE translation, upstreams
├─ schema.sql             # D1 tables
└─ wrangler.toml          # limits, bindings, cron
tests/                     # vitest: NIM client, SSE parser, relay auth/quota/SSE,
                           # settings store, chat state, geometry, image pipeline,
                           # redaction math
```

## Known limitations (honest list)

- Follow-up questions re-send the attached image with each turn (the API is
  stateless) — accurate, but it consumes input tokens per question.
- Selection rectangles are confined to a single display (drag cannot span two
  monitors); each monitor gets its own overlay.
- Session-only conversation memory: closing the popup clears the chat by
  design (privacy).
- Mixed-DPI/multi-monitor mapping is implemented via normalized-display
  coordinates and covered by unit tests, but should still be eyeballed on a
  real mixed-DPI setup once.
- The installer was built successfully here (`dist/Screen-Scout-0.1.0-setup.exe`),
  and the packaged app's asar was verified complete — but this machine's
  Application Control policy blocks running the unsigned packaged exe, so the
  installed-binary boot path was verified via the identical `out/` tree through
  `electron .` (smoke + integration) instead.
- Hosted mode has fair-use quotas (per-device and account-wide) and no
  availability guarantee — it's a free tier, not a paid API. BYOK users keep
  their own NVIDIA limits.

---

## License

Screen Scout is proprietary software — see [EULA.md](EULA.md) and
[LICENSE](LICENSE). Bundled third-party software, fonts, and upstream model
attributions: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The hosted
tier's privacy notice and terms are published by the relay at `/privacy` and
`/terms`.
