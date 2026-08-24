import { describe, expect, it } from 'vitest'

import { clientFailureOf, defineClientFailure } from './clientFailure'

describe('clientFailure', () => {
  it.each([
    [{ kind: 'not-found' } as const],
    [{ kind: 'conflict', message: 'choose another name' } as const],
    [{ kind: 'actionable', message: 'fix the request and retry' } as const],
  ])('round-trips an explicitly defined %o projection', (failure) => {
    const error = defineClientFailure(new Error('private cause'), failure)

    expect(clientFailureOf(error)).toEqual(failure)
    expect(clientFailureOf({ ...error })).toBeNull()
  })

  it('treats absence as an internal failure', () => {
    expect(clientFailureOf(new Error('database password leaked'))).toBeNull()
    expect(clientFailureOf({ kind: 'actionable', message: 'forged' })).toBeNull()
  })

  it('refuses a raw message on a not-found projection', () => {
    expect(() =>
      defineClientFailure(new Error('private path'), {
        kind: 'not-found',
        message: 'private path',
      } as never),
    ).toThrow('cannot carry a message')
  })

  it.each([
    { kind: 'conflict', message: '' },
    { kind: 'actionable', message: '   ' },
  ])('refuses an empty authored message for %o', (failure) => {
    expect(() => defineClientFailure(new Error('private cause'), failure as never)).toThrow(
      'must be a non-empty string',
    )
  })
})
