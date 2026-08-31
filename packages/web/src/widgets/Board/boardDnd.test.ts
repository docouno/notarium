import { describe, expect, it } from 'vitest'
import type { ViewRow } from '@notarium/contract'

import { boardDropDecisionFromModel, createBoardDropModel } from './boardDnd'

describe('board pointer drop model', () => {
  it('keeps repeated 100-row gap decisions constant-time after one model build', () => {
    let rowReads = 0
    const rows = new Proxy(
      Array.from({ length: 100 }, (_, index): ViewRow => ({
        id: `task-${index}`,
        title: `Task ${index}`,
        filePath: `work/${index}.md`,
      })),
      {
        get: (target, property, receiver) => {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            rowReads++
          }

          return Reflect.get(target, property, receiver)
        },
      },
    )
    const model = createBoardDropModel(rows, 'task-50')

    expect(rowReads).toBeGreaterThanOrEqual(100)
    rowReads = 0
    for (let index = 0; index < 1_000; index++) {
      const decision = boardDropDecisionFromModel(model, index % 100)

      expect(decision.kind === 'noop' || decision.kind === 'move').toBe(true)
    }

    expect(rowReads).toBe(0)
    expect(boardDropDecisionFromModel(model, 0)).toEqual({
      kind: 'move',
      target: { beforeId: 'task-0' },
      renderIndex: 0,
    })
    expect(boardDropDecisionFromModel(model, 50)).toEqual({ kind: 'noop' })
    expect(boardDropDecisionFromModel(model, 99)).toEqual({
      kind: 'move',
      target: { afterId: 'task-99' },
      renderIndex: 100,
    })
  })
})
