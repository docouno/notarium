import { type KeyboardEvent, memo, useLayoutEffect, useRef, useState } from 'react'
import type { ViewRow } from '@notarium/contract'
import { slugify } from '@notarium/core/slug'

import { CardLink } from '../../core/CardLink'
import { Chip } from '../../core/Chips'
import { cx } from '../../libs/cx/cx'
import { type DragNoteItem, endDrag, startDrag } from '../../libs/dnd/dnd'
import { noteRouteForClass } from '../../libs/routing/routePaths'
import { beginBoardPointerDrag, endBoardPointerDrag } from './boardDnd'
import styles from './Board.module.scss'

const dragItemFor = (row: ViewRow): DragNoteItem => {
  const slash = row.filePath.lastIndexOf('/')

  return {
    kind: 'note',
    id: row.id,
    fileName: slash < 0 ? row.filePath : row.filePath.slice(slash + 1),
    srcFolder: slash < 0 ? '' : row.filePath.slice(0, slash),
  }
}

const fieldText = (field: NonNullable<ViewRow['fields']>[string]): string =>
  field.label ??
  (Array.isArray(field.value) ? field.value.join(', ') : field.value) ??
  (field.state === 'unreadable' ? 'Unreadable' : '—')

type BoardCardProps = {
  row: ViewRow
  writable: boolean
  busy: boolean
  keyboardMoving?: boolean
  keyboardMode?: boolean
  onKeyboardCommand?: (cardId: string, key: string, element: HTMLElement) => void
  focusOnMount?: boolean
  onFocusRestored?: () => void
}

export const BoardCard = memo(
  ({
    row,
    writable,
    busy,
    keyboardMoving,
    keyboardMode,
    onKeyboardCommand,
    focusOnMount,
    onFocusRestored,
  }: BoardCardProps) => {
    const href = noteRouteForClass(row.id, undefined, slugify(row.title))
    const [dragging, setDragging] = useState(false)
    const host = useRef<HTMLElement>(null)

    useLayoutEffect(() => {
      if (!focusOnMount || !host.current) {
        return
      }
      host.current.focus()
      onFocusRestored?.()
    }, [focusOnMount, onFocusRestored])

    return (
      <article
        ref={host}
        className={cx(
          styles.card,
          dragging && styles.cardDragging,
          keyboardMoving && styles.cardKeyboardMoving,
        )}
        data-note-id={row.id}
        draggable={writable && !busy && !keyboardMode}
        tabIndex={writable && (!keyboardMode || keyboardMoving || focusOnMount) ? 0 : undefined}
        aria-label={writable ? `${row.title}. Press Space to move.` : undefined}
        aria-keyshortcuts={
          writable ? 'Space ArrowUp ArrowDown ArrowLeft ArrowRight Escape' : undefined
        }
        onDragStart={
          writable
            ? (event) => {
                event.stopPropagation()
                setDragging(true)
                beginBoardPointerDrag(row.id, event.currentTarget.getBoundingClientRect().height)
                startDrag(event, dragItemFor(row))
              }
            : undefined
        }
        onDragEnd={
          writable
            ? (event) => {
                event.stopPropagation()
                setDragging(false)
                endBoardPointerDrag()
                endDrag()
              }
            : undefined
        }
        onKeyDown={
          writable
            ? (event: KeyboardEvent<HTMLElement>) => {
                if (event.target !== event.currentTarget) {
                  return
                }
                if (
                  ![
                    ' ',
                    'Spacebar',
                    'ArrowUp',
                    'ArrowDown',
                    'ArrowLeft',
                    'ArrowRight',
                    'Escape',
                  ].includes(event.key)
                ) {
                  return
                }
                event.preventDefault()
                event.stopPropagation()
                onKeyboardCommand?.(row.id, event.key, event.currentTarget)
              }
            : undefined
        }
        aria-busy={busy || undefined}
      >
        <div className={styles.cardHead}>
          <CardLink
            className={styles.cardLink}
            href={href}
            dataNoteRoute={row.id}
            title={row.title}
            draggable={false}
          >
            {row.title}
          </CardLink>
        </div>
        {row.fields && Object.keys(row.fields).length > 0 ? (
          <div className={styles.cardFields}>
            {Object.entries(row.fields).map(([key, field]) => {
              const label = fieldText(field)

              return (
                <Chip
                  key={key}
                  color={field.color}
                  title={`${key}: ${label}`}
                  ariaLabel={`${key}: ${label}`}
                >
                  {label}
                </Chip>
              )
            })}
          </div>
        ) : null}
      </article>
    )
  },
)

BoardCard.displayName = 'BoardCard'
