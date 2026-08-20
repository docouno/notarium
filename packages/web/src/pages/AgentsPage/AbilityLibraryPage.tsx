import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type {
  AddAgentRoleRequest,
  AddAgentSkillRequest,
  AgentAbilitySummary,
  MeAgentRolesResponse,
  MeAgentSkillsResponse,
} from '@notarium/contract'
import {
  ABILITY_AVAILABILITY_MODE,
  ABILITY_KIND,
  ABILITY_ORIGIN,
  ABILITY_SOURCE,
  ROLE_SCOPE,
} from '@notarium/contract/enums'
import { encodeAbilityLocator } from '@notarium/core'
import { useAgentsExplorer } from '../../composers/AgentsExplorerProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { Button } from '../../core/Button'
import { Chip } from '../../core/Chips'
import { useDialog } from '../../core/Dialog'
import { EmptyState } from '../../core/EmptyState'
import { IconAward, IconDrama, IconPlus } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { Skeleton, SkeletonText } from '../../core/Skeleton'
import { StateView } from '../../core/StateView'
import { useToast } from '../../core/Toast'
import { errorText } from '../../libs/errors'
import { drainPages } from '../../libs/paging'
import {
  agentAbilityDraftRoute,
  agentAbilityRoute,
  agentContextRoute,
  DEFAULT_AGENT_CONTEXT_SCOPE,
} from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { AbilityActionsMenu } from './AbilityActionsMenu'
import { CatalogAbilityAddDialog } from './CatalogAbilityAddDialog'
import { projectContextScope } from './helpers/contextScope'
import { projectChoiceLabels } from './helpers/format'
import { rememberContextScopeSpace } from './helpers/scopeStorage'
import { usePackageLibraryFrame } from './PackageLibraryFrame'
import { hasPackageLibraryFilters, packageLibraryQuery } from './packageLibraryState'
import styles from './AbilityLibraryPage.module.scss'

type AbilityPage = MeAgentRolesResponse | MeAgentSkillsResponse

/** What an ability belongs to, named the way the Explorer and the aside name it —
 *  the Space's own name, the project's own name — rather than the internal word for
 *  the slot. A collapsed listing shows one card per role, so a card whose own
 *  placement is a project is a role that never had a Space base: it simply lives
 *  there, which naming the project says better than any label for the slot. */
const placementLabel = (
  ability: AgentAbilitySummary,
  spaceName?: string,
  projectName?: string,
): string => {
  if (ability.source !== ABILITY_SOURCE.owned) {
    return ability.source
  }
  const location = ability.locator.location

  return location.scope === ROLE_SCOPE.personal
    ? 'Personal'
    : location.scope === ROLE_SCOPE.project
      ? (projectName ?? 'Project')
      : (spaceName ?? 'Space')
}

