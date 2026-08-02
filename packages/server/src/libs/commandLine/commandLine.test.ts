import { describe, expect, it } from 'vitest'

import { parseCommandLine } from './commandLine'

describe('image CLI parser', () => {
  it('parses positionals, booleans, separate values, inline values and --', () => {
    const parsed = parseCommandLine(
      ['passwd', 'alice', '--random', '--display=Alice', '--', '--literal'],
      {
        random: 'boolean',
        display: 'value',
      },
    )

    expect(parsed.positionals).toEqual(['passwd', 'alice', '--literal'])
    expect(parsed.provided).toEqual(['random', 'display'])
    expect(parsed.has('random')).toBe(true)
    expect(parsed.value('display')).toBe('Alice')
  })

  it('rejects unknown, duplicate, missing and assigned boolean options', () => {
    expect(() => parseCommandLine(['--typo'], {})).toThrow(/unknown option/)
    expect(() => parseCommandLine(['--input=a', '--input=b'], { input: 'value' })).toThrow(
      /only once/,
    )
    expect(() => parseCommandLine(['--input', '--other'], { input: 'value' })).toThrow(
      /requires a value/,
    )
    expect(() => parseCommandLine(['--input='], { input: 'value' })).toThrow(/requires a value/)
    expect(() => parseCommandLine(['--random=yes'], { random: 'boolean' })).toThrow(
      /does not accept/,
    )
  })
})
