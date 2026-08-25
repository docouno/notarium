// The revision view (#12) — the main-area half of the VSCode-style pair: shows
// the revision the timeline (HistoryTimeline, in the aside) selected. A banner
// names what you're looking at and carries the ways out (restore, back to the
// note); below it the word-level diff against the revision's chain parent
// (baseRevisionId — windowing must not change what a revision is compared
// against) or the rendered content.

import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import { REVISION_KIND } from '@notarium/contract/enums'
import { STORE_ERROR_REASON } from '@notarium/core'
import { Button } from '../../core/Button'
import { useDialog } from '../../core/Dialog'
import { Segmented } from '../../core/Segmented'
import { SkeletonText } from '../../core/Skeleton'
import { StickyBar } from '../../core/StickyBar'
import { cx } from '../../libs/cx/cx'
import { exactDateTime } from '../../libs/datetime'
import { renderMarkdown } from '../../libs/markdown/markdown'
import { useMarkdownEnhance } from '../../libs/markdown/useMarkdownEnhance'
import {
  type NoteHistorySource,
  recoveryPresentation,
  type RevisionView as Revision,
  type RevisionDetailView,
} from '../../libs/revisions'
import { buildDiffRows, canRestoreRevision } from './helpers'
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

/** The one refusal that means "the copy is here and this server cannot open it" — the row
 *  itself looks restorable, so nothing else on this screen can tell. */
const UNREADABLE_REASON = STORE_ERROR_REASON.revisionContentUnreadable

