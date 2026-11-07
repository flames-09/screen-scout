// API-key persistence probe: proves the saved key is remembered across real
// process restarts and stored ENCRYPTED on disk.
//
//   1. save   → launch 1 stores the probe key via the real SecretStore
//   2. (here) → read api-key.bin and assert the plaintext key is NOT in it
//   3. check  → launch 2 (a brand-new process) must decrypt it back
//   4. clear  → launch 3 removes it and confirms it's gone
//
// Runs against an isolated ./.persistence-test-userdata directory; the user's
// real key in %APPDATA% is never touched.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ELECTRON =
  process.platform === 'win32' ? join('node_modules', 'electron', 'dist', 'electron.exe') : join('node_modules', '.bin', 'electron')
const PROBE_DIR = join(process.cwd(), '.persistence-test-userdata')
const KEY_FILE = join(PROBE_DIR, 'api-key.bin')
const PROBE_PLAINTEXT = 'nvapi-persistence-probe'

const launch = (phase) => {
  try {
    const stdout = execFileSync(ELECTRON, ['.', `--persistence-test=${phase}`], {
      encoding: 'utf8',
      timeout: 30000
    })
    return { phase, ok: true, out: stdout.trim() }
  } catch (error) {
    return { phase, ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() }
  }
}

const results = []

// Start-of-run cleanup: leftovers from a previously crashed run must not
// block a fresh probe (AV/Defender can hold handles on Windows).
try {
  rmSync(PROBE_DIR, { recursive: true, force: true })
} catch {
  console.error('WARN: could not clear stale probe dir before run')
}

// 1. save
results.push(launch('save'))

// 2. verify on-disk encryption between save and check
let encryption = { fileExists: false, plaintextAbsent: false, bytes: 0 }
if (existsSync(KEY_FILE)) {
  const raw = readFileSync(KEY_FILE)
  encryption = {
    fileExists: true,
    plaintextAbsent: !raw.includes(PROBE_PLAINTEXT),
    bytes: raw.length
  }
}

// 3. check (fresh process — this is the actual "remembers across restarts" test)
results.push(launch('check'))

// 4. clear
results.push(launch('clear'))

for (const r of results) {
  const line = r.out.split('\n').find((l) => l.startsWith('PERSISTENCE_'))
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.phase}: ${line ?? '(no output)'}`)
}
console.log(
  `OK   on-disk: exists=${encryption.fileExists} plaintextAbsent=${encryption.plaintextAbsent} bytes=${encryption.bytes}`
)

const saveOk =
  results[0].ok && results[0].out.includes('"ok":true') && results[0].out.includes('"secure":true')
const checkOk = results[1].ok && results[1].out.includes('"remembered":true')
const clearOk = results[2].ok && results[2].out.includes('"cleared":true')
const encryptedOk = encryption.fileExists && encryption.plaintextAbsent

// Cleanup is best-effort: an EPERM/EBUSY from AV scanning the fresh files
// must never turn a passing run into a reported failure.
try {
  rmSync(PROBE_DIR, { recursive: true, force: true })
} catch {
  console.error('WARN: could not remove probe dir after run (gitignored; safe to delete manually)')
}

if (saveOk && checkOk && clearOk && encryptedOk) {
  console.log('PERSISTENCE PASS — key remembered across restarts, stored encrypted on disk')
  process.exit(0)
} else {
  console.log('PERSISTENCE FAIL')
  process.exit(1)
}
