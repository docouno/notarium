import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { ViewGroup } from '@notarium/contract'

import { Select } from '../../core/Select'
import { endDrag } from '../../libs/dnd/dnd'
import { endBoardPointerDrag } from './boardDnd'
import styles from './Board.module.scss'

export const Board = ({
  groups,
  onVisible,
  renderColumn,
}: {
  groups: readonly ViewGroup[]
  onVisible: (key: string) => void
  renderColumn: (group: ViewGroup, ref: (element: HTMLDivElement | null) => void) => ReactNode
}) => {
  const scroller = useRef<HTMLDivElement>(null)
  const columns = useRef(new Map<string, HTMLDivElement>())
  const [selected, setSelected] = useState(groups[0]?.key)
  const columnRefs = useMemo(
    () =>
      new Map(
        groups.map((group) => [
          group.key,
          (element: HTMLDivElement | null) => {
            if (element) {
              columns.current.set(group.key, element)
            } else {
              columns.current.delete(group.key)
            }
          },
        ]),
      ),
    [groups],
  )

  useEffect(() => {
    const onDocumentDragEnd = () => {
      endBoardPointerDrag()
      endDrag()
    }

    document.addEventListener('dragend', onDocumentDragEnd, true)

    return () => document.removeEventListener('dragend', onDocumentDragEnd, true)
  }, [])

  useEffect(() => {
    setSelected((current) =>
      current && groups.some((group) => group.key === current) ? current : groups[0]?.key,
    )
    if (!groups.length) {
      return
    }
    if (typeof IntersectionObserver === 'undefined') {
      onVisible(groups[0]!.key)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const key = (entry.target as HTMLElement).dataset.group

            if (key) {
              onVisible(key)
            }
          }
        }
      },
      { root: scroller.current, rootMargin: '0px 320px 0px 320px', threshold: 0.01 },
    )

    for (const column of columns.current.values()) {
      observer.observe(column)
    }

    return () => observer.disconnect()
  }, [groups, onVisible])

  return (
    <div className={styles.board}>
      <Select
        className={styles.jump}
        value={selected}
        aria-label="Jump to board column"
        options={groups.map((group) => ({
          value: group.key,
          label: String(group.label ?? group.value ?? group.state),
          color: group.color,
        }))}
        onChange={(key) => {
          setSelected(key)
          columns.current.get(key)?.scrollIntoView({ behavior: 'smooth', inline: 'start' })
          onVisible(key)
        }}
      />
      <div ref={scroller} className={styles.scroller} data-testid="board-scroller">
        {groups.map((group) => renderColumn(group, columnRefs.get(group.key)!))}
      </div>
    </div>
  )
}