const isPartialState = (
  revision: Pick<Revision, 'contentHash' | 'stateFormat'> | undefined,
): boolean =>
  revision != null &&
  revision.contentHash != null &&
  (revision.stateFormat == null || revision.stateFormat === 'markdown-v1')

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
  // Revisions whose blob is stored and which this server cannot open — see
  // `canRestoreRevision` for why only this screen can know.
  // canon: docs/trash.md#availability
  const unreadableRef = useRef(new Set<string>())
  // Ids this view has already asked for. A body is content-addressed and immutable, so one
  // request per id is the whole contract — and without tracking the ATTEMPT, a refusal
  // (which never lands in `detailsRef`) puts its own tick back through this effect.
  const attemptedRef = useRef(new Set<string>())
  const [detailsTick, setDetailsTick] = useState(0)

  const baseId = revision.baseRevisionId

  useEffect(() => {
    const want = [revision.revisionId, baseId].filter(
      (id): id is string => !!id && !attemptedRef.current.has(id),
    )
    let dead = false

    for (const id of want) {
      attemptedRef.current.add(id)
    }

    for (const id of want) {
      void source
        .detail(id)
        .then((d) => {
          detailsRef.current.set(id, d)
          if (!dead) {
            setDetailsTick((n) => n + 1)
          }
        })
        .catch((e: unknown) => {
          // A vanished revision (refetch raced a reset) just renders empty; an unreadable
          // one is a durable fact about this server and has to reach the button.
          if ((e as { reason?: string } | null)?.reason === UNREADABLE_REASON) {
            unreadableRef.current.add(id)
            if (!dead) {
              setDetailsTick((n) => n + 1)
            }
          }
        })
    }

    return () => {
      dead = true
    }
  }, [source, revision.revisionId, baseId, detailsTick])

  const detail = detailsRef.current.get(revision.revisionId)
  const baseDetail = baseId ? detailsRef.current.get(baseId) : undefined
  const baseUnreadable = Boolean(baseId && unreadableRef.current.has(baseId))
  // An unreadable parent is loaded — the answer is just "this server cannot open it".
  // Treating it as still-loading left the diff shimmering with nothing on screen.
  const baseLoaded = !baseId || detailsRef.current.has(baseId) || baseUnreadable
  const activeView = detail?.contentMode === 'source' ? 'content' : view
  const comparisonIsGap = Boolean(baseId && baseLoaded && baseDetail?.contentMode === 'gap')
  const comparisonIsUnreadable = baseUnreadable
  const comparisonIsSource = Boolean(baseId && baseLoaded && baseDetail?.contentMode === 'source')

  const diffRows = useMemo(() => {
    if (!detail || detail.contentMode !== 'markdown') {
      return null
    }
    if (baseId && baseDetail?.contentMode !== 'markdown') {
      return null
    }

    const completeComparison = detail.snapshot != null && (!baseId || baseDetail?.snapshot != null)
    const before = completeComparison
      ? baseId
        ? (baseDetail?.snapshot ?? '')
        : ''
      : baseId
        ? (baseDetail?.content ?? '')
        : ''
    const after = completeComparison ? (detail.snapshot ?? '') : detail.content

    return buildDiffRows(before, after)
  }, [detail, baseDetail, baseId])

  // Rendered content of the revision + post-render enhancements (#235: copy buttons
  // on code blocks, table scroll fades). The hook only wires up while the 'content'
  // tab is showing (the ref exists), so we gate its dep on `view` — switching tabs
  // doesn't change the html itself.
  const contentRef = useRef<HTMLDivElement>(null)
  const contentHtml = useMemo(
    () => (detail?.contentMode === 'markdown' ? renderMarkdown(detail.content) : ''),
    [detail],
  )
  useMarkdownEnhance(contentRef, activeView === 'content' ? contentHtml : '')

  const detailUnreadable = unreadableRef.current.has(revision.revisionId)
  const canRestore = canRestoreRevision({
    revision,
    restorable,
    detailUnreadable,
    isLatest,
    restoring,
  })
  // Intrinsic state completeness and host restore capability are independent.
  // A none/fake host maps an otherwise restorable legacy row to
  // capability-unavailable, but it must remain visibly partial.
  const selectedIsPartial = isPartialState(revision)
  const comparisonIsPartial =
    !selectedIsPartial &&
    revision.contentHash != null &&
    baseId != null &&
    isPartialState(baseDetail)
  const selectedUnavailable =
    revision.restoreAvailability !== 'full' && revision.restoreAvailability !== 'partial'

  const restore = async () => {
    const ok = await confirm({
      title: 'Restore this version?',
      message: selectedIsPartial
        ? `This is a legacy partial snapshot from ${exactDateTime(revision.createdAt)}. Its body and captured fixed fields will be restored; other current frontmatter will stay unchanged. The current state stays in the history.`
        : `The note will be set back to its complete state from ${exactDateTime(revision.createdAt)}. The current state stays in the history.`,
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
          err.reason === 'version-conflict'
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
            value={activeView}
            onChange={setView}
            ariaLabel="Revision view"
            options={
              detail?.contentMode === 'source'
                ? [{ value: 'content', label: 'Content' }]
                : [
                    { value: 'diff', label: 'Changes' },
                    { value: 'content', label: 'Content' },
                  ]
            }
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
                    : selectedUnavailable
                      ? `This state is ${revision.restoreAvailability} and cannot be restored safely`
                      : selectedIsPartial
                        ? 'Legacy partial snapshot: unknown frontmatter stays current'
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

      {selectedIsPartial || comparisonIsPartial ? (
        <div className={styles.partial} data-testid="history-partial">
          {selectedIsPartial
            ? 'Legacy partial snapshot: this version contains the body and fixed fields only. Restoring it keeps other current frontmatter unchanged.'
            : 'This change is compared with a legacy partial snapshot, so Changes can compare note bodies only.'}
        </div>
      ) : null}

      {comparisonIsGap ? (
        <div className={styles.gap} data-testid="history-comparison-gap">
          Changes cannot be compared because the parent revision content was not captured.
        </div>
      ) : null}

      {comparisonIsSource ? (
        <div className={styles.gap} data-testid="history-comparison-source">
          Changes cannot be compared because the parent revision is opaque source data.
        </div>
      ) : null}

      {detailUnreadable ? (
        <div className={styles.partial} data-testid="history-unreadable">
          {recoveryPresentation('unreadable').reason}
        </div>
      ) : null}

      {comparisonIsUnreadable ? (
        <div className={styles.gap} data-testid="history-comparison-unreadable">
          Changes cannot be compared because this server can no longer read the parent
          revision&rsquo;s saved copy.
        </div>
      ) : null}

      {selectedUnavailable && !detailUnreadable && revision.contentHash != null ? (
        <div className={styles.partial} data-testid="history-unavailable">
          {revision.restoreAvailability === 'opaque'
            ? 'This revision is opaque source data. It can be inspected as plain source but not rendered or restored.'
            : revision.restoreAvailability === 'blocked'
              ? 'Restore is blocked because authored YAML depends on a runtime-owned field.'
              : revision.restoreAvailability === 'capability-unavailable'
                ? 'This server cannot provide crash-safe single-note restore.'
                : 'Restore safety could not be proven for this revision.'}
        </div>
      ) : null}

      {revision.contentHash == null ? (
        <div className={styles.gap} data-testid="history-gap">
          {revision.unavailableReason != null
            ? // WITHHELD, not uncaptured (#327): the server refused to attribute or
              // reconstruct this state, so naming a cause it didn't claim would be
              // the same invention as calling its writer external.
              'This point is unavailable: the note’s identity was in doubt here, so nothing about the change can be shown.'
            : revision.kind === REVISION_KIND.delete
              ? 'The note was deleted at this point.'
              : 'An external change was detected here, but its content could not be captured.'}
        </div>
      ) : detail?.contentMode === 'source' && activeView === 'content' ? (
        <pre className={styles.source} data-testid="history-source">
          {detail.source?.encoding === 'base64'
            ? `base64\n${detail.source.data}`
            : detail.source?.data}
        </pre>
      ) : activeView === 'diff' ? (
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
          ) : comparisonIsGap || comparisonIsSource || detail?.contentMode === 'source' ? null : (
            <RevisionSkeleton />
          )}
        </div>
      ) : detail?.contentMode === 'markdown' ? (
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
