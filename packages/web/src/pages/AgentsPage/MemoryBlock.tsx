import type { MemoryCategory } from '@notarium/contract'
import { type MenuItem } from '../../core/ContextMenu'
import { EmptyState } from '../../core/EmptyState'
import { IconBotMessage, IconExternal, IconEye, IconEyeOff } from '../../core/Icons'
import { CardProvenance, ContextCard } from '../../widgets/ContextCard'
import { StatusBadge, TokenMeter } from './ContextMeters'
import { CardListSkeleton } from './ContextSkeletons'
import { formatTokens } from './helpers/format'
import type { LoadState, MemoryItem } from './types'
import styles from './ContextPage.module.scss'

// The constructor's cards (#165 UX r6) use the shared <ContextCard>: a compact
// one-line row (title + caret + ⋮) that expands to reveal its detail. The actions
// (mute/load, unpin, open) live in the ⋮ menu (also a right-click) — one clean
// line per item, no per-card icon column. The list shows directly, no disclosure
// toggle (#208): the tab already scopes the view, so the items are what you came for.

// Memory rows are shown in the SERVER's stable order (#210), NOT re-sorted by load state:
// muting a category must DIM it in place, never teleport it to the bottom (the old
// loaded→trimmed→muted sort made every mute jump the list and lose the reading spot). State
// is read from the badge + the fade, exactly like a trimmed pin — the list never reflows.

/** One agent-memory category. Row: category + weight meter; expands to summary + #12
 *  provenance. Menu: mute/unmute · open note — "Unmute" is the plain reverse of "Mute" on
 *  BOTH axes (mirrors pin/unpin). `axis` only tunes the BADGE: the PROFILE axis badges a
 *  trimmed row (it has an eager budget); the PROJECT axis (recall-on-demand, no budget)
 *  badges only a muted row — the rest are simply visible to the agent. */
export const MemoryRow = ({
  cat,
  state,
  axis,
  scale,
  onOpen,
  onToggle,
  testId,
}: {
  cat: MemoryCategory
  state: LoadState
  axis: 'profile' | 'project'
  scale: number
  onOpen: (id: string) => void
  onToggle: (cat: MemoryCategory) => void
  testId: string
}) => {
  // "Unmute" on BOTH axes — the plain reverse of "Mute", mirroring pin/unpin (#210).
  // (Was "Load into profile" on the profile axis; the pair now reads consistently.)
  // Same shape as a pin/set-item row (#209 UX): "Open note" first, then the state action set
  // off by a divider — one consistent menu order across the whole constructor.
  const menu: MenuItem[] = [
    { label: 'Open note', icon: <IconExternal size={15} />, onClick: () => onOpen(cat.noteId) },
    { divider: true },
    {
      label: cat.muted ? 'Unmute' : 'Mute',
      icon: cat.muted ? <IconEye size={15} /> : <IconEyeOff size={15} />,
      onClick: () => onToggle(cat),
    },
  ]
  // Loaded is the norm (implied by the accent meter) — badge only the exceptions: a
  // muted row (both axes) or a trimmed one (profile only; the project audit has no budget).
  const badge =
    state === 'muted' ? (
      <StatusBadge state="muted" />
    ) : axis === 'profile' && state === 'trimmed' ? (
      <StatusBadge state="trimmed" />
    ) : null
  return (
    <ContextCard
      title={
        <span className={styles.itemTitle}>
          <span className={styles.itemName}>{cat.category}</span>
          <span className={styles.itemBadges}>{badge}</span>
          <TokenMeter tokens={cat.tokens} scale={scale} trimmed={state === 'trimmed'} />
        </span>
      }
      summary={cat.summary}
      details={<CardProvenance author={cat.author} modifiedAt={cat.modifiedAt} />}
      menu={menu}
      muted={cat.muted}
      testId={testId}
    />
  )
}

/** The Memory block of the constructor (#207/#208): an agent-memory axis shown as a
 *  direct list of mutable category rows (no disclosure toggle — the tab already scopes
 *  it). Two variants. PROFILE: the eager personal memory — server-curated loaded/trimmed
 *  against the scope budget, a trimmed/muted caption, Mute = "drop from the eager set".
 *  PROJECT: the about-project audit — recall-on-demand, OFF the eager budget (#207), so
 *  a "N categories · ≈tokens if recalled" caption and per-item meters against the recall
 *  total; Mute = "hide from the agent's recall + vocabulary". `failed` suppresses the
 *  reassuring empty state when the axis didn't load (the page notice already says so). */
export const MemoryBlock = ({
  items,
  variant,
  scale,
  recallTokens = 0,
  failed,
  onOpenNote,
  onToggleMute,
  testIdBase,
}: {
  items: MemoryItem[] | null
  variant: 'profile' | 'project'
  scale: number
  recallTokens?: number
  failed: boolean
  onOpenNote: (id: string) => void
  onToggleMute: (cat: MemoryCategory) => void
  testIdBase: string
}) => {
  const muted = items ? items.filter((i) => i.state === 'muted').length : 0
  const trimmedTokens = items
    ? items.filter((i) => i.state === 'trimmed').reduce((s, i) => s + i.cat.tokens, 0)
    : 0
  const total = items?.length ?? 0
  return (
    <div className={styles.block}>
      <div className={styles.blockHead}>
        <IconBotMessage size={13} />
        <span>Memory</span>
      </div>
      {!items ? (
        <CardListSkeleton rows={3} />
      ) : items.length === 0 ? (
        failed ? null : (
          <EmptyState
            variant="bare"
            icon={<IconBotMessage size={22} />}
            title="No agent-memory yet"
            hint="Agent observations will appear here after they are recorded."
            testId={`${testIdBase}-empty`}
          />
        )
      ) : (
        <>
          {variant === 'project' ? (
            // Recall-on-demand, not eager (#207) — a category count + a token weight for
            // context, never a budget the server doesn't enforce.
            <p className={styles.blockCaption} data-testid={`${testIdBase}-caption`}>
              <strong>{total}</strong> {total === 1 ? 'category' : 'categories'} · ≈
              {formatTokens(recallTokens)} tokens if recalled
              {muted > 0 && <> · {muted} muted, hidden from the agent</>}
            </p>
          ) : (
            (trimmedTokens > 0 || muted > 0) && (
              <p className={styles.blockCaption} data-testid={`${testIdBase}-caption`}>
                {trimmedTokens > 0 && (
                  <span className={styles.trimmedText}>≈{formatTokens(trimmedTokens)} trimmed</span>
                )}
                {trimmedTokens > 0 && muted > 0 && ' · '}
                {muted > 0 && <>{muted} muted</>}
              </p>
            )
          )}
          <div className={styles.list} data-testid={`${testIdBase}-details`}>
            {items.map(({ cat, state }) => (
              <MemoryRow
                key={cat.noteId}
                cat={cat}
                state={state}
                axis={variant}
                scale={scale}
                onOpen={onOpenNote}
                onToggle={onToggleMute}
                testId={`${testIdBase}-row`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
