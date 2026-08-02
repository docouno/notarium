// The note-history timeline (#12) — the aside half of the VSCode-style pair:
// picking a revision here drives the revision view in the main content area
// (RevisionView); picking the selected one again deselects (back to current).
// Window-loaded (pages of 50) against the windowed /api/note/revisions
// contract. Props-driven, transport via the host-wired source port.

import { useCallback, useEffect, useState } from 'react'
import { REVISION_KIND } from '@notarium/contract/enums'
import { Button } from '../../core/Button'
import { EmptyState } from '../../core/EmptyState'
import { IconHistory } from '../../core/Icons'
import { Skeleton } from '../../core/Skeleton'
import { authorLabel } from '../../libs/author'
import { cx } from '../../libs/cx/cx'
import { exactDateTime, timeAgo } from '../../libs/datetime'
import type { NoteHistorySource, RevisionView } from '../../libs/revisions'
import { KIND_LABEL } from './helpers'
import styles from './HistoryTimeline.module.scss'

const PAGE = 50

export type HistorySelection = { revision: RevisionView; isLatest: boolean }

type HistoryTimelineProps = {
  source: NoteHistorySource
  /** Bumped by the host when the note changes underneath (SSE) — the timeline
   *  refetches so an open panel never shows a stale history. */
  refreshToken?: number
  selectedId: string | null
  /** A click selects; clicking the selected row again hands back null. */
  onSelect: (selection: HistorySelection | null) => void
}

// First-load placeholder: rows shaped like real revisions (version line left,
// meta right) so the swap to content doesn't shift the layout. Decorative.
const HistorySkeleton = () => (
  <div aria-hidden="true" data-testid="history-skeleton">
    <div className={styles.count}>
      <Skeleton w={70} h={12} radius={4} />
    </div>
    {Array.from({ length: 6 }, (_, i) => (
      <div key={i} className={styles.skeletonItem}>
        <Skeleton w={`${42 + ((i * 13) % 34)}%`} h={12} radius={4} />
        <Skeleton w={46} h={11} radius={4} />
      </div>
    ))}
  </div>
)

export const HistoryTimeline = ({
  source,
  refreshToken = 0,
  selectedId,
  onSelect,
}: HistoryTimelineProps) => {
  const [revisions, setRevisions] = useState<RevisionView[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // Whether the first page has come back: distinguishes "still loading" (show a
  // skeleton) from "loaded and genuinely empty" (show the empty state) — the
  // panel used to flash "No history yet" before the first response (#68 item 5).
  // The host remounts this widget per note (key=activeId), so a note switch
  // resets this to false and the skeleton shows again for the new note.
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(
    async (offset: number) => {
      try {
        const page = await source.list({ offset, limit: PAGE })
        setError(null)
        setTotal(page.total)
        setRevisions((prev) => (offset === 0 ? page.revisions : [...prev, ...page.revisions]))
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoaded(true)
      }
    },
    [source],
  )

  useEffect(() => {
    void load(0)
  }, [load, refreshToken])

  const newestId = revisions[0]?.revisionId ?? null
  // Version number by revision id (newest-first list ⇒ total − index), so a
  // restore row can name where it was rolled back from.
  const versionByRev = new Map(revisions.map((r, i) => [r.revisionId, total - i]))

  if (!loaded && !error) {
    return (
      <div className={styles.timeline} data-testid="note-history">
        <HistorySkeleton />
      </div>
    )
  }

  return (
    <div className={styles.timeline} data-testid="note-history">
      {/* Count only when there's a list to count — an empty timeline is fully
          said by the "No history yet" placard below, so "0 revisions" over it
          would be the same fact twice. */}
      {revisions.length > 0 && (
        <div className={styles.count}>
          {total} revision{total === 1 ? '' : 's'}
        </div>
      )}
      {error && <div className={styles.error}>{error}</div>}
      {!error && revisions.length === 0 && (
        <EmptyState
          variant="bare"
          icon={<IconHistory size={18} />}
          title="No history yet"
          hint="It starts with the next edit — every save is kept here."
          testId="history-empty"
        />
      )}
      {revisions.map((r, i) => {
        // A restore names its source when that revision is in the loaded window
        // ("Restored from v3"); out of window it stays a plain "Restored".
        const sourceVersion = r.sourceRevisionId ? versionByRev.get(r.sourceRevisionId) : undefined
        const kindLabel =
          r.kind === REVISION_KIND.restore && sourceVersion != null
            ? `Restored from v${sourceVersion}`
            : KIND_LABEL[r.kind]
        return (
          <button
            key={r.revisionId}
            type="button"
            className={cx(styles.item, r.revisionId === selectedId && styles.itemActive)}
            onClick={() =>
              onSelect(
                r.revisionId === selectedId
                  ? null
                  : { revision: r, isLatest: r.revisionId === newestId },
              )
            }
            data-testid="history-item"
            data-kind={r.kind}
          >
            {/* Left: the version name. Auto-numbered v1..vN (v1 = oldest); the
              array is newest-first and contiguous from the top, so index i is
              the offset from newest and total − i is stable per revision as
              older pages load. `r.name` overrides it once rename ships. */}
            <span className={styles.version}>
              {r.name ?? `v${total - i}`}
              <span className={cx(styles.kind, styles[`kind-${r.kind}`])}>{kindLabel}</span>
            </span>
            {/* Right: who made the change, and how big it was. */}
            <span className={styles.itemWho}>
              {authorLabel(r.author).text}
              {r.contentHash == null && r.kind !== REVISION_KIND.delete && ' · body unknown'}
            </span>
            <span className={styles.itemWhen} title={exactDateTime(r.createdAt)}>
              {timeAgo(r.createdAt)}
            </span>
            {/* Char counters beat the (almost always identical) title; legacy
              rows without stats fall back to the title. */}
            {r.charsAdded != null || r.charsRemoved != null ? (
              <span className={styles.itemStats}>
                {!!r.charsAdded && <span className={styles.added}>+{r.charsAdded}</span>}
                {!!r.charsRemoved && <span className={styles.removed}>−{r.charsRemoved}</span>}
                {!r.charsAdded && !r.charsRemoved && <span className={styles.noChange}>±0</span>}
              </span>
            ) : (
              <span className={styles.itemTitle}>{r.title}</span>
            )}
          </button>
        )
      })}
      {revisions.length < total && (
        <Button
          variant="ghost"
          onClick={() => void load(revisions.length)}
          data-testid="history-load-more"
        >
          Show older ({total - revisions.length})
        </Button>
      )}
    </div>
  )
}
