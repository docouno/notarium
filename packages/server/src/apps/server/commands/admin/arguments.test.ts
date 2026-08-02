import { describe, expect, it } from 'vitest'

import { parseCommandLine } from '../../../../libs/commandLine'
import { normalizeAdminArguments } from './arguments'

describe('admin argument normalization', () => {
  it('treats an opaque grant id beginning with -- as literal positional data', () => {
    const parsed = parseCommandLine(
      normalizeAdminArguments(['grant', 'recovery', '--Abc1234567', 'reader']),
      {},
    )

    expect(parsed.positionals).toEqual(['grant', 'recovery', '--Abc1234567', 'reader'])
  })

  it('accepts the conventional explicit separator without duplicating it', () => {
    const parsed = parseCommandLine(
      normalizeAdminArguments(['grant', 'recovery', '--', '--Abc1234567', 'reader']),
      {},
    )

    expect(parsed.positionals).toEqual(['grant', 'recovery', '--Abc1234567', 'reader'])
  })

  it('leaves option-bearing admin commands untouched', () => {
    expect(normalizeAdminArguments(['passwd', 'recovery', '--random'])).toEqual([
      'passwd',
      'recovery',
      '--random',
    ])
  })
})
