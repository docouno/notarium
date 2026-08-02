import { cx } from '../../libs/cx/cx'
import { formatTokens } from './helpers/format'
import type { LoadState, ScopeCard, ScopeKey } from './types'
import styles from './ContextPage.module.scss'

export const StatusBadge = ({ state }: { state: Exclude<LoadState, 'loaded'> }) => {
  const label = state === 'trimmed' ? 'Trimmed' : 'Muted'
  const stateClass = state === 'trimmed' ? styles.statusTrimmed : styles.statusMuted
  return <span className={cx(styles.statusBadge, stateClass)}>{label}</span>
}

/** The per-note "how much it eats" meter (#208): a thin bar whose fill is this note's
 *  token weight as a fraction of the scope's BUDGET (not of the fattest sibling) — so a
 *  note that's a rounding error against the real budget reads as a sliver, and only a
 *  genuinely heavy note fills the bar. That's the honest "spot the fat one to trim"
 *  signal. Danger fill = the note was trimmed (over budget); the number gives the
 *  absolute weight. Renders as the two RIGHTMOST cells of the row grid (`.itemTitle`) —
 *  a fixed-width bar column that lines up across every row, then a fixed number column
 *  (right-aligned so varying digit widths never shift the bar). */
export const TokenMeter = ({
  tokens,
  scale,
  trimmed = false,
}: {
  tokens: number
  scale: number
  trimmed?: boolean
}) => {
  const pct = scale > 0 ? Math.min(100, (tokens / scale) * 100) : 0
  return (
    <>
      <span className={styles.meterTrack} title={`≈${tokens} tokens`} aria-hidden="true">
        <span
          className={cx(styles.meterFill, trimmed && styles.meterFillTrimmed)}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={styles.meterValue}>≈{formatTokens(tokens)}</span>
    </>
  )
}

/** The ONE aggregate context-load scale (#208) with a clickable tab per scope. The bar
 *  spans the scope's SINGLE budget and draws one band per scope (the current PROJECT,
 *  then the embedded PERSONAL — or Personal alone), the ACTIVE band lit and the rest
 *  accent, then the unused headroom. Because the budget is one envelope, loaded ≤ budget
 *  always: the bar is strictly the budget with headroom, never a "gray gap then red"
 *  (the trimmed weight lives on the items). The legend doubles as the scope tabs:
 *  clicking one selects it (lights its band, swaps the panels below) — so Personal is
 *  inspectable from a project without a second stacked panel. */
export const AggregateBar = ({
  scopes,
  totalLoaded,
  budgetTokens,
  activeScope,
  onSelect,
  testId,
}: {
  scopes: ScopeCard[]
  totalLoaded: number
  budgetTokens: number
  activeScope: ScopeKey
  onSelect: (scope: ScopeKey) => void
  testId: string
}) => {
  const scale = Math.max(budgetTokens, 1)
  const headroom = Math.max(0, budgetTokens - totalLoaded)
  const pct = (t: number) => `${(t / scale) * 100}%`
  return (
    <div className={styles.aggregate} data-testid={testId}>
      <div className={styles.aggregateHead}>
        <span className={styles.aggregateTitle}>Context load</span>
        <span className={styles.aggregateValue}>
          <strong>≈{formatTokens(totalLoaded)}</strong> / {formatTokens(budgetTokens)} tokens
        </span>
      </div>
      <span className={styles.tokenBar} role="img" aria-hidden="true">
        {scopes
          .filter((s) => s.loaded > 0)
          .map((s) => (
            <span
              key={s.key}
              className={cx(
                styles.tokenSeg,
                s.key === activeScope ? styles.segActive : styles.segIdle,
              )}
              style={{ width: pct(s.loaded) }}
              title={`${s.label} · ${s.loaded} tokens`}
            />
          ))}
        {headroom > 0 && <span className={styles.tokenSegEmpty} style={{ width: pct(headroom) }} />}
      </span>
      <div className={styles.tabs} role="tablist" aria-label="Context scopes">
        {scopes.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={s.key === activeScope}
            className={cx(styles.tab, s.key === activeScope && styles.tabActive)}
            onClick={() => onSelect(s.key)}
            data-testid={`${testId}-${s.key}`}
          >
            <span
              className={cx(
                styles.tabDot,
                s.key === activeScope ? styles.segActive : styles.segIdle,
              )}
            />
            <span className={styles.tabLabel}>{s.label}</span>
            <span className={styles.tabValue}>≈{formatTokens(s.loaded)}</span>
            {s.trimmed > 0 && <span className={styles.tabTrimmed}>−{formatTokens(s.trimmed)}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
