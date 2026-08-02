import { describe, expect, it } from 'vitest'

import { runHelp } from '../commands/help'
import { runVersion } from '../commands/version'
import { resolveCommand } from './resolve'

const errorOf = (args: string[]): string | undefined => {
  const resolution = resolveCommand(args)

  return 'error' in resolution ? resolution.error : undefined
}

describe('resolveCommand', () => {
  // Identity, not shape: asserting `toHaveProperty('run')` would pass on a table
  // whose aliases all point at the wrong command.
  it.each([
    [[], runHelp],
    [['help'], runHelp],
    [['--help'], runHelp],
    [['-h'], runHelp],
    [['version'], runVersion],
    [['--version'], runVersion],
    [['-v'], runVersion],
  ])('%j resolves to its own command', (args, expected) => {
    expect(resolveCommand(args)).toEqual({ run: expected })
  })

  it('rejects an unknown command by its original spelling', () => {
    expect(errorOf(['frobnicate'])).toBe('unknown command "frobnicate"')
    expect(errorOf(['--nope'])).toBe('unknown command "--nope"')
    expect(errorOf([''])).toBe('unknown command ""')
    expect(errorOf(['--'])).toBe('unknown command "--"')
  })

  // canon: docs/cli.md#stream-and-exit-contract
  it('rejects trailing arguments instead of ignoring them', () => {
    expect(errorOf(['version', '--json'])).toBe('unexpected argument "--json"')
    expect(errorOf(['help', 'bogus'])).toBe('unexpected argument "bogus"')
    expect(errorOf(['-v', '-h'])).toBe('unexpected argument "-h"')
  })

  it('reports an unknown command before its trailing arguments', () => {
    expect(errorOf(['frobnicate', 'extra'])).toBe('unknown command "frobnicate"')
  })

  it('treats Object.prototype keys as unknown commands', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(errorOf([key])).toBe(`unknown command "${key}"`)
    }
  })
})
