import { type ReactNode, useMemo } from 'react'
import { TagChips } from '../../core/Chips'
import { IconFolder } from '../../core/Icons'
import { feedTagRoute } from '../../libs/routing/routePaths'
import styles from './MetaPanel.module.scss'

// Read-only note metadata for the reading-mode inspector — the counterpart to
// EditorMeta (which is editable, edit-mode only). Folder is derived from the
// storage path; type/tags/class and any remaining frontmatter are shown as-is.
// Dates aren't here: GET /api/note carries no created/modified yet (they live in
// the Feed's list layer) — surfacing them is a separate, non-blocking step (#35).
type MetaNote = {
  filePath?: string
  frontmatter?: Record<string, unknown>
  class?: string
}

// Frontmatter keys kept OUT of the generic "other frontmatter" dump: the ones
// shown as dedicated rows (type, tags), plus structural/storage fields that
// aren't user-authored metadata — `title` repeats the heading, `permalink` is a
// legacy storage artifact, `notarium-id` is the identity stamp (#51).
const HIDDEN_KEYS = new Set(['type', 'tags', 'title', 'permalink', 'notarium-id', 'id'])

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className={styles.field}>
    <span className={styles.label}>{label}</span>
    <div className={styles.value}>{children}</div>
  </div>
)

const formatValue = (v: unknown): string => {
  if (v == null) {
    return ''
  }
  if (Array.isArray(v)) {
    return v.map(formatValue).join(', ')
  }
  if (typeof v === 'object') {
    return JSON.stringify(v)
  }

  return String(v)
}

export const MetaPanel = ({
  note,
  space,
  onOpenTag,
}: {
  note: MetaNote
  space?: string
  onOpenTag?: (foldedTag: string) => void
}) => {
  const fm = useMemo(() => note.frontmatter || {}, [note.frontmatter])
  const path = (note.filePath || '').replace(/\.md$/, '')
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const type = typeof fm.type === 'string' ? fm.type : ''
  const tags = useMemo<string[]>(
    () => (Array.isArray(fm.tags) ? fm.tags.map(String) : fm.tags ? [String(fm.tags)] : []),
    [fm.tags],
  )
  // Everything else from the frontmatter, so nothing the note carries is hidden
  // (the agent-native angle: notes accrue arbitrary frontmatter — #21).
  const extra = useMemo(
    () => Object.entries(fm).filter(([k, v]) => !HIDDEN_KEYS.has(k) && v != null && v !== ''),
    [fm],
  )

  return (
    <div className={styles.metaPanel} data-testid="meta-panel">
      <Field label="Folder">
        <span className={styles.folder}>
          <IconFolder size={14} />
          {folder || <span className={styles.muted}>Root</span>}
        </span>
      </Field>
      <Field label="Type">
        {type ? (
          <span className={styles.pill}>{type}</span>
        ) : (
          <span className={styles.muted}>—</span>
        )}
      </Field>
      {note.class && (
        <Field label="Class">
          <span
            className={styles.pill}
            title="Storage class — follows where the note is mounted (read-only)"
          >
            {note.class}
          </span>
        </Field>
      )}
      <Field label="Tags">
        {tags.length ? (
          <span className={styles.tags}>
            <TagChips
              tags={tags}
              hrefForTag={space ? (_tag, folded) => feedTagRoute(space, folded) : undefined}
              onOpenTag={onOpenTag}
            />
          </span>
        ) : (
          <span className={styles.muted}>—</span>
        )}
      </Field>
      {extra.length > 0 && (
        <div className={styles.extra}>
          {extra.map(([k, v]) => (
            <Field key={k} label={k}>
              <span className={styles.extraValue}>{formatValue(v)}</span>
            </Field>
          ))}
        </div>
      )}
    </div>
  )
}
