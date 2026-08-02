// The revision view (#12) — the main-area half of the VSCode-style pair: shows
// the revision the timeline (HistoryTimeline, in the aside) selected. A banner
// names what you're looking at and carries the ways out (restore, back to the
// note); below it the word-level diff against the revision's chain parent
// (baseRevisionId — windowing must not change what a revision is compared
// against) or the rendered content.

import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import { REVISION_KIND } from '@notarium/contract/enums'
import { Button } from '../../core/Button'
import { useDialog } from '../../core/Dialog'
import { Segmented } from '../../core/Segmented'
import { SkeletonText } from '../../core/Skeleton'
import { StickyBar } from '../../core/StickyBar'
import { cx } from '../../libs/cx/cx'
import { exactDateTime } from '../../libs/datetime'
import { renderMarkdown } from '../../libs/markdown/markdown'
import { useMarkdownEnhance } from '../../libs/markdown/useMarkdownEnhance'
import type {
  NoteHistorySource,
  RevisionView as Revision,
  RevisionDetailView,
} from '../../libs/revisions'
import { buildDiffRows } from './helpers'
import styles from './RevisionView.module.scss'

type RevisionViewProps = {
  source: NoteHistorySource
  revision: Revision
  /** The newest journaled state — already the current note, nothing to restore. */
  isLatest: boolean
  /** Whether the viewer may roll back (space:write). Default true; a reader (#111)
   *  passes false so the timeline stays viewable but offers no restore. */
  restorable?: boolean
  /** Back to the current version (the reader). */
  onBack: () => void
  /** The note was rolled back — the host reloads the reader and closes this view. */
  onRestored: () => void
}

// While a revision body (or its diff base) is being fetched: paragraph-shaped
// shimmer in the body column, instead of a "Loading…" line (#68 item 5).
const RevisionSkeleton = () => (
  <div
    className={cx(styles.rendered, styles.skeletonBody)}
    aria-hidden="true"
    data-testid="revision-skeleton"
  >
    <SkeletonText lines={4} lastWidth="52%" />
    <SkeletonText lines={6} lastWidth="38%" />
    <SkeletonText lines={3} lastWidth="60%" />
  </div>
)

