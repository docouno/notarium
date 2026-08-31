import type { ViewRow } from '@notarium/contract'

export type BoardMoveTarget = { beforeId?: string; afterId?: string }

export type BoardDropDecision =
  { kind: 'move'; target: BoardMoveTarget; renderIndex: number } | { kind: 'noop' }

export type BoardDropModel = {
  cardId: string
  sourceIndex: number
  rowCount: number
  remainingIds: readonly string[]
  renderIndices: readonly number[]
}

let activePointerCard: { id: string; height: number } | null = null
let activePointerTarget: (() => void) | null = null

export const beginBoardPointerDrag = (id: string, height: number): void => {
  activePointerCard = { id, height }
}

export const endBoardPointerDrag = (): void => {
  activePointerCard = null
  const clear = activePointerTarget

  activePointerTarget = null
  clear?.()
}

export const ownBoardPointerTarget = (clear: () => void): void => {
  if (activePointerTarget === clear) {
    return
  }
  const previous = activePointerTarget

  activePointerTarget = clear
  previous?.()
}

export const releaseBoardPointerTarget = (clear: () => void): void => {
  if (activePointerTarget === clear) {
    activePointerTarget = null
  }
}

export const boardPointerCardHeight = (id: string): number | undefined =>
  activePointerCard?.id === id ? activePointerCard.height : undefined

export const createBoardDropModel = (rows: readonly ViewRow[], cardId: string): BoardDropModel => {
  let sourceIndex = -1
  const remainingIds: string[] = []
  const renderIndices: number[] = []

  for (let index = 0; index < rows.length; index++) {
    const id = rows[index]!.id

    if (id === cardId) {
      sourceIndex = index
    } else {
      remainingIds.push(id)
      renderIndices.push(index)
    }
  }

  return { cardId, sourceIndex, rowCount: rows.length, remainingIds, renderIndices }
}

export const boardDropDecisionFromModel = (
  model: BoardDropModel,
  requestedGap: number,
): BoardDropDecision => {
  const gap = Math.max(0, Math.min(requestedGap, model.remainingIds.length))

  if (model.sourceIndex >= 0 && gap === model.sourceIndex) {
    return { kind: 'noop' }
  }
  const before = model.remainingIds[gap]
  const after = model.remainingIds[gap - 1]

  return {
    kind: 'move',
    target: before ? { beforeId: before } : after ? { afterId: after } : {},
    renderIndex: before ? model.renderIndices[gap]! : model.rowCount,
  }
}

export const boardDropDecision = (
  rows: readonly ViewRow[],
  cardId: string,
  requestedGap: number,
): BoardDropDecision => boardDropDecisionFromModel(createBoardDropModel(rows, cardId), requestedGap)
