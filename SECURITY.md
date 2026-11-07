# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

> **[PLACEHOLDER — operator to complete: set up GitHub private vulnerability
> reporting (repo → Settings → Security) and/or a security contact email.]**

Include: what you found, how to reproduce it, and any impact you can
demonstrate. Please give a reasonable timeframe before public disclosure.

## Scope

- The desktop app (`src/`, packaging config) — e.g. renderer escape, IPC
  bypass, secret exposure, capture leaks.
- The relay (`relay/`) — e.g. quota bypass, token forgery, upstream payload
  injection, request smuggling past the allow-list.

## Not in scope

- Volumes/quotas as a fair-use matter (report abuse, not bugs).
- Vulnerabilities in third-party services (report to the provider: NVIDIA,
  Cloudflare, Groq).

## What we do

- Secrets live only in Cloudflare Worker secrets; none ship in the app or the
  repository.
- Renderers are sandboxed, context-isolated, and CSP-restricted; IPC is
  validated in the main process; navigation, window.open, and webviews are
  denied.
- Upstream relay requests are rebuilt from a strict allow-list; tokens are
  short-lived HMAC-signed device tokens; no content is logged.