export const AbilityLibraryPage = ({ expectedKind }: { expectedKind?: 'roles' | 'skills' }) => {
  const { kind: routeKind } = useParams<{ kind?: 'roles' | 'skills' }>()
  const kind = expectedKind ?? routeKind ?? 'roles'
  const abilityKind = kind === 'skills' ? ABILITY_KIND.skill : ABILITY_KIND.role
  const navigate = useNavigate()
  const { state, setState, reportFacets } = usePackageLibraryFrame()
  const { versions, invalidate } = useAgentsExplorer()
  const { space, spaces, personalSpace, canWrite, reportNoteSpace } = useSpace()
  const { confirm } = useDialog()
  const toast = useToast()
  const dataVersion = versions[kind]
  const [data, setData] = useState<AbilityPage | null>(null)
  const dataRef = useRef<AbilityPage | null>(null)
  dataRef.current = data
  const [failed, setFailed] = useState<string | null>(null)
  const [continuationError, setContinuationError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busyLocator, setBusyLocator] = useState<string | null>(null)
  const [catalogAdd, setCatalogAdd] = useState<AgentAbilitySummary | null>(null)
  const seq = useRef(0)
  const pagesRef = useRef(1)
  const sentinel = useRef<HTMLButtonElement>(null)
  // Whether the reader is still ON this listing. The writes below answer on the
  // network and then send the reader somewhere, and `navigate` keeps working from a
  // page that is gone — react-router arms its own guard in a layout effect and never
  // disarms it — so a late answer would land on whatever they opened meanwhile.
  const onScreen = useRef(true)
  const query = useMemo(() => packageLibraryQuery(state), [state])
  const queryKey = useMemo(() => JSON.stringify(query), [query])
  const seenQuery = useRef<string | null>(null)

  useEffect(() => {
    onScreen.current = true
    return () => {
      onScreen.current = false
    }
  }, [])

  const load = useCallback(
    async (cursor?: string) => {
      const request = ++seq.current
      const base = cursor ? dataRef.current : null
      // A cursor appends one page. WITHOUT one this is a re-read at the SAME depth:
      // an invalidation (this ability was just saved, the store changed) must not
      // cost the reader the pages they scrolled through. A different QUERY is a
      // different list and resets the depth — the effect below does that explicitly.
      const wanted = base ? pagesRef.current + 1 : Math.max(1, pagesRef.current)

      // Only a CONTINUATION clears the continuation error. A cursorless read is this
      // same list re-read at the same depth — a background frame, a save in another
      // tab, a reconnect — and clearing the park here re-armed the observer over a
      // sentinel that is still in view, so the failed page asked for itself again
      // with nobody touching Retry. On a flapping connection that is a loop.
      if (cursor) {
        setContinuationError(null)
      } else {
        setFailed(null)
      }
      setLoadingMore(Boolean(cursor))
      try {
        const read = async (at?: string) =>
          (await (abilityKind === ABILITY_KIND.role ? api.agentRolesGet : api.agentSkillsGet)({
            ...query,
            ...(at ? { cursor: at } : {}),
          })) as AbilityPage
        let page = await read(cursor)

        if (request !== seq.current) {
          return
        }
        const items = base ? [...base.items, ...page.items] : [...page.items]
        let stale = false
        const drained = await drainPages(read, {
          from: page.nextCursor,
          pages: wanted - (base ? pagesRef.current : 0) - 1,
          cursorOf: (next) => next.nextCursor,
          onPage: (next) => {
            if (request !== seq.current) {
              stale = true
              return false
            }
            page = next
            items.push(...next.items)
          },
        })

        if (stale || request !== seq.current) {
          return
        }
        pagesRef.current = (base ? pagesRef.current : 0) + 1 + drained.read
        setData({ ...page, items, nextCursor: drained.nextCursor } as AbilityPage)
      } catch (error) {
        if (request === seq.current) {
          if (cursor) {
            setContinuationError(errorText(error))
          } else {
            setFailed(errorText(error))
            // A refresh keeps the cards while it runs; a FAILED one has nothing left
            // worth showing, so the surface falls back to its error state.
            setData(null)
          }
        }
      } finally {
        if (request === seq.current) {
          setLoadingMore(false)
        }
      }
    },
    [abilityKind, query],
  )

  useEffect(() => {
    if (seenQuery.current !== queryKey) {
      seenQuery.current = queryKey
      pagesRef.current = 1
      setData(null)
      // A different query is a different list, and a park belongs to the list it
      // stopped in — carrying it over would leave the new one unable to continue.
      setContinuationError(null)
    }
    void load()
    return () => {
      seq.current += 1
    }
  }, [dataVersion, load, queryKey])

  useEffect(() => {
    reportFacets(kind, data?.facets ?? null)
  }, [data?.facets, kind, reportFacets])

  useEffect(() => {
    const node = sentinel.current
    const cursor = data?.nextCursor

    if (!node || !cursor || loadingMore || continuationError) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void load(cursor)
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [continuationError, data?.nextCursor, load, loadingMore])

  const items = (data?.items ?? []).filter((ability) => ability.locator.kind === abilityKind)
  const grouped = useMemo(
    () =>
      [
        [ABILITY_SOURCE.owned, items.filter((item) => item.source === ABILITY_SOURCE.owned)],
        [ABILITY_SOURCE.system, items.filter((item) => item.source === ABILITY_SOURCE.system)],
        [ABILITY_SOURCE.catalog, items.filter((item) => item.source === ABILITY_SOURCE.catalog)],
      ] as const,
    [items],
  )
  const filtered = hasPackageLibraryFilters(state)
  const clear = () =>
    setState({ q: null, source: null, home: null, availability: null, project: null })
  const label = abilityKind === ABILITY_KIND.role ? 'Roles' : 'Skills'

  const setEnabled = async (ability: AgentAbilitySummary, enabled: boolean) => {
    if (ability.source === ABILITY_SOURCE.catalog) {
      return
    }
    const key = agentAbilityRoute(ability.locator)
    setBusyLocator(key)
    try {
      await api.agentAbilitySetEnabled(ability.locator, enabled)
      setData((current) =>
        current
          ? ({
              ...current,
              items: current.items.map((item) =>
                agentAbilityRoute(item.locator) === key && 'enabled' in item
                  ? { ...item, enabled }
                  : item,
              ),
            } as AbilityPage)
          : current,
      )
      invalidate(kind)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusyLocator(null)
    }
  }

  const deleteOwned = async (ability: Extract<AgentAbilitySummary, { source: 'owned' }>) => {
    const ok = await confirm({
      title: `Delete “${ability.title}”?`,
      message: `This moves the ${ability.locator.kind} to Trash.`,
      confirmLabel: 'Delete',
      danger: true,
    })

    if (!ok) {
      return
    }
    const key = agentAbilityRoute(ability.locator)
    setBusyLocator(key)
    try {
      await api.noteRemove(ability.noteId)
      setData((current) =>
        current
          ? ({
              ...current,
              items: current.items.filter((item) => agentAbilityRoute(item.locator) !== key),
            } as AbilityPage)
          : current,
      )
      invalidate(kind)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusyLocator(null)
    }
  }

  const addRoleVersion = async (
    ability: Extract<AgentAbilitySummary, { source: 'owned' }>,
    project: AbilityPage['projects'][number],
  ) => {
    if (ability.locator.kind !== ABILITY_KIND.role) {
      return
    }
    const key = agentAbilityRoute(ability.locator)
    setBusyLocator(key)
    try {
      const created = await api.agentAbilityCreateVersion(ability.locator, project.id)
      invalidate(kind)
      // The version starts as a copy of the base, so the next thing anyone wants is
      // to say how it differs — the same landing the New flow uses. Unless the reader
      // has already opened something else: then this would drag them out of it, into
      // an editor for a package they are no longer looking at.
      if (onScreen.current) {
        navigate(agentAbilityRoute(created.locator), { state: { editAbility: true } })
      }
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusyLocator(null)
    }
  }

  const addCatalog = async (input: AddAgentRoleRequest | AddAgentSkillRequest) => {
    if (!catalogAdd || catalogAdd.source !== ABILITY_SOURCE.catalog) {
      return
    }
    const result =
      catalogAdd.locator.kind === ABILITY_KIND.role
        ? await api.agentRoleAddExact(input as AddAgentRoleRequest)
        : await api.agentSkillAddExact(input as AddAgentSkillRequest)
    setCatalogAdd(null)
    invalidate(kind)
    // The write happened, so every listing re-reads either way. Only the LANDING is
    // the reader's to lose: they asked for this from the library they were on, and a
    // page they have since left may not send them anywhere.
    if (onScreen.current) {
      navigate(agentAbilityRoute(result.locator))
    }
  }

  const contextHref = (ability: AgentAbilitySummary, scope: string) => {
    const params = new URLSearchParams({ role: encodeAbilityLocator(ability.locator) })
    return `${agentContextRoute(scope)}?${params}`
  }

  const openContext = (ability: AgentAbilitySummary, project?: AbilityPage['projects'][number]) => {
    if (!project) {
      navigate(contextHref(ability, DEFAULT_AGENT_CONTEXT_SCOPE))
      return
    }
    const scope = projectContextScope(project.handle)
    rememberContextScopeSpace(scope, project.space)
    reportNoteSpace(project.space)
    navigate(contextHref(ability, scope))
  }

  return (
    <div className={styles.page} data-testid={`agents-${kind}`}>
      <header className={styles.head}>
        <div>
          <h1>{label}</h1>
          <p>Exact System, Catalog and Owned abilities available around the selected Space.</p>
        </div>
        <Button
          variant="primary"
          onClick={() => navigate(agentAbilityDraftRoute(abilityKind, crypto.randomUUID()))}
          data-testid={`${abilityKind}-create`}
        >
          <IconPlus size={14} /> New {abilityKind}
        </Button>
      </header>

      {!data && !failed ? (
        <LibrarySkeleton />
      ) : !data ? (
        <StateView
          tone="error"
          title={`Couldn’t load ${label.toLowerCase()}`}
          description={failed}
        />
      ) : filtered && data.filteredTotal === 0 ? (
        <EmptyState
          icon={
            abilityKind === ABILITY_KIND.role ? <IconDrama size={22} /> : <IconAward size={22} />
          }
          title={`No matching ${label.toLowerCase()}`}
          action={<Button onClick={clear}>Clear filters</Button>}
        />
      ) : (
        <>
          {data.truncated && (
            <Notice variant="warning">Some placements are outside this bounded view.</Notice>
          )}
          {continuationError && (
            <Notice variant="error" data-testid="ability-library-more-error">
              Couldn’t load more abilities. Retry when the connection recovers.
            </Notice>
          )}
          {grouped.map(([source, abilities]) =>
            abilities.length ? (
              <section key={source} className={styles.section}>
                <div className={styles.sectionHead}>
                  <h2>
                    {source === ABILITY_SOURCE.owned ? `Your ${label.toLowerCase()}` : source}
                  </h2>
                  <span>{abilities.length}</span>
                </div>
                <div className={styles.grid}>
                  {abilities.map((ability) => {
                    const href = agentAbilityRoute(ability.locator)
                    const roleLocation =
                      ability.source === ABILITY_SOURCE.owned &&
                      ability.locator.kind === ABILITY_KIND.role
                        ? ability.locator.location
                        : null
                    // The Space an owned ability lives in, for BOTH kinds: a reach is
                    // counted against that Space's projects, and the library is
                    // owner-global, so the whole project list is the wrong denominator.
                    const homeSpace =
                      ability.source === ABILITY_SOURCE.owned &&
                      ability.locator.location.scope !== ROLE_SCOPE.personal
                        ? ability.locator.location.spaceId
                        : null
                    const homeSpaceRow = homeSpace
                      ? spaces.find((entry) => entry.id === homeSpace)
                      : null
                    const owningSpace = homeSpaceRow?.slug ?? null
                    const applicableProjects = (data.projects ?? []).filter(
                      (project) => !owningSpace || project.space === owningSpace,
                    )
                    const versionProjects = (
                      ability.source === ABILITY_SOURCE.owned ? (ability.versions ?? []) : []
                    ).flatMap((version) => {
                      const project = (data.projects ?? []).find(
                        (entry) => entry.id === version.projectId,
                      )
                      return project ? [project] : []
                    })
                    // Only a narrowed reach is worth a chip: "all projects" is what a
                    // Space role has always meant and saying it adds nothing.
                    const reach =
                      ability.source === ABILITY_SOURCE.owned &&
                      ability.availability?.mode === ABILITY_AVAILABILITY_MODE.selectedProjects
                        ? `${ability.availability.projectIds.length} of ${applicableProjects.length} projects`
                        : null
                    const configure = roleLocation
                      ? roleLocation.scope === ROLE_SCOPE.personal
                        ? { onClick: () => openContext(ability) }
                        : roleLocation.scope === ROLE_SCOPE.project
                          ? (() => {
                              const project = applicableProjects.find(
                                (entry) => entry.id === roleLocation.projectId,
                              )
                              return project
                                ? {
                                    onClick: () => openContext(ability, project),
                                  }
                                : undefined
                            })()
                          : applicableProjects.length
                            ? {
                                onClick: () => {},
                                children: applicableProjects.map((project) => ({
                                  label: project.displayName,
                                  onClick: () => openContext(ability, project),
                                })),
                              }
                            : undefined
                      : undefined
                    return (
                      <article
                        key={href}
                        className={styles.card}
                        data-testid={`ability-${ability.source}-${ability.name}`}
                      >
                        <Link to={href} className={styles.cardLink}>
                          <div className={styles.cardTop}>
                            {'enabled' in ability && (
                              <span
                                className={`${styles.status} ${ability.enabled ? styles.statusOn : styles.statusOff}`}
                                role="img"
                                aria-label={ability.enabled ? 'Enabled' : 'Disabled'}
                                title={ability.enabled ? 'Enabled' : 'Disabled'}
                              />
                            )}
                            <h3>{ability.title}</h3>
                          </div>
                          <p className={!ability.description ? styles.emptyDescription : undefined}>
                            {ability.description || '\u00a0'}
                          </p>
                          {ability.source === ABILITY_SOURCE.owned && (
                            <footer className={styles.meta}>
                              <Chip>
                                {placementLabel(
                                  ability,
                                  homeSpaceRow?.displayName,
                                  roleLocation?.scope === ROLE_SCOPE.project
                                    ? (data.projects ?? []).find(
                                        (entry) =>
                                          roleLocation.scope === ROLE_SCOPE.project &&
                                          entry.id === roleLocation.projectId,
                                      )?.displayName
                                    : undefined,
                                )}
                              </Chip>
                              <Chip>
                                {ability.origin === ABILITY_ORIGIN.catalog
                                  ? 'From catalog'
                                  : 'Custom'}
                              </Chip>
                              {/* Versions are a property of the role, never cards of
                                  their own: two identically named cards read as a
                                  duplicate bug rather than as an override. */}
                              {versionProjects.map((project) => (
                                <Chip key={project.id}>Version · {project.displayName}</Chip>
                              ))}
                              {reach && <Chip>{reach}</Chip>}
                            </footer>
                          )}
                        </Link>
                        <div className={styles.cardMenu}>
                          <AbilityActionsMenu
                            ability={ability}
                            busy={busyLocator === href}
                            onEdit={
                              ability.source === ABILITY_SOURCE.owned &&
                              (canWrite || ability.locator.location.scope === ROLE_SCOPE.personal)
                                ? () => navigate(href, { state: { editAbility: true } })
                                : undefined
                            }
                            configure={configure}
                            addVersion={
                              ability.source === ABILITY_SOURCE.owned &&
                              ability.locator.kind === ABILITY_KIND.role &&
                              roleLocation?.scope === ROLE_SCOPE.space &&
                              canWrite
                                ? projectChoiceLabels(
                                    applicableProjects.filter(
                                      (project) =>
                                        !versionProjects.some((entry) => entry.id === project.id),
                                    ),
                                  ).map((project) => ({
                                    label: project.label,
                                    onClick: () => void addRoleVersion(ability, project),
                                  }))
                                : undefined
                            }
                            onToggle={
                              ability.source === ABILITY_SOURCE.catalog
                                ? undefined
                                : (enabled) => void setEnabled(ability, enabled)
                            }
                            onDelete={
                              ability.source === ABILITY_SOURCE.owned &&
                              (canWrite || ability.locator.location.scope === ROLE_SCOPE.personal)
                                ? () => void deleteOwned(ability)
                                : undefined
                            }
                            onAdd={
                              ability.source === ABILITY_SOURCE.catalog
                                ? () => setCatalogAdd(ability)
                                : undefined
                            }
                            testId={`ability-${ability.source}-${ability.name}-menu`}
                          />
                        </div>
                      </article>
                    )
                  })}
                </div>
              </section>
            ) : null,
          )}
          {data.nextCursor && (
            <button
              ref={sentinel}
              type="button"
              className={styles.sentinel}
              disabled={loadingMore}
              onClick={() => void load(data.nextCursor ?? undefined)}
            >
              {loadingMore ? 'Loading…' : continuationError ? 'Retry' : 'Load more'}
            </button>
          )}
          {catalogAdd?.source === ABILITY_SOURCE.catalog && (
            <CatalogAbilityAddDialog
              kind={catalogAdd.locator.kind}
              name={catalogAdd.name}
              space={space}
              spaceAvailable={canWrite && personalSpace?.slug !== space}
              projects={data.projects ?? []}
              onAdd={addCatalog}
              onClose={() => setCatalogAdd(null)}
            />
          )}
        </>
      )}
    </div>
  )
}

const LibrarySkeleton = () => (
  <div className={styles.skeleton} data-testid="ability-library-skeleton" aria-hidden="true">
    <div className={styles.skeletonHeading}>
      <Skeleton w="22%" h={20} radius={5} />
      <Skeleton w={24} h={14} radius={4} />
    </div>
    <div className={styles.grid}>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className={styles.cardSkeleton}>
          <div className={styles.skeletonHeading}>
            <Skeleton w="58%" h={18} radius={5} />
            <Skeleton w={10} h={10} radius={5} />
          </div>
          <SkeletonText lines={2} lastWidth="72%" />
          <Skeleton w="42%" h={20} radius={10} />
        </div>
      ))}
    </div>
  </div>
)
