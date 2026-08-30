import { describe, expect, it, vi } from 'vitest'

import {
  PROVIDER_CALL_LOG_RETENTION_ENV,
  providerCallLogRetentionBefore,
  providerCallLogRetentionFromEnv,
  pruneProviderCallLogRetention,
} from './providerCallLog'

describe('provider call-log retention policy', () => {
  it('defaults to 90 days and accepts only the approved horizons', () => {
    expect(providerCallLogRetentionFromEnv(undefined)).toBe(90)
    expect(providerCallLogRetentionFromEnv('30')).toBe(30)
    expect(providerCallLogRetentionFromEnv('90')).toBe(90)
    expect(providerCallLogRetentionFromEnv('365')).toBe(365)
    expect(providerCallLogRetentionFromEnv('forever')).toBeNull()
    expect(() => providerCallLogRetentionFromEnv('')).toThrow(PROVIDER_CALL_LOG_RETENTION_ENV)
    expect(() => providerCallLogRetentionFromEnv('91')).toThrow(PROVIDER_CALL_LOG_RETENTION_ENV)
  })

  it('derives one exact cutoff and turns forever into a no-op', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z')
    const persistence = { pruneTerminalBefore: vi.fn(async () => 17) }

    expect(providerCallLogRetentionBefore(now, 90)).toBe('2026-06-01T00:00:00.000Z')
    await expect(
      pruneProviderCallLogRetention(persistence, { now, days: 90, limit: 1_000 }),
    ).resolves.toBe(17)
    expect(persistence.pruneTerminalBefore).toHaveBeenCalledWith('2026-06-01T00:00:00.000Z', 1_000)

    persistence.pruneTerminalBefore.mockClear()
    await expect(pruneProviderCallLogRetention(persistence, { now, days: null })).resolves.toBe(0)
    expect(persistence.pruneTerminalBefore).not.toHaveBeenCalled()
  })
})