export const RevisionView = ({
  source,
  revision,
  isLatest,
  restorable = true,
  onBack,
  onRestored,
}: RevisionViewProps) => {
  const { confirm, alert } = useDialog()
  const [view, setView] = useState<'diff' | 'content'>('diff')
  const [restoring, setRestoring] = useState(false)
  // Revision bodies by revision id. Content-addressed upstream; immutable —
  // an entry never goes stale, so the cache lives as long as the view.
  const detailsRef = useRef(new Map<string, RevisionDetailView>())
  const [detailsTick, setDetailsTick] = useState(0)

  const baseId = revision.baseRevisionId

  useEffect(() => {
    const want = [revision.revisionId, baseId].filter(
      (id): id is string => !!id && !detailsRef.current.has(id),
    )
    let dead = false

    for (const id of want) {
      void source
        .detail(id)
        .then((d) => {
          detailsRef.current.set(id, d)
          if (!dead) {
            setDetailsTick((n) => n + 1)
          }
        })
        .catch(() => {
          // A vanished revision (refetch raced a reset) just renders empty.
        })
    }

    return () => {
      dead = true
    }
  }, [source, revision.revisionId, baseId, detailsTick])

  const detail = detailsRef.current.get(revision.revisionId)
  const baseDetail = baseId ? detailsRef.current.get(baseId) : undefined

  const diffRows = useMemo(() => {
    if (!detail || detail.content == null) {
      return null
    }
    if (baseId && baseDetail?.content == null) {
      return null
    } // base is a gap/loading

    return buildDiffRows(baseId ? (baseDetail?.content ?? '') : '', detail.content)
  }, [detail, baseDetail, baseId])

  // Rendered content of the revision + post-render enhancements (#235: copy buttons
  // on code blocks, table scroll fades). The hook only wires up while the 'content'
  // tab is showing (the ref exists), so we gate its dep on `view` — switching tabs
  // doesn't change the html itself.
  const contentRef = useRef<HTMLDivElement>(null)
  const contentHtml = useMemo(() => (detail ? renderMarkdown(detail.content ?? '') : ''), [detail])
  useMarkdownEnhance(contentRef, view === 'content' ? contentHtml : '')

  const canRestore = restorable && revision.contentHash != null && !isLatest && !restoring

  const restore = async () => {
    const ok = await confirm({
      title: 'Restore this version?',
      message: `The note will be set back to its state from ${exactDateTime(revision.createdAt)}. The current state stays in the history.`,
      confirmLabel: 'Restore',
    })

    if (!ok) {
      return
    }
    setRestoring(true)
    try {
      await source.restore(revision.revisionId)
      onRestored()
    } catch (e) {
      const err = e as Error & { reason?: string }
      await alert({
        title: 'Restore failed',
        message:
          err.reason === 'version_conflict'
            ? 'The note changed while you were looking at its history. Review the latest state and try again.'
            : err.message,
        danger: true,
      })
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className={styles.view} data-testid="revision-view">
      <StickyBar className={styles.banner} data-testid="revision-banner">
        {/* No caption — which revision you're on (kind, date, who) is shown by
            the highlighted row in the timeline aside; repeating it here was just
            noise. The bar carries only the view switch and the actions. */}
        <div className={styles.bannerControls}>
          <Segmented
            className={styles.bannerSeg}
            value={view}
            onChange={setView}
            ariaLabel="Revision view"
            options={[
              { value: 'diff', label: 'Changes' },
              { value: 'content', label: 'Content' },
            ]}
          />
          <div className={styles.bannerActions}>
            {/* The latest revision is already the live note — nothing to restore,
                so we say so instead of offering a dead button. A reader (#111,
                !restorable) gets no restore button at all — just the timeline. */}
            {isLatest ? (
              <span className={styles.currentNote} data-testid="history-current">
                This is the current version
              </span>
            ) : restorable ? (
              <Button
                variant="warning"
                onClick={() => void restore()}
                disabled={!canRestore}
                title={
                  revision.contentHash == null
                    ? 'The journal has no body for this state'
                    : undefined
                }
                data-testid="history-restore"
              >
                {restoring ? 'Restoring…' : 'Restore this version'}
              </Button>
            ) : null}
            <Button variant="primary" onClick={onBack} data-testid="history-back">
              Back to note
            </Button>
          </div>
        </div>
      </StickyBar>

      {revision.contentHash == null ? (
        <div className={styles.gap} data-testid="history-gap">
          {revision.kind === REVISION_KIND.delete
            ? 'The note was deleted at this point.'
            : 'An external change was detected here, but its content could not be captured.'}
        </div>
      ) : view === 'diff' ? (
        <div
          className={styles.diff}
          data-testid="history-diff"
          style={
            { '--diff-gutter': `${String(diffRows?.length ?? 1).length + 1}ch` } as CSSProperties
          }
        >
          {diffRows ? (
            diffRows.map((row) => (
              <div
                key={row.num}
                className={cx(styles.line, row.changed && styles.lineChanged)}
                data-changed={row.changed || undefined}
              >
                <span className={styles.gutter} aria-hidden>
                  {row.num}
                </span>
                <span className={styles.lineText}>
                  {row.segments.length === 0
                    ? '​' /* keep blank lines tall */
                    : row.segments.map((s, j) =>
                        s.kind === 'add' ? (
                          <ins key={j}>{s.value}</ins>
                        ) : s.kind === 'del' ? (
                          // Render a removed line break as a glyph so the row
                          // stays one visual line (its number stays true).
                          <del key={j}>{s.value.replace(/\n/g, '↵')}</del>
                        ) : (
                          <span key={j}>{s.value}</span>
                        ),
                      )}
                </span>
              </div>
            ))
          ) : (
            <RevisionSkeleton />
          )}
        </div>
      ) : detail ? (
        <div
          ref={contentRef}
          className={cx('markdown', styles.rendered)}
          data-testid="history-content"
          dangerouslySetInnerHTML={{ __html: contentHtml }}
        />
      ) : (
        <RevisionSkeleton />
      )}
    </div>
  )
}
