import {
  type CSSProperties,
  Fragment,
  memo,
  type DragEvent as ReactDragEvent,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ViewGroup, ViewRow } from '@notarium/contract'

import { Button } from '../../core/Button'
import { InsertionPlaceholder } from '../../core/InsertionPlaceholder'
import {
  currentDragItems,
  DRAG_MIME,
  type DragNoteItem,
  endDrag,
  readDrag,
} from '../../libs/dnd/dnd'
import { BoardCard } from './BoardCard'
import {
  boardDropDecision,
  boardDropDecisionFromModel,
  type BoardDropModel,
  type BoardMoveTarget,
  boardPointerCardHeight,
  createBoardDropModel,
  endBoardPointerDrag,
  ownBoardPointerTarget,
  releaseBoardPointerTarget,
} from './boardDnd'
import { BoardCardSkeleton } from './BoardSkeleton'
import styles from './Board.module.scss'

type DropDecision =
  { kind: 'move'; target: BoardMoveTarget; renderIndex: number; height?: number } | { kind: 'noop' }

type CardGeometry = {
  rows: readonly ViewRow[]
  cardId: string
  midpoints: readonly number[]
}

type BoardColumnProps = {
  group: ViewGroup
  rows: readonly ViewRow[]
  total: number
  loading: boolean
  error: string | null
  hostRef?: Ref<HTMLDivElement>
  onLoadMore?: (group: ViewGroup, offset: number) => void
  onRetry?: (group: ViewGroup) => void
  writable: boolean
  dropWritable: boolean
  busyCardId?: string | null
  onMove?: (cardId: string, group: ViewGroup, target: BoardMoveTarget) => void
  keyboardPlacement?: { cardId: string; gap: number; height?: number }
  keyboardCardId?: string | null
  onKeyboardCommand?: (cardId: string, key: string, element: HTMLElement) => void
  focusCardId?: string | null
  onCardFocused?: () => void
}

const hasInternalPayload = (event: ReactDragEvent): boolean =>
  currentDragItems().length > 0 || Array.from(event.dataTransfer.types).includes(DRAG_MIME)

const singleDraggedNote = (): DragNoteItem | null => {
  const items = currentDragItems()

  return items.length === 1 && items[0]?.kind === 'note' ? items[0] : null
}

