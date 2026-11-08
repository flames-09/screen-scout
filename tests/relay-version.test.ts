import { describe, expect, it } from 'vitest'
import { compareVersions, isOlderThan } from '../relay/src/version'

describe('relay version comparison', () => {
  it('orders semver numerically', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('0.0.9', '0.1.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
  })

  it('tolerates v prefixes, prereleases, and missing components', () => {
    expect(compareVersions('v0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(isOlderThan('v0.0.9', '0.1.0')).toBe(true)
    expect(isOlderThan('0.1.0', '0.1.0')).toBe(false)
  })

  it('treats junk as zeros rather than crashing', () => {
    expect(compareVersions('abc', '0.0.1')).toBe(-1)
    expect(compareVersions('unknown', '0.0.0')).toBe(0)
  })
})
