import { type ReactNode, useId } from 'react'
import type { ParsedViewBlock } from '@notarium/core'

import { Notice } from '../../core/Notice'
import { Tabs } from '../../core/Tabs'
import styles from './ViewBlock.module.scss'

type ViewBlockProps = {
  block: ParsedViewBlock
  activeView?: number
  onSelectView?: (occurrence: number) => void
  children?: ReactNode
}

const failureCopy = (block: ParsedViewBlock): { title: string; variant: 'warning' | 'error' } => {
  switch (block.status) {
    case 'future':
      return { title: 'This view was written by a newer Notarium version.', variant: 'warning' }
    case 'read-only':
      return {
        title: 'This view uses YAML features that are available read-only.',
        variant: 'warning',
      }
    case 'resource-limit':
      return { title: 'This view exceeds the safe execution limits.', variant: 'warning' }
    default:
      return { title: 'This view block could not be parsed.', variant: 'error' }
  }
}

export const ViewBlock = ({ block, activeView, onSelectView, children }: ViewBlockProps) => {
  const panelId = useId()
  const selectedView = block.views.find((view) => view.occurrence === activeView) ?? block.views[0]

  if (block.status !== 'ready') {
    const copy = failureCopy(block)

    return (
      <section className={styles.block} aria-label="View block">
        <Notice variant={copy.variant}>{copy.title}</Notice>
        {block.diagnostics.length > 0 ? (
          <ul className={styles.diagnostics}>
            {block.diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.code}:${index}`}>{diagnostic.message}</li>
            ))}
          </ul>
        ) : null}
      </section>
    )
  }

  return (
    <section
      className={styles.block}
      aria-label={selectedView?.name ?? 'View block'}
      data-view-block
    >
      {block.views.length > 1 ? (
        <Tabs
          className={styles.switcher}
          value={String(activeView ?? block.views[0]!.occurrence)}
          onChange={(value) => onSelectView?.(Number(value))}
          ariaLabel="Views in this block"
          panelId={panelId}
          options={block.views.map((view) => {
            const duplicate = block.diagnostics.some(
              (diagnostic) =>
                diagnostic.code === 'duplicate-view-name' && diagnostic.view === view.occurrence,
            )

            return {
              value: String(view.occurrence),
              label: duplicate ? `${view.name} · duplicate` : view.name,
            }
          })}
        />
      ) : null}
      <div
        id={panelId}
        role={block.views.length > 1 ? 'tabpanel' : undefined}
        aria-label={selectedView?.name}
        className={styles.content}
        data-view-content
      >
        {children}
      </div>
    </section>
  )
}
