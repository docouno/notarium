import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { INDEXING_STATE } from '@notarium/contract/enums'
import { SCAN_PHASE } from '@notarium/core'
import { IconSync } from '../../core/Icons'
import { cx } from '../../libs/cx/cx'
import { useDismiss } from '../../libs/hooks/useDismiss'
import type { SyncStatus } from '../../libs/wire'
import styles from './SyncIndicator.module.scss'

// Sync status (#60), living on the profile row (#28): the helpers that map the
// read-model status into one user-facing state, the square status button beside
// the user name, and its detail card. Folds BOTH sync legs into one state — our
// scan (engine → read-model snapshot) and the engine's own files→index activity
// (delta polls bringing changes = busy).

export type SyncState = 'connecting' | 'error' | 'scanning' | 'busy' | 'embedding' | 'ok'

export const syncStateOf = (status: SyncStatus | null): SyncState => {
  if (!status) {
    return 'connecting'
  }
  const phase = status.scan.phase

  if (phase === SCAN_PHASE.error) {
    return 'error'
  }
  if (phase !== SCAN_PHASE.ready) {
    return 'scanning'
  }
  if (status.engine.indexing === INDEXING_STATE.busy) {
    return 'busy'
  }
  // Content is synced (scan ready, no delta churn) but the semantic index is still
  // catching up (#199): the embed backfill trickles behind live FTS for minutes/
  // hours on a big base. Surface it so the app doesn't look frozen — a distinct,
  // low-key working state under `busy` (a real content sync always wins).
  if ((status.engine.vector?.pending ?? 0) > 0) {
    return 'embedding'
  }

  return 'ok'
}

export const SYNC_LABEL: Record<SyncState, string> = {
  connecting: 'Connecting…',
  // The scan retries itself (cold-start race with the engine) — phrase it as a
  // wait, not a failure.
  error: 'Waiting for engine',
  scanning: 'Indexing…',
  busy: 'Syncing…',
  embedding: 'Building search index…',
  ok: 'Synced',
}

const isWorking = (s: SyncState) =>
  s === 'busy' || s === 'scanning' || s === 'connecting' || s === 'embedding'

/** A staleness dot, scaled to the poll CADENCE rather than the wall clock: the
 *  control stays clean while polls land on time, warns once the engine has
 *  missed a couple of cycles and goes danger once it's been silent for many.
 *  Tying the thresholds to `intervalMs` (not a fixed 1/5 min) keeps the signal
 *  honest at any configured cadence — at the default 60s poll the badge no
 *  longer flickers warn at the tail of every NORMAL cycle (a fixed 1-min
 *  threshold did). Null = no dot: fresh, or polling is off / never ran
 *  (`intervalMs` 0 — a live, uncached engine) where staleness has no meaning. */
type Stale = 'warn' | 'danger'
export const staleDot = (status: SyncStatus | null): Stale | null => {
  const iso = status?.delta.lastPollAt
  const intervalMs = status?.delta.intervalMs ?? 0

  if (!iso || intervalMs <= 0) {
    return null
  }
  const missed = (Date.now() - Date.parse(iso)) / intervalMs

  if (missed > 5) {
    return 'danger'
  }
  if (missed > 2.5) {
    return 'warn'
  }

  return null
}

/** The corner dot on whatever control carries the sync signal — the standalone
 *  sync glyph (no-auth) or the profile avatar (#112). Two jobs, one pixel: a
 *  STALENESS dot (warn/danger) when the engine falls behind its poll cadence, and
 *  — the #199 fix — a solid ACCENT dot while the engine is actively working
 *  (scanning / syncing / building the semantic index), so the avatar visibly
 *  differs from idle instead of looking default (the detail card explains what).
 *  Staleness wins the corner (a problem outranks progress); null only when synced
 *  AND on cadence. Its host must be `position: relative`. */
export const SyncBadge = ({ status }: { status: SyncStatus | null }) => {
  const stale = staleDot(status)

  if (stale) {
    return <span className={cx(styles.badge, styles[stale])} aria-hidden="true" />
  }
  if (isWorking(syncStateOf(status))) {
    return <span className={cx(styles.badge, styles.working)} aria-hidden="true" />
  }

  return null
}

/** The standalone sync glyph in the rail footer — no-auth hosts, where there's
 *  no profile avatar to fold it into (#112). The glyph stays quiet (it only spins
 *  while work is in flight); a corner badge lights up once the engine falls behind
 *  its poll cadence (see staleDot), carrying the at-a-glance signal. Click opens
 *  the detail card. The `data-state` doubles as the readiness gate the e2e/visual
 *  suites poll. */
