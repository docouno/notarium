import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { AgentAuditAggregates, AgentRetrievalEvent } from '@notarium/contract'
import { AGENT_RETRIEVAL_TOOL } from '@notarium/contract/enums'
import { EmptyState } from '../../core/EmptyState'
import { IconCrosshair, IconHistory, IconSearch } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { Segmented } from '../../core/Segmented'
import { SettingsLayout } from '../../layouts/SettingsLayout'
import { cx } from '../../libs/cx/cx'
import { api } from '../../services/api'
import { RECURRING_MISS_MIN, useAgentsSummary } from './AgentsProvider'
import { AgentsTabs } from './AgentsTabs'
import { AuditRow, QueryStatRow, TOOL_META } from './AuditRows'
import { ListSkeleton, PanelsSkeleton, SkeletonRow } from './AuditSkeletons'
import { PAGE_SIZE } from './consts'
import type { ToolFilter } from './types'
import styles from './AuditPage.module.scss'

// The Agents → Audit surface (#243 [MEM-AUDIT][A]): the runtime twin of the context
// constructor. Shows what the agent reached for ON DEMAND (search/recall/get_note) and
// whether it found anything. A single empty result is normal retrieval; the signal is a
// query that RECURS empty (a "blind spot") — a hint, not a verdict. Self-scoped.
//
// Scale: the history is server-paginated (first-page offset, follow-up keyset cursor) and
// loaded incrementally as you scroll (an IntersectionObserver sentinel), so a log of
// thousands never loads or renders at once — no silent cap, memory bounded per page.
// The aggregate panels are
// whole-history (computed server-side), so they stay correct however little you scroll.

