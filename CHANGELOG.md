# Changelog

All notable changes to Screen Scout are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com); versions follow
[SemVer](https://semver.org).

## [0.1.0] — 2026-11-07

Initial public build.

### Added

- Tray-resident assistant on Windows: `Shift+R` opens the popup, `Shift+C`
  jumps straight to region capture; both shortcuts are user-configurable.
- Region capture, clipboard paste, and image drop, with a redaction editor
  (solid patch or pixelate) that bakes patches in before anything leaves the
  machine. Nothing is uploaded until Send; closing the popup discards unsent
  captures. The popup itself is excluded from screen recordings and shares.
- **Hosted free tier** (no account, no API key): questions are relayed through
  Screen Scout's Cloudflare Worker with per-device and account-wide fair-use
  quotas. Screenshot questions are served by Cloudflare Workers AI (Llama 4
  Scout); text-only turns by Groq (GPT-OSS 120B). The relay stores no
  screenshots, prompts, or answers — only a random device id and usage
  counters (`/privacy`, `/terms` on the relay for details).
- **Bring-your-own-key mode**: connect your own NVIDIA NIM key, stored with
  OS-backed encryption (Windows DPAPI), never in the renderer or logs.
- Streaming answers with markdown rendering, retry, cancel, and an accurate
  header chip showing which model actually served each answer.
- Adjustable **liquid-glass tint**: a slider in Settings → Appearance slides
  the frosted glass from clear to near-opaque, live in every window.
- Frosted-glass UI with in-page desktop backdrop blur; fully frameless,
  rounded, resizable popup.
- Settings: access mode (hosted / own key), model picker with connection test,
  shortcut recorder, quota meter for hosted mode, and links to the hosted
  privacy notice and terms.
- Security baseline: contextIsolation, sandboxed renderers, strict CSP,
  navigation/window-open/webview denied, IPC validation in the main process.
- Tests: 191 unit tests, 117-check E2E user-journey suite (including the full
  update check → download → verify flow and the glass-tint slider against a
  mock relay), integration and
  persistence harnesses; CI on GitHub Actions (Windows app build + relay
  dry-run) and a scheduled relay health monitor.
- Automatic updates: the app polls the relay's update feed, downloads the
  installer, verifies its SHA-256, and offers a confirmed install-and-restart.
  Operators publish releases with `node scripts/upload-update.mjs` (R2-backed).
- Crash handling and rotating local logs (no content, no keys, no ids), plus
  "Open log folder" and "Copy diagnostics" in Settings → Privacy.
- Relay operations: staging environment, kill switch (`HOSTED_ENABLED`),
  minimum-app-version gate (`MIN_APP_VERSION`), and a runbook in
  `relay/README.md`.

[0.1.0]: https://github.com/OWNER/REPO/releases/tag/v0.1.0
