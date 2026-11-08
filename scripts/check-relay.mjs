#!/usr/bin/env node
/**
 * Relay health probe — exits non-zero when the hosted service looks down.
 *
 * Used by the scheduled CI monitor (.github/workflows/relay-monitor.yml) and
 * handy for local checks:  node scripts/check-relay.mjs [baseUrl]
 *
 * Verifies /health returns ok:true AND that the update feed responds (503
 * updates-unavailable is acceptable until R2 is enabled — only 5xx from the
 * health endpoint or a network failure is "down").
 */
const base = (process.argv[2] ?? 'https://screen-scout-relay.flamesrise09.workers.dev').replace(/\/$/, '')

async function main() {
  const failures = []
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(15_000) })
    const body = await res.json().catch(() => null)
    if (!res.ok || body?.ok !== true) failures.push(`/health HTTP ${res.status} ok=${body?.ok}`)
    else if (body.signingConfigured !== true) failures.push('/health reports signingConfigured=false')
  } catch (error) {
    failures.push(`/health unreachable: ${error?.message ?? error}`)
  }

  try {
    // The feed may legitimately 503 (R2 not enabled yet) — anything else is a problem.
    const res = await fetch(`${base}/updates/latest.json`, { signal: AbortSignal.timeout(15_000) })
    if (res.status !== 200 && res.status !== 503) failures.push(`/updates/latest.json HTTP ${res.status}`)
  } catch (error) {
    failures.push(`/updates/latest.json unreachable: ${error?.message ?? error}`)
  }

  if (failures.length > 0) {
    console.error(`RELAY_CHECK_FAIL ${base}`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log(`RELAY_CHECK_OK ${base}`)
}

main()