export const SyncButton = ({
  status,
  changedLastMinute,
}: {
  status: SyncStatus | null
  changedLastMinute: () => number
}) => {
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useDismiss(open, () => setOpen(false), { inside: [btnRef, popRef], viewport: true })
  const state = syncStateOf(status)
  const rect = open && btnRef.current ? btnRef.current.getBoundingClientRect() : null
  return (
    <>
      <button
        ref={btnRef}
        className={cx(styles.syncBtn, open && styles.open)}
        data-testid="sync-indicator"
        data-state={state}
        title={SYNC_LABEL[state]}
        aria-label={`Sync: ${SYNC_LABEL[state]}`}
        onClick={() => setOpen((o) => !o)}
      >
        <IconSync size={17} className={cx(styles.glyph, isWorking(state) && styles.spin)} />
        <SyncBadge status={status} />
      </button>
      {rect &&
        createPortal(
          // Bottom-docked button → the card opens above it, left-aligned.
          <div
            ref={popRef}
            className={cx(styles.popover, 'glass', 'glass-float')}
            style={{ left: rect.left, bottom: window.innerHeight - rect.top + 6 }}
          >
            <SyncDetails status={status} changed={changedLastMinute()} />
          </div>,
          document.body,
        )}
    </>
  )
}

/** Compact "how long ago" for the detail rows. */
const ago = (iso: string | null): string => {
  if (!iso) {
    return '—'
  }
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))

  if (s < 5) {
    return 'just now'
  }
  if (s < 60) {
    return `${s}s ago`
  }
  const m = Math.round(s / 60)

  if (m < 60) {
    return `${m}m ago`
  }

  return `${Math.round(m / 60)}h ago`
}

const engineText = (engine: SyncStatus['engine']): string => {
  const s =
    engine.indexing === INDEXING_STATE.busy
      ? 'indexing'
      : engine.indexing === INDEXING_STATE.idle
        ? 'idle'
        : 'unknown'

  if (engine.indexed == null) {
    return s
  }

  return `${s} · ${engine.indexed}${engine.total != null ? `/${engine.total}` : ''}`
}

/** The honest live search mode + semantic-index backfill progress (#199). Copy
 *  tracks the About page's "Full-text only" / full-text+vector wording. While the
 *  backfill runs, the done/total count is the star — the "sitting frozen?" answer. */
export const searchText = (vector: NonNullable<SyncStatus['engine']['vector']>): string => {
  if (vector.mode === 'fts') {
    return 'Full-text only'
  }
  if (vector.pending > 0) {
    // `total` (the note count) is refreshed on rescan, `pending` (the live embed
    // queue) between polls — so a burst of fresh writes can briefly make pending
    // outrun a stale total. Clamp the denominator to pending so the done count
    // never goes negative; the next poll reconciles total upward.
    const total = Math.max(vector.total, vector.pending)
    return `Indexing ${total - vector.pending}/${total}`
  }

  return 'Full-text + vector'
}

const scanText = (scan: SyncStatus['scan']): string =>
  scan.phase === SCAN_PHASE.ready
    ? 'complete'
    : scan.phase === SCAN_PHASE.error
      ? 'retrying'
      : scan.phase === SCAN_PHASE.cold
        ? 'starting'
        : `${scan.phase}…` // notes / graph — the warm-up phases by name

/** The sync detail card: a state header (coloured dot + label) over a stable
 *  two-column grid of facts (label left, value right, never wrapping mid-phrase).
 *  The card box is the popover; this owns the content + testid. */
export const SyncDetails = ({
  status,
  changed,
}: {
  status: SyncStatus | null
  changed: number
}) => {
  const state = syncStateOf(status)
  // The button's corner badge lights up on staleness; this is where that lit dot
  // is EXPLAINED — the "Last check" row carries the very same scale (one source,
  // `delta.lastPollAt` + `intervalMs`), so a warning/danger badge reads back as a
  // coloured time here rather than an unexplained dot (the #98 item 1 confusion).
  const stale = staleDot(status)
  return (
    <div data-testid="sync-indicator-popover" className={styles.details}>
      <div className={styles.head}>
        <span className={cx(styles.headDot, styles[state])} aria-hidden="true" />
        <span className={styles.headLabel}>{SYNC_LABEL[state]}</span>
      </div>
      {status ? (
        <dl className={styles.grid}>
          {status.counts && (
            <>
              <dt>Notes</dt>
              <dd>{status.counts.notes}</dd>
              <dt>Links</dt>
              <dd>{status.counts.links}</dd>
            </>
          )}
          <dt>Engine</dt>
          <dd>{engineText(status.engine)}</dd>
          {status.engine.vector && (
            <>
              <dt>Search</dt>
              <dd>{searchText(status.engine.vector)}</dd>
            </>
          )}
          {status.scan.phase !== SCAN_PHASE.ready && (
            <>
              <dt>Read model</dt>
              <dd>{scanText(status.scan)}</dd>
            </>
          )}
          <dt>Last check</dt>
          <dd className={stale ? cx(styles.stale, styles[stale]) : undefined}>
            {ago(status.delta.lastPollAt)}
          </dd>
          <dt>Last change</dt>
          <dd>{ago(status.delta.lastChangeAt)}</dd>
          {changed > 0 && (
            <>
              <dt>Recent</dt>
              <dd>+{changed} last min</dd>
            </>
          )}
        </dl>
      ) : (
        <div className={styles.hint}>No status from the server yet.</div>
      )}
      {status?.scan.error && <div className={styles.hint}>{status.scan.error}</div>}
    </div>
  )
}