export const AuditPage = () => {
  const { updateAudit } = useAgentsSummary()
  const [filter, setFilter] = useState<ToolFilter>('all')
  const [events, setEvents] = useState<AgentRetrievalEvent[]>([])
  const [total, setTotal] = useState(0)
  const [aggregates, setAggregates] = useState<AgentAuditAggregates | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<{ beforeAt: string; beforeId: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const requestSeq = useRef(0)
  // Once we hold the whole-history aggregates, a filter switch reuses them (they're
  // tool-independent) — so it tells the server to SKIP the re-scan (a first load still gets them).
  const aggregatesLoaded = useRef(false)
  // Whether the Agents Audit pill has been fed at least once. On /agents/audit the chrome skips
  // the audit fetch, so ONLY a whole-'all' response here feeds the pill (updateAudit) — an 'all'
  // reset must keep fetching aggregates until that happens, even if a non-'all' page already set
  // aggregatesLoaded (else the pill could stay blank while the panels show real data).
  const auditFed = useRef(false)

  // Load one page. `reset` replaces the list (first load / filter change); otherwise the
  // page is appended (scroll). Appended pages use the last rendered row as a keyset cursor,
  // so live retrievals inserted above the list cannot shift page 2. A request sequence drops
  // stale responses when the user flips filters mid-flight.
  //
  // The aggregate panels are whole-history (tool-independent) and the server sends them on the
  // FIRST page only (null on appends) — so we KEEP the loaded panels across a filter switch AND
  // across appended pages; only the list clears and shows its skeleton, so flipping a filter
  // never blanks the panels or the filter control. `total`, by contrast, is per-filter (a
  // tool-scoped count) — kept only to avoid a flicker and hidden while the list (re)loads (it's
  // the PREVIOUS filter's count until the new page lands).
  const loadPage = useCallback(
    async (
      f: ToolFilter,
      cursor: { beforeAt: string; beforeId: string } | null,
      reset: boolean,
    ) => {
      const requestId = ++requestSeq.current

      if (reset) {
        setEvents([])
        setHasMore(false)
        setNextCursor(null)
        setLoading(true)
      } else {
        setLoadingMore(true)
      }
      setFailed(false)
      try {
        const res = await api.agentAuditGet({
          tool: f === 'all' ? undefined : f,
          limit: PAGE_SIZE,
          beforeAt: cursor?.beforeAt,
          beforeId: cursor?.beforeId,
          // A filter switch (reset) reuses the aggregates we already hold — skip the server scan.
          // But an 'all' reset must still fetch them until the pill has been fed (see auditFed).
          skipAggregates: reset && aggregatesLoaded.current && (f !== 'all' || auditFed.current),
        })

        if (requestId !== requestSeq.current) {
          return
        }
        setTotal(res.total)
        // Aggregates arrive on a genuine first load only (null on appends AND filter switches) —
        // keep the loaded panels, and feed the Agents pill only from the whole-'all' first page.
        if (res.aggregates) {
          aggregatesLoaded.current = true
          setAggregates(res.aggregates)
          if (f === 'all') {
            updateAudit(res)
            auditFed.current = true
          }
        }
        setHasMore(res.hasMore)
        setNextCursor(res.nextCursor)
        setEvents((prev) => (reset ? res.events : [...prev, ...res.events]))
      } catch {
        if (requestId !== requestSeq.current) {
          return
        }
        setFailed(true)
      } finally {
        if (requestId === requestSeq.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [updateAudit],
  )

  useEffect(() => {
    void loadPage(filter, null, true)
  }, [filter, loadPage])

  // Infinite scroll: when the sentinel below the list scrolls into view, pull the next
  // page. Re-created as the list grows so it always sees fresh counts; the guards keep it
  // from double-firing or running past the end.
  useEffect(() => {
    const el = sentinelRef.current

    if (!el || !hasMore || loading || loadingMore) {
      return undefined
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && nextCursor) {
          void loadPage(filter, nextCursor, false)
        }
      },
      { rootMargin: '240px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loading, loadingMore, nextCursor, filter, loadPage])

  const hasAggregates = !!aggregates && aggregates.totalQueries > 0
  // A blind spot RECURS empty — a one-off zero result is normal retrieval, not a gap.
  const blindSpots = (aggregates?.misses ?? []).filter((m) => m.misses >= RECURRING_MISS_MIN)
  // Genuinely empty (settled, no aggregates, no rows) — the big empty state. Distinct from
  // "still loading" (skeleton), "this filter is empty" (the bare per-filter empty), AND a load
  // failure (the error notice already tells the truth — never say "no activity" over a failure).
  const showEmptyPage = !loading && !failed && !hasAggregates && events.length === 0
  // The list has no rows to show and is fetching them (first load OR a filter switch).
  const listLoading = loading && events.length === 0

  const toolOptions: Array<{ value: ToolFilter; label: string; icon?: ReactNode }> = [
    { value: 'all', label: 'All' },
    { value: AGENT_RETRIEVAL_TOOL.search, label: 'Search', icon: TOOL_META.search.icon },
    { value: AGENT_RETRIEVAL_TOOL.recall, label: 'Recall', icon: TOOL_META.recall.icon },
    { value: AGENT_RETRIEVAL_TOOL.getNote, label: 'Open', icon: TOOL_META.get_note.icon },
  ]

  return (
    <SettingsLayout
      trail={[{ label: 'Agents' }, { label: 'Audit' }]}
      spaceLess
      sectionTabs={<AgentsTabs active="audit" />}
      testIdPrefix="audit"
    >
      <div className={styles.page} data-testid="agents-audit">
        <div className={styles.inner}>
          <header className={styles.head}>
            <h1 className={styles.title}>Retrieval audit</h1>
            <p className={styles.sub}>
              What your agents searched for at runtime — and whether they found it. The constructor
              governs what loads eagerly; this is the on-demand twin. A query that keeps coming back
              empty is a blind spot worth a look.
            </p>
          </header>

          {failed && (
            <Notice variant="error" data-testid="audit-error">
              Couldn’t load the retrieval audit.
            </Notice>
          )}

          {showEmptyPage ? (
            <EmptyState
              icon={<IconHistory size={22} />}
              title="No retrieval activity yet"
              hint="Once an agent searches or recalls from your memory, its queries — and what came back — show up here."
            />
          ) : (
            <>
              {/* Aggregates are whole-history — real once known, a matching skeleton on the
                  very first load, and NOTHING once we know there are none (settled, no data). */}
              {hasAggregates ? (
                (blindSpots.length > 0 || aggregates.top.length > 0) && (
                  <div className={styles.panels}>
                    {blindSpots.length > 0 && (
                      <section
                        className={cx(styles.panel, styles.panelWarn)}
                        data-testid="audit-blindspots"
                      >
                        <div className={styles.panelHead}>
                          <IconCrosshair size={13} />
                          <span>Blind spots</span>
                          <span className={styles.panelHint}>keep coming back empty</span>
                        </div>
                        <ul className={styles.statList}>
                          {blindSpots.map((s) => (
                            <QueryStatRow key={`${s.tool}-${s.query}`} stat={s} warn />
                          ))}
                        </ul>
                      </section>
                    )}
                    {aggregates.top.length > 0 && (
                      <section className={styles.panel} data-testid="audit-frequent">
                        <div className={styles.panelHead}>
                          <IconSearch size={13} />
                          <span>Frequent</span>
                          <span className={styles.panelHint}>most-run queries</span>
                        </div>
                        <ul className={styles.statList}>
                          {aggregates.top.map((s) => (
                            <QueryStatRow key={`${s.tool}-${s.query}`} stat={s} />
                          ))}
                        </ul>
                      </section>
                    )}
                  </div>
                )
              ) : loading ? (
                <PanelsSkeleton />
              ) : null}

              {/* The filter is static (no data) — always live, so flipping it never blanks. */}
              <div className={styles.controls}>
                <Segmented<ToolFilter>
                  value={filter}
                  onChange={setFilter}
                  ariaLabel="Filter by tool"
                  className={styles.toolFilter}
                  options={toolOptions}
                />
                {/* Hidden while the list (re)loads OR after a failure — the kept `total` is the
                    PREVIOUS filter's count; showing it would be a wrong number, not just stale. */}
                {total > 0 && !listLoading && !failed && (
                  <span className={styles.total}>
                    {hasMore ? `${events.length} of ${total}` : total} call{total === 1 ? '' : 's'}
                  </span>
                )}
              </div>

              {listLoading ? (
                <ListSkeleton />
              ) : events.length > 0 ? (
                <>
                  <ul className={styles.list} data-testid="audit-list">
                    {events.map((e) => (
                      <AuditRow key={e.id} event={e} />
                    ))}
                  </ul>
                  {/* Infinite-scroll sentinel + more-loading placeholder (one row, matched). */}
                  {hasMore && (
                    <div ref={sentinelRef} className={styles.more} data-testid="audit-more">
                      <SkeletonRow />
                    </div>
                  )}
                </>
              ) : failed ? null : (
                // Only when the list SETTLED empty (not on a failure — the error Notice already
                // speaks; never assert "no activity" over an error).
                <EmptyState
                  variant="bare"
                  icon={<IconCrosshair size={20} />}
                  title={
                    filter === 'all'
                      ? 'No retrieval activity yet'
                      : `No ${TOOL_META[filter].label.toLowerCase()} calls`
                  }
                  hint={
                    filter === 'all'
                      ? 'Once an agent searches your memory, its queries show up here.'
                      : 'Nothing captured for this tool yet.'
                  }
                />
              )}
            </>
          )}
        </div>
      </div>
    </SettingsLayout>
  )
}
