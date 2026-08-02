import { describe, expect, it } from 'vitest'

import { validationIssuesOf } from './validationError'

describe('validationIssuesOf', () => {
  it('normalises a Zod error by public shape rather than package identity', () => {
    const crossWorkspaceError = {
      name: 'ZodError',
      issues: [{ path: ['createdAt'], message: 'Invalid datetime' }],
    }

    expect(validationIssuesOf(crossWorkspaceError)).toEqual([
      { path: 'createdAt', message: 'Invalid datetime' },
    ])
  })

  it.each([
    new Error('internal'),
    { name: 'ZodError', issues: 'not-an-array' },
    { name: 'ZodError', issues: [{ path: [], message: 123 }] },
    {
      name: 'ZodError',
      issues: [{ path: [{ toString: () => 'spoofed' }], message: 'not a Zod property path' }],
    },
  ])('does not misclassify arbitrary internal error %#', (error) => {
    expect(validationIssuesOf(error)).toBeNull()
  })
})
