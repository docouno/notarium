import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { AgentSessions, AgentSessionSummary } from '@notarium/contract'
import { Button } from '../../core/Button'
import { EmptyState } from '../../core/EmptyState'
import {
  IconArchive,
  IconChevronRight,
  IconClock,
  IconCrosshair,
  IconHistory,
  IconSearch,
} from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { SettingsLayout } from '../../layouts/SettingsLayout'
import { exactDateTime, timeAgo } from '../../libs/datetime'
import { agentSessionsRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { RECURRING_MISS_MIN, useAgentsSummary } from './AgentsProvider'
import { AgentsTabs } from './AgentsTabs'
import { QueryStatRow } from './AuditRows'
import { ListSkeleton, PanelsSkeleton } from './AuditSkeletons'
import { countLabel } from './consts'
import styles from './SessionsPage.module.scss'

const sessionCounts = (session: AgentSessionSummary): string => {
  const audited = `${countLabel(session.reads, 'read')} · ${countLabel(session.writes, 'write')}`
  return session.calls == null
    ? `${audited} · archived snapshot`
    : `${countLabel(session.calls, 'call')} · ${audited}`
}

export const SessionsPage = () => {
  const { updateSessions } = useAgentsSummary()
  const [data, setData] = useState<AgentSessions | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback(
    async (cursor?: string) => {
      if (cursor) {
        setLoadingMore(true)
      } else {
        setLoading(true)
      }
      setFailed(false)
      try {
        const next = await api.agentSessionsGet({ limit: 30, cursor })
        setData((prev) =>
          cursor && prev
            ? {
                ...next,
                aggregates: prev.aggregates ?? next.aggregates,
                sessions: [...prev.sessions, ...next.sessions],
              }
            : next,
        )
        if (!cursor) {
          updateSessions(next)
        }
      } catch {
        setFailed(true)
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [updateSessions],
  )

  useEffect(() => {
    void load()
  }, [load])

  const blindSpots = (data?.aggregates?.misses ?? []).filter(
    (item) => item.misses >= RECURRING_MISS_MIN,
  )
  const hasPanels = blindSpots.length > 0 || (data?.aggregates?.top.length ?? 0) > 0
  const empty = !loading && !failed && data?.sessions.length === 0 && !data.outside

  return (
    <SettingsLayout
      trail={[{ label: 'Agents' }, { label: 'Sessions' }]}
      spaceLess
      sectionTabs={<AgentsTabs active="sessions" />}
      testIdPrefix="sessions"
    >
      <div className={styles.page} data-testid="agents-sessions">
        <div className={styles.inner}>
          <header className={styles.head}>
            <h1 className={styles.title}>Agent sessions</h1>
            <p className={styles.sub}>
              Work episodes across your agents. Open a session to see what it retrieved and what it
              changed, in the order it happened.
            </p>
          </header>

          {failed && (
            <Notice variant="error" data-testid="sessions-error">
              Couldn’t load agent sessions.
            </Notice>
          )}

          {loading && !data ? (
            <>
              <PanelsSkeleton />
              <ListSkeleton />
            </>
          ) : empty ? (
            <EmptyState
              icon={<IconHistory size={22} />}
              title="No agent sessions yet"
              hint="A session appears after an agent calls start_session. Unbound activity stays visible in its own group."
            />
          ) : data ? (
            <>
              {hasPanels && (
                <div className={styles.panels}>
                  {blindSpots.length > 0 && (
                    <section className={`${styles.panel} ${styles.panelWarn}`}>
                      <div className={styles.panelHead}>
                        <IconCrosshair size={13} />
                        <span>Blind spots</span>
                        <span className={styles.panelHint}>keep coming back empty</span>
                      </div>
                      <ul className={styles.statList}>
                        {blindSpots.map((stat) => (
                          <QueryStatRow key={`${stat.tool}-${stat.query}`} stat={stat} warn />
                        ))}
                      </ul>
                    </section>
                  )}
                  {(data.aggregates?.top.length ?? 0) > 0 && (
                    <section className={styles.panel}>
                      <div className={styles.panelHead}>
                        <IconSearch size={13} />
                        <span>Frequent</span>
                        <span className={styles.panelHint}>across all activity</span>
                      </div>
                      <ul className={styles.statList}>
                        {data.aggregates?.top.map((stat) => (
                          <QueryStatRow key={`${stat.tool}-${stat.query}`} stat={stat} />
                        ))}
                      </ul>
                    </section>
                  )}
                </div>
              )}

              <div className={styles.sessionListHead}>
                <span>Recent sessions</span>
                <span>
                  {data.active > 0 ? `${data.active} active · ` : ''}
                  {data.total} total
                </span>
              </div>
              <ul className={styles.sessionList} data-testid="sessions-list">
                {data.outside && (
                  <li>
                    <Link
                      to={agentSessionsRoute('outside')}
                      className={styles.sessionRow}
                      data-testid="session-outside"
                    >
                      <span className={styles.sessionGlyph} data-kind="outside">
                        <IconCrosshair size={16} />
                      </span>
                      <span className={styles.sessionMain}>
                        <span className={styles.sessionTitle}>Outside sessions</span>
                        <span className={styles.sessionDescription}>
                          {countLabel(data.outside.reads, 'read')} ·{' '}
                          {countLabel(data.outside.writes, 'write')} without a session
                        </span>
                      </span>
                      <span
                        className={styles.sessionAside}
                        title={exactDateTime(data.outside.lastSeenAt)}
                      >
                        {timeAgo(data.outside.lastSeenAt)}
                        <IconChevronRight size={15} />
                      </span>
                    </Link>
                  </li>
                )}
                {data.sessions.map((session) => (
                  <li key={session.id}>
                    <Link
                      to={agentSessionsRoute(session.id)}
                      className={styles.sessionRow}
                      data-testid="session-row"
                    >
                      <span
                        className={styles.sessionGlyph}
                        data-kind={session.active ? 'active' : 'idle'}
                      >
                        {session.retained ? <IconClock size={16} /> : <IconArchive size={16} />}
                      </span>
                      <span className={styles.sessionMain}>
                        <span className={styles.sessionTitleLine}>
                          <span className={styles.sessionTitle}>{session.name}</span>
                          {session.parentId && (
                            <span className={styles.sessionKindLabel}>Fork</span>
                          )}
                          {session.named === false && (
                            <span className={styles.sessionKindLabel}>Automatic</span>
                          )}
                          {session.active && <span className={styles.activeLabel}>Active</span>}
                        </span>
                        <span className={styles.sessionDescription}>{sessionCounts(session)}</span>
                      </span>
                      <span
                        className={styles.sessionAside}
                        title={exactDateTime(session.lastSeenAt)}
                      >
                        {timeAgo(session.lastSeenAt)}
                        <IconChevronRight size={15} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {data.hasMore && data.nextCursor && (
                <div className={styles.loadMore}>
                  <Button
                    variant="ghost"
                    disabled={loadingMore}
                    onClick={() => void load(data.nextCursor ?? undefined)}
                  >
                    {loadingMore ? 'Loading…' : 'Load older sessions'}
                  </Button>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </SettingsLayout>
  )
}
