import { EmptyState } from '../../core/EmptyState'
import { IconLink } from '../../core/Icons'
import type { GraphNodeView as GraphNode } from '../../libs/wire'
import type { GraphLinkRef } from './useNoteGraph'
import styles from './panels.module.scss'

// Backlinks (incoming) and Links (outgoing) are the two directions of the same
// edge set, so they render through one list. `kind` only swaps the empty-state
// copy and the test ids — the row itself (a relation type over a title, a ghost
// row that creates the note on click) is identical both ways.
type LinkListProps = {
  kind: 'backlinks' | 'links'
  items: GraphLinkRef[]
  onOpen: (id: string) => void
  onCreateFromGhost?: (node: GraphNode) => void
}

const COPY = {
  backlinks: {
    emptyTitle: 'Nothing links here yet',
    emptyHint: 'Notes that reference this one will appear here.',
    emptyTestId: 'backlinks-empty',
    listTestId: 'backlinks-list',
  },
  links: {
    emptyTitle: 'No links from this note',
    emptyHint: 'Wiki-links you add to this note appear here.',
    emptyTestId: 'links-empty',
    listTestId: 'links-list',
  },
} as const

export const LinkList = ({ kind, items, onOpen, onCreateFromGhost }: LinkListProps) => {
  const copy = COPY[kind]

  if (items.length === 0) {
    return (
      <div className={styles.linkEmpty}>
        <EmptyState
          variant="bare"
          icon={<IconLink size={18} />}
          title={copy.emptyTitle}
          hint={copy.emptyHint}
          testId={copy.emptyTestId}
        />
      </div>
    )
  }

  return (
    <ul className={styles.linkList} data-testid={copy.listTestId}>
      {items.map(({ node, type }) => (
        <li key={`${node.id}|${type}`}>
          <button
            className={styles.link}
            data-ghost={node.ghost || undefined}
            onClick={() => (node.ghost ? onCreateFromGhost?.(node) : onOpen(node.id))}
            title={node.ghost ? 'Unresolved — click to create this note' : node.title}
          >
            <span className={styles.linkType}>{type}</span>
            <span className={styles.linkTitle}>{node.title}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
