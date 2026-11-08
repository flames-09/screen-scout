/**
 * Version comparison for the hosted-service gates.
 *
 * Numeric semver-ish ordering, deliberately tolerant: prerelease suffixes are
 * ignored ("1.2.0-beta" == "1.2.0"), a leading "v" is allowed, and missing
 * components count as 0. The gate only needs "is this client older than the
 * oldest version the relay still supports".
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const left = pa[i] ?? 0
    const right = pb[i] ?? 0
    if (left !== right) return left > right ? 1 : -1
  }
  return 0
}

export function isOlderThan(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) < 0
}
