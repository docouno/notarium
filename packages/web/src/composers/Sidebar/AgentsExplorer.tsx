import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import type { AgentAbilitySummary, AgentSessionSummary } from '@notarium/contract'
import { ABILITY_KIND, ABILITY_SOURCE, ROLE_SCOPE } from '@notarium/contract/enums'
import { EmptyState } from '../../core/EmptyState'
import {
  IconArchive,
  IconAward,
  IconChevron,
  IconClock,
  IconDrama,
  IconFolderKanban,
  IconHistory,
  IconSparkles,
  IconUser,
  IconWorkspace,
} from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { cx } from '../../libs/cx/cx'
import { drainPages } from '../../libs/paging'
import { agentAbilityRoute, agentActivityRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { TreeState, type TreeStatus } from '../../widgets/TreeState'
import {
  type AgentsAbilityExplorerPage,
  agentsExplorerGroupsStorageKey,
  type AgentsSessionExplorerPage,
  useAgentsExplorer,
} from '../AgentsExplorerProvider'
import { useAuth } from '../AuthProvider'
import { useSpace } from '../SpaceProvider'
import { ExplorerVirtualRows } from './ExplorerVirtualRows'
import { MemoryTree } from './MemoryTree'
import styles from './AgentsExplorer.module.scss'
import tree from './Sidebar.module.scss'

/** Groups are ordered by closeness to the user, not by source: what the user owns
 *  reads first, what the product ships reads last. Catalog is the only group that
 *  starts collapsed — it is a template shelf, not the user's inventory. */
type GroupKind = 'personal' | 'space' | 'project' | 'system' | 'catalog' | 'session'
type Group<Item> = { key: string; label: string; kind: GroupKind; items: Item[] }
type OwnedAbility = Extract<AgentAbilitySummary, { source: 'owned' }>
type OwnedLocation = OwnedAbility['locator']['location']
type ExplorerRow =
  | { kind: 'group'; key: string; label: string; group: GroupKind }
  | { kind: 'ability'; ability: AgentAbilitySummary }
  | { kind: 'session'; session: AgentSessionSummary }

const COLLAPSED_BY_DEFAULT = ['catalog']

const groupIcon = (kind: GroupKind) => {
  switch (kind) {
    case 'personal':
      return <IconUser size={15} />
    case 'space':
      return <IconWorkspace size={15} />
    case 'project':
      return <IconFolderKanban size={15} />
    case 'system':
      return <IconSparkles size={15} />
    case 'catalog':
      return <IconArchive size={15} />
    default:
      return <IconClock size={15} />
  }
}

const readCollapsed = (key: string | null): string[] => {
  if (!key) {
    return COLLAPSED_BY_DEFAULT
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown

    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')
      ? parsed
      : COLLAPSED_BY_DEFAULT
  } catch {
    /* A blocked or malformed preference falls back to the default shape. */
    return COLLAPSED_BY_DEFAULT
  }
}

export const AgentsExplorer = ({
  activeId,
  scrollRef,
  visible,
  headH,
}: {
  activeId: string | null
  scrollRef: React.RefObject<HTMLDivElement | null>
  visible: boolean
  headH: number
}) => {
  const { dataset, version, cache, scope, setAbilityPage, setSessionPage } = useAgentsExplorer()
  const { spaces, personalSpace } = useSpace()
  const { me } = useAuth()
  const location = useLocation()
  const [error, setError] = useState<string | null>(null)
  const [continuationError, setContinuationError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const seq = useRef(0)
  const seenList = useRef<string | null>(null)
  const sentinel = useRef<HTMLButtonElement>(null)
  const cacheRef = useRef(cache)
  const abilities = dataset === 'roles' || dataset === 'skills' ? cache[dataset] : null
  const sessions = cache.sessions
  // The stable account id, like the dataset lens next to it: both halves of the
  // explorer's per-user state survive a rename of the handle.
  const owner = me?.id ?? '@system'
  const collapsedKey = scope ? agentsExplorerGroupsStorageKey(owner, scope.spaceId) : null
  // The key and the groups are ONE value: a collapse toggled before the Space
  // resolved had nowhere to persist to and was then overwritten by the read that
  // followed the key's arrival — the preference the user just expressed, lost.
  const [collapsed, setCollapsed] = useState<{ key: string | null; groups: string[] }>(() => ({
    key: collapsedKey,
    groups: readCollapsed(collapsedKey),
  }))

  useEffect(() => {
    cacheRef.current = cache
  }, [cache])

  if (collapsed.key !== collapsedKey) {
    setCollapsed({ key: collapsedKey, groups: readCollapsed(collapsedKey) })
  }

  const load = useCallback(
    async (cursor?: string) => {
      // No scope, no listing: the tree IS the active Space, so asking before it is
      // resolved asks the owner-global question instead and throws the answer away.
      if (dataset === 'memory' || !scope) {
        return
      }
      const request = ++seq.current
      const current = cacheRef.current[dataset]
      // A cursor appends one page. WITHOUT one this is a re-read rather than a
      // reset: the list is rebuilt from page one down to as many pages as are on
      // screen now and swapped in whole when the last one lands, so an
      // invalidation costs the reader neither their scroll position nor the pages
      // they already asked for.
      const base = cursor ? current : null
      const wanted = base ? base.pages + 1 : Math.max(1, current?.pages ?? 1)
      const loaded = base ? base.pages : 0
      let stale = false

      const fresh = () => {
        if (request === seq.current) {
          return true
        }
        stale = true
        return false
      }

      // Only a CONTINUATION clears the continuation error — see the same guard on the
      // library page. A cursorless read is the tree re-read at the same depth, and
      // unparking there let any background frame resume a failed page by itself: the
      // sentinel is still inside the observer's margin, so re-arming fires at once.
      if (cursor) {
        setContinuationError(null)
      } else {
        setError(null)
      }
      setLoadingMore(Boolean(cursor))
      try {
        if (dataset === 'sessions') {
          const items = base ? [...(base as AgentsSessionExplorerPage).items] : []
          const first = await api.agentSessionsGet({
            limit: 30,
            cursor,
            aggregates: '0',
          })

          if (!fresh()) {
            return
          }
          items.push(...first.sessions)
          const drained = await drainPages(
            (at) => api.agentSessionsGet({ limit: 30, cursor: at, aggregates: '0' }),
            {
              from: first.nextCursor,
              pages: wanted - loaded - 1,
              cursorOf: (page) => page.nextCursor,
              onPage: (page) => {
                if (!fresh()) {
                  return false
                }
                items.push(...page.sessions)
              },
            },
          )

          if (stale) {
            return
          }
          setSessionPage({
            items,
            nextCursor: drained.nextCursor,
            pages: loaded + 1 + drained.read,
          })
        } else {
          const previous = base as AgentsAbilityExplorerPage | null
          const items = previous ? [...previous.items] : []

          // Scoped to the active Space (design 15): the filter runs BEFORE the
          // global location cap, so the Space the user is actually in is listed
          // WHOLE instead of competing for a shared bounded scan. Personal rides
          // along regardless — it is the cross-space fallback and the server adds
          // it outside the scope.
          const read = async (at?: string): Promise<Omit<AgentsAbilityExplorerPage, 'pages'>> => {
            const page = await (dataset === 'roles' ? api.agentRolesGet : api.agentSkillsGet)({
              limit: 30,
              ...scope,
              ...(at ? { cursor: at } : {}),
            })

            // The two library responses deliberately carry different domain fields
            // (`activeRole`, install projects/spaces). Explorer pagination needs only
            // their shared row projection, so settle that projection here instead of
            // making the generic cursor drain unify unrelated wire contracts.
            return {
              items: page.items,
              projects: page.projects,
              nextCursor: page.nextCursor,
            }
          }
          const first = await read(cursor)

          if (!fresh()) {
            return
          }
          items.push(...first.items)
          const projects = previous?.projects ?? first.projects
          const drained = await drainPages(read, {
            from: first.nextCursor,
            pages: wanted - loaded - 1,
            cursorOf: (page) => page.nextCursor,
            onPage: (page) => {
              if (!fresh()) {
                return false
              }
              items.push(...page.items)
            },
          })

          if (stale) {
            return
          }
          setAbilityPage(dataset, {
            items,
            projects,
            nextCursor: drained.nextCursor,
            pages: loaded + 1 + drained.read,
          })
        }
      } catch (caught) {
        if (request === seq.current) {
          const message =
            caught instanceof Error ? caught.message : 'Couldn’t load Agents explorer.'

          if (cursor) {
            setContinuationError(message)
          } else {
            setError(message)
            // A refresh keeps the rows while it runs, but a FAILED one leaves nothing
            // on screen worth trusting — the error state is the same honest answer a
            // first load gives.
            if (dataset === 'sessions') {
              setSessionPage(null)
            } else {
              setAbilityPage(dataset, null)
            }
          }
        }
      } finally {
        if (request === seq.current) {
          setLoadingMore(false)
        }
      }
    },
    [dataset, scope, setAbilityPage, setSessionPage],
  )

  // Which listing the rows below are: the dataset AND the Space it is scoped to. A
  // park belongs to that listing, so switching lenses or Spaces clears it — a version
  // bump, which re-reads the SAME listing, does not.
  const listKey = dataset === 'memory' || !scope ? null : `${dataset}:${scope.spaceId}`

  useEffect(() => {
    if (seenList.current !== listKey) {
      seenList.current = listKey
      setContinuationError(null)
    }
    void load()
    return () => {
      seq.current += 1
    }
  }, [listKey, load, version])

  const nextCursor = dataset === 'sessions' ? sessions?.nextCursor : abilities?.nextCursor
  useEffect(() => {
    const node = sentinel.current

    if (!node || !nextCursor || loadingMore || continuationError) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void load(nextCursor)
        }
      },
      { root: scrollRef.current, rootMargin: '160px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [continuationError, load, loadingMore, nextCursor, scrollRef])

  const abilityGroups = useMemo((): Group<AgentAbilitySummary>[] => {
    if (!abilities) {
      return []
    }
    const ownedItems = abilities.items.filter(
      (ability): ability is OwnedAbility => ability.source === ABILITY_SOURCE.owned,
    )
    const owned = (match: (placement: OwnedLocation) => boolean) =>
      ownedItems.filter((ability) => match(ability.locator.location))
    // Space groups come from the rows themselves, so a placement is never dropped
    // because the workspace list and the inventory disagree for a render.
    const spaceIds = [
      ...new Set(
        ownedItems.flatMap((ability) =>
          ability.locator.location.scope === ROLE_SCOPE.space
            ? [ability.locator.location.spaceId]
            : [],
        ),
      ),
    ].sort((left, right) => (left === scope?.spaceId ? -1 : right === scope?.spaceId ? 1 : 0))
    const known = [...spaces, ...(personalSpace ? [personalSpace] : [])]

    return [
      {
        key: 'personal',
        label: 'Personal',
        kind: 'personal' as const,
        items: owned((placement) => placement.scope === ROLE_SCOPE.personal),
      },
      ...spaceIds.map((id) => ({
        key: `space:${id}`,
        label: known.find((entry) => entry.id === id)?.displayName ?? 'Space',
        kind: 'space' as const,
        items: owned(
          (placement) => placement.scope === ROLE_SCOPE.space && placement.spaceId === id,
        ),
      })),
      ...(dataset === 'roles'
        ? abilities.projects.map((project) => ({
            key: `project:${project.id}`,
            label: project.displayName,
            kind: 'project' as const,
            items: owned(
              (placement) =>
                placement.scope === ROLE_SCOPE.project && placement.projectId === project.id,
            ),
          }))
        : []),
      {
        key: 'system',
        label: 'System',
        kind: 'system' as const,
        items: abilities.items.filter((ability) => ability.source === ABILITY_SOURCE.system),
      },
      {
        key: 'catalog',
        label: 'Catalog',
        kind: 'catalog' as const,
        items: abilities.items.filter((ability) => ability.source === ABILITY_SOURCE.catalog),
      },
    ].filter((group) => group.items.length > 0)
  }, [abilities, dataset, personalSpace, scope?.spaceId, spaces])

  const sessionGroups = useMemo((): Group<AgentSessionSummary>[] => {
    if (!sessions) {
      return []
    }

    return [
      {
        key: 'active',
        label: 'Active',
        kind: 'session' as const,
        items: sessions.items.filter((session) => session.active),
      },
      {
        key: 'recent',
        label: 'Recent',
        kind: 'session' as const,
        items: sessions.items.filter((session) => session.retained && !session.active),
      },
      {
        key: 'archived',
        label: 'Archived',
        kind: 'session' as const,
        items: sessions.items.filter((session) => !session.retained),
      },
    ].filter((group) => group.items.length > 0)
  }, [sessions])

  const toggle = (key: string) =>
    setCollapsed((current) => {
      const groups = current.groups.includes(key)
        ? current.groups.filter((entry) => entry !== key)
        : [...current.groups, key]

      if (current.key) {
        try {
          localStorage.setItem(current.key, JSON.stringify(groups))
        } catch {
          /* Preferences are best-effort. */
        }
      }

      return { ...current, groups }
    })

  const rows = useMemo((): ExplorerRow[] => {
    const next: ExplorerRow[] = []
    const head = (group: Group<unknown>): ExplorerRow => ({
      kind: 'group',
      key: group.key,
      label: group.label,
      group: group.kind,
    })

    if (dataset === 'sessions') {
      for (const group of sessionGroups) {
        next.push(head(group))
        if (collapsed.groups.includes(group.key)) {
          continue
        }
        for (const session of group.items) {
          next.push({ kind: 'session', session })
        }
      }

      return next
    }
    for (const group of abilityGroups) {
      next.push(head(group))
      if (collapsed.groups.includes(group.key)) {
        continue
      }
      for (const ability of group.items) {
        next.push({ kind: 'ability', ability })
      }
    }

    return next
  }, [abilityGroups, collapsed.groups, dataset, sessionGroups])

  if (dataset === 'memory') {
    return <MemoryTree activeId={activeId} scrollRef={scrollRef} visible={visible} headH={headH} />
  }

  const ready = dataset === 'sessions' ? sessions !== null : abilities !== null
  const items = dataset === 'sessions' ? (sessions?.items ?? []) : (abilities?.items ?? [])
  const status: TreeStatus =
    !ready && !error ? 'loading' : error && !ready ? 'error' : items.length ? 'ready' : 'empty'
  const icon =
    dataset === 'roles' ? (
      <IconDrama size={18} />
    ) : dataset === 'skills' ? (
      <IconAward size={18} />
    ) : (
      <IconHistory size={18} />
    )
  const rowHref = (row: ExplorerRow): string =>
    row.kind === 'ability'
      ? agentAbilityRoute(row.ability.locator)
      : row.kind === 'session'
        ? agentActivityRoute(row.session.id)
        : ''

  return (
    <TreeState
      status={status}
      skeletonRows={6}
      error={error}
      empty={<EmptyState variant="bare" icon={icon} title={`No ${dataset} yet.`} />}
    >
      <div data-testid={`agents-explorer-${dataset}`}>
        <ExplorerVirtualRows
          rows={rows}
          scrollRef={scrollRef}
          visible={visible}
          headH={headH}
          activeId={location.pathname}
          getKey={(row) => (row.kind === 'group' ? `group:${row.key}` : rowHref(row))}
          isActive={(row, current) => row.kind !== 'group' && rowHref(row) === current}
          renderRow={(row) => {
            if (row.kind === 'group') {
              const open = !collapsed.groups.includes(row.key)
              return (
                <div
                  className={tree.navItem}
                  data-testid="agents-explorer-group"
                  // A Space and its Project may share a display name; the scope icon
                  // is what tells them apart, so the kind is published for tests
                  // rather than spelled into the caption.
                  data-group={row.group}
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={open}
                >
                  <button
                    className={tree.chevBtn}
                    onClick={() => toggle(row.key)}
                    aria-label="Toggle"
                  >
                    <span className={cx(tree.chev, open && tree.open)}>
                      <IconChevron size={13} />
                    </span>
                  </button>
                  <button className={tree.navItemBtn} onClick={() => toggle(row.key)}>
                    {groupIcon(row.group)}
                    <span className={tree.navLabel} title={row.label}>
                      {row.label}
                    </span>
                  </button>
                </div>
              )
            }
            const href = rowHref(row)
            const active = location.pathname === href
            return (
              <div
                className={cx(tree.navItem, active && tree.active)}
                style={{ paddingLeft: 12 }}
                role="treeitem"
                aria-level={2}
              >
                <span className={tree.chevSpacer} />
                <Link
                  className={cx(tree.navItemBtn, tree.noteRow)}
                  to={href}
                  aria-current={active ? 'page' : undefined}
                  title={row.kind === 'ability' ? row.ability.description : row.session.name}
                >
                  {row.kind === 'session' ? (
                    <IconHistory size={14} />
                  ) : row.ability.locator.kind === ABILITY_KIND.role ? (
                    <IconDrama size={14} />
                  ) : (
                    <IconAward size={14} />
                  )}
                  <span className={tree.navLabel}>
                    {row.kind === 'ability' ? row.ability.title : row.session.name}
                  </span>
                </Link>
              </div>
            )
          }}
        />
        {continuationError && (
          <Notice
            variant="error"
            className={styles.pageError}
            data-testid="agents-explorer-more-error"
          >
            Couldn’t load more items. Retry when the connection recovers.
          </Notice>
        )}
        {nextCursor && (
          <button
            ref={sentinel}
            type="button"
            className={styles.sentinel}
            disabled={loadingMore}
            onClick={() => void load(nextCursor)}
          >
            {loadingMore ? 'Loading…' : continuationError ? 'Retry' : 'Load more'}
          </button>
        )}
      </div>
    </TreeState>
  )
}
