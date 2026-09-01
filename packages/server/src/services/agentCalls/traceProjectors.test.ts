import { describe, expect, it } from 'vitest'

import {
  fingerprintOf,
  inputShapeOf,
  issueSummaryOf,
  traceInputOf,
  traceResultOf,
} from './traceProjectors'

describe('agent call trace projections', () => {
  it('never projects authored bodies, edit needles, instructions, or replay credentials', () => {
    const secret = 'TRACE_SECRET_SENTINEL'
    const edit = traceInputOf(
      'edit_note',
      {
        ref: 'note-a',
        operation: 'findReplace',
        content: secret,
        find: `${secret}-find`,
        versionToken: `${secret}-version`,
        idempotencyKey: `${secret}-idempotency`,
      },
      true,
    )
    const ability = traceInputOf(
      'create_ability',
      {
        kind: 'skill',
        name: 'safe-name',
        description: `${secret}-description`,
        instructions: `${secret}-instructions`,
      },
      true,
    )
    const noteResult = traceResultOf(
      'get_note',
      { noteId: 'note-a', title: 'Safe title', content: `${secret}-body` },
      true,
    )
    const stored = JSON.stringify({ edit, ability, noteResult })

    expect(stored).not.toContain(secret)
    expect(stored).not.toContain('versionToken')
    expect(stored).not.toContain('idempotencyKey')
    expect(edit.compact).toMatchObject({ ref: 'note-a', contentBytes: secret.length })
  })

  it('keeps a folder-page create distinguishable from an ordinary one', () => {
    const page = traceInputOf(
      'create_note',
      { project: 'acme', path: 'docs', folderPage: true, body: '# Docs' },
      true,
    )
    const ordinary = traceInputOf(
      'create_note',
      { project: 'acme', path: 'docs', body: '# Docs' },
      true,
    )

    // Both calls title through the body, so neither sends a `title` argument: without the
    // selector they project to the same row, and the one door that mints a folder identity
    // and can add an active project's always-load body reads as an ordinary create.
    expect(page.compact).toMatchObject({ project: 'acme', path: 'docs', folderPage: true })
    expect(ordinary.compact).not.toHaveProperty('folderPage')
    expect(page.compact).not.toEqual(ordinary.compact)
  })

  it('normalizes invalid shape/issues without retaining arbitrary values or messages', () => {
    const secret = 'INVALID_VALUE_MUST_NOT_SURVIVE'
    const shape = inputShapeOf(
      { query: secret, PASSWORD_IS_hunter2: secret, versionToken: secret },
      'search',
    )
    const issues = issueSummaryOf(
      [
        {
          path: ['__unknown__'],
          code: 'unrecognized_keys',
          expected: 'object',
          message: secret,
        } as never,
      ],
      'search',
    )
    const stored = JSON.stringify({ shape, issues })

    expect(stored).not.toContain(secret)
    expect(stored).not.toContain('versionToken')
    expect(stored).not.toContain('PASSWORD_IS_hunter2')
    expect(fingerprintOf('search', shape.shape, issues)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('keeps the bounded retrieval query intact and reports projected omissions', () => {
    const query = 'q'.repeat(4096)
    const input = traceInputOf('search', { query }, false)
    const result = traceResultOf(
      'get_note',
      { noteId: 'note-a', title: 'Safe title', content: 'omitted body' },
      false,
    )

    expect(input.compact).toEqual({ query })
    expect(input.truncated).toBe(false)
    expect(result.redacted).toBe(true)
  })
})
