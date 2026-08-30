import { describe, expect, it } from 'vitest'
import type { FieldDeclaration } from '@notarium/contract'

import { absoluteDate } from '../datetime'
import { cardFieldValues } from './fields'

describe('cardFieldValues', () => {
  it('uses enum presentation and the canonical absolute date format', () => {
    const schema: FieldDeclaration[] = [
      {
        key: 'status',
        type: 'enum',
        card: true,
        values: [{ key: 'doing', label: 'Doing', color: 'amber' }],
      },
      { key: 'due', type: 'date', card: true },
    ]

    expect(cardFieldValues({ status: 'doing', due: '2026-09-01' }, schema)).toEqual([
      { key: 'status', fieldLabel: 'Status', label: 'Doing', color: 'amber' },
      { key: 'due', fieldLabel: 'Due', label: absoluteDate('2026-09-01') },
    ])
  })

  it('formats only conforming dates and leaves mismatches raw', () => {
    const schema = [{ key: 'due', label: 'Due', type: 'date' as const, card: true }]

    expect(cardFieldValues({ due: '2026-09-01' }, schema)[0].label).toBe('Sep 1, 2026')
    expect(cardFieldValues({ due: '01/02/2026' }, schema)[0].label).toBe('01/02/2026')
  })
})