export const BoardColumn = memo(
  ({
    group,
    rows,
    total,
    loading,
    error,
    hostRef,
    onLoadMore,
    onRetry,
    writable,
    dropWritable,
    busyCardId,
    onMove,
    keyboardPlacement,
    keyboardCardId,
    onKeyboardCommand,
    focusCardId,
    onCardFocused,
  }: BoardColumnProps) => {
    const decision = useRef<DropDecision | null>(null)
    const geometry = useRef<CardGeometry | null>(null)
    const dropModel = useRef<{
      rows: readonly ViewRow[]
      cardId: string
      model: BoardDropModel
    } | null>(null)
    const [placement, setPlacement] = useState<{ index: number; height?: number } | null>(null)
    const acceptsDrop = writable && dropWritable

    const clearTarget = useCallback(() => {
      releaseBoardPointerTarget(clearTarget)
      decision.current = null
      geometry.current = null
      setPlacement(null)
    }, [])

    useEffect(() => {
      return () => releaseBoardPointerTarget(clearTarget)
    }, [clearTarget])
    const decisionForGap = (cardId: string, requestedGap: number): DropDecision => {
      let cached = dropModel.current

      if (!cached || cached.rows !== rows || cached.cardId !== cardId) {
        cached = { rows, cardId, model: createBoardDropModel(rows, cardId) }
        dropModel.current = cached
      }
      const next = boardDropDecisionFromModel(cached.model, requestedGap)

      return next.kind === 'move' ? { ...next, height: boardPointerCardHeight(cardId) } : next
    }

    const showDecision = (next: DropDecision) => {
      ownBoardPointerTarget(clearTarget)
      const current = decision.current

      if (
        current?.kind === next.kind &&
        (next.kind === 'noop' ||
          (current.kind === 'move' &&
            current.renderIndex === next.renderIndex &&
            current.height === next.height &&
            current.target.beforeId === next.target.beforeId &&
            current.target.afterId === next.target.afterId))
      ) {
        return
      }
      decision.current = next
      setPlacement(next.kind === 'move' ? { index: next.renderIndex, height: next.height } : null)
    }

    const defaultDecision = (cardId: string): DropDecision =>
      decisionForGap(cardId, rows.filter((row) => row.id !== cardId).length)

    const gapAt = (host: HTMLElement, cardId: string, clientY: number): number => {
      let current = geometry.current

      if (!current || current.rows !== rows || current.cardId !== cardId) {
        const candidates = [
          ...host.querySelectorAll<HTMLElement>(':scope > [data-note-id]'),
        ].filter((element) => element.dataset.noteId !== cardId)

        current = {
          rows,
          cardId,
          midpoints: candidates.map((element) => {
            const rect = element.getBoundingClientRect()

            return rect.top + rect.height / 2
          }),
        }
        geometry.current = current
      }
      let low = 0
      let high = current.midpoints.length

      while (low < high) {
        const middle = (low + high) >>> 1

        if (clientY < current.midpoints[middle]!) {
          high = middle
        } else {
          low = middle + 1
        }
      }

      return low
    }

    const keyboardDecision = useMemo(() => {
      if (!keyboardPlacement) {
        return null
      }
      const next = boardDropDecision(rows, keyboardPlacement.cardId, keyboardPlacement.gap)

      return next.kind === 'move'
        ? { index: next.renderIndex, height: keyboardPlacement.height }
        : null
    }, [keyboardPlacement, rows])
    const renderedPlacement = keyboardDecision ?? placement

    const acceptDrag = (event: ReactDragEvent): DragNoteItem | null => {
      const card = singleDraggedNote()

      if (!acceptsDrop || !card) {
        if (hasInternalPayload(event)) {
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'none'
        }

        return null
      }
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      return card
    }

    return (
      <section
        ref={hostRef}
        className={styles.column}
        data-group={group.key}
        aria-label={`${group.label ?? group.value ?? group.state}, ${group.count} cards`}
        style={
          group.color
            ? ({ '--board-column-color': `var(--field-color-${group.color})` } as CSSProperties)
            : undefined
        }
      >
        <header className={styles.columnHead}>
          <span className={styles.columnLabel}>
            {group.label ?? group.value ?? (group.state === 'absent' ? 'No value' : 'Empty')}
          </span>
          <span className={styles.columnCount}>{group.count}</span>
        </header>
        <div
          className={styles.cards}
          data-testid="board-column-cards"
          onDragOver={(event) => {
            const card = acceptDrag(event)

            if (card) {
              showDecision(
                decisionForGap(card.id, gapAt(event.currentTarget, card.id, event.clientY)),
              )
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              clearTarget()
            }
          }}
          onDrop={(event) => {
            const items = readDrag(event)

            if (
              !acceptsDrop ||
              items.length !== 1 ||
              items[0]?.kind !== 'note' ||
              !hasInternalPayload(event)
            ) {
              return
            }
            event.preventDefault()
            event.stopPropagation()
            const resolved = decision.current ?? defaultDecision(items[0].id)

            if (resolved.kind === 'move') {
              onMove?.(items[0].id, group, resolved.target)
            }
            clearTarget()
            endBoardPointerDrag()
            endDrag()
          }}
        >
          {rows.map((row, index) => (
            <Fragment key={row.id}>
              {renderedPlacement?.index === index ? (
                <InsertionPlaceholder height={renderedPlacement.height} />
              ) : null}
              <BoardCard
                row={row}
                writable={writable}
                busy={busyCardId === row.id}
                keyboardMoving={keyboardCardId === row.id}
                keyboardMode={keyboardCardId != null}
                onKeyboardCommand={onKeyboardCommand}
                focusOnMount={focusCardId === row.id}
                onFocusRestored={onCardFocused}
              />
            </Fragment>
          ))}
          {renderedPlacement?.index === rows.length ? (
            <InsertionPlaceholder height={renderedPlacement.height} />
          ) : null}
          {loading && rows.length === 0 && total > 0 ? <BoardCardSkeleton /> : null}
          {error ? <p className={styles.columnError}>{error}</p> : null}
          {error && onRetry ? (
            <Button variant="ghost" onClick={() => onRetry(group)}>
              Retry
            </Button>
          ) : null}
          {!error && !loading && rows.length < total && onLoadMore ? (
            <Button variant="ghost" onClick={() => onLoadMore(group, rows.length)}>
              Load more
            </Button>
          ) : null}
        </div>
      </section>
    )
  },
)

BoardColumn.displayName = 'BoardColumn'
