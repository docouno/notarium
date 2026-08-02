import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import type {
  ContextMemory,
  ContextOrderEntry,
  ContextSet,
  ContextSetView,
  MeAgentContext,
  MemoryCategory,
  Preview,
  ProjectAgentContext,
  Space,
} from '@notarium/contract'
import { STORE_EVENT } from '@notarium/contract/events'
import { useProjects } from '../../composers/ProjectsProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { CHANGED_COALESCE_MS, useSync } from '../../composers/SyncProvider'
import { Chip } from '../../core/Chips'
import { useDialog } from '../../core/Dialog'
import { IconFolderKanban, IconUser } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { useToast } from '../../core/Toast'
import { SettingsLayout, type SettingsTab } from '../../layouts/SettingsLayout'
import { agentContextRoute, memoryNoteRoute, noteRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { useAgentsSummary } from './AgentsProvider'
import { AgentsTabs } from './AgentsTabs'
import { EMPTY_PERSONAL, EMPTY_PROJECT } from './consts'
import { AggregateBar } from './ContextMeters'
import { AggregateBarSkeleton } from './ContextSkeletons'
import { orderItemsBy, reRankByEntries } from './helpers/contextOrder'
import { memoryState, memoryTrimmed, pinsTrimmed, setsTrimmed } from './helpers/contextTrim'
import { projectLabel } from './helpers/format'
import { rememberContextScopeSpace, rememberedContextScopeSpace } from './helpers/scopeStorage'
import { MemoryBlock } from './MemoryBlock'
import { PinPicker } from './PinPicker'
import { PinsBlock } from './PinsBlock'
import type { MemoryItem, ProjectScope, ScopeCard, ScopeKey, SetSave } from './types'
import styles from './ContextPage.module.scss'

// The Context constructor (#165/#208): the control surface for what an agent loads
// before work — a flexible TOKEN-BUDGET tool, not a passive payload dump.
//
// The whole eager cost is ONE token scale, ONE budget per SCOPE. PERSONAL has a
// budget P (pins + memory share it). A PROJECT has a budget Q, and the personal
// background EMBEDS into it: the project's own pins load first (the specific scope
// outranks the general), then personal fills whatever of Q remains. So a project
// route shows a single Q-wide scale with two bands — the project and the embedded
// personal — plus a clickable tab per scope that swaps the panels below. The server
// curates the loaded/trimmed split (one shared scan with start_session), so the pult
// shows EXACTLY what the agent loads — the web never re-derives the trim. Because a
// scope is ONE budget, the scale can never read "budget still free, yet trimming".
// Every note carries a weight meter (its share of the scope budget) so the fattest —
// the ones worth trimming — stand out.

export const ContextPage = () => {
  const { space, spaces: allSpaces, personalSpace, reportNoteSpace } = useSpace()
  const { projects, projectsSpace } = useProjects()
  const navigate = useNavigate()
  const toast = useToast()
  const { confirm } = useDialog()
  const { scope: routeScope } = useParams()
  const { subscribe } = useSync()
  const { updateContext } = useAgentsSummary()

  const scope = routeScope ?? 'personal'
  // The eager scope as the SERVER curated it (#208): `personal` is the personal-route
  // scope (budget P); `project` carries the project pins AND the embedded personal
  // (budget Q); `projectMemory` is the about-project audit (recall-on-demand, #207).
  const [personal, setPersonal] = useState<MeAgentContext | null>(null)
  const [project, setProject] = useState<ProjectAgentContext | null>(null)
  const [projectMemory, setProjectMemory] = useState<MemoryCategory[] | null>(null)
  const [previews, setPreviews] = useState<Record<string, Preview | null>>({})
  const [failed, setFailed] = useState<string[]>([])
  // The ONE add-picker (#209): open to pin notes / build a set. `addToSetId`/`addToSetHome`
  // pre-target a set (the "Add notes" row action) so it opens straight into adding to it,
  // addressed against the set's real home space.
  const [picker, setPicker] = useState<null | { addToSetId?: string; addToSetHome?: string }>(null)
  // The caller's sets with their HOME space (#209) — feeds the picker's set selector and
  // resolves the home-space-scoped CRUD (item add/remove, delete); refreshed on mutation.
  const [allSets, setAllSets] = useState<ContextSet[]>([])
  // Which scope's panels the ONE scale is focused on (#208). Follows the route by
  // default (a project route focuses the project); a click on the Personal tab switches
  // inline — so the embedded personal background is inspectable without a stacked panel.
  const [activeScope, setActiveScope] = useState<ScopeKey>('personal')
  const seq = useRef(0)
  // The project scope a commit is allowed to land under. `seq` alone cannot guard a
  // STALE re-invocation of `load` (a finally that captured an old project's closure
  // gets a NEWER seq and would win); gating the commit on the live scope makes a
  // load that fetched project A drop its result the moment the user is on B. (#207)
  const liveScope = useRef<string | null>(null)
  // Reorder writes (#210) are SERIALIZED and only the LATEST reloads: a drag fires a
  // fire-and-forget PUT, and over HTTP/2 two rapid drags' PUTs could commit out of order
  // (an intermediate order wins, the final drag lost) or an older call's reload could
  // revert the newer optimistic order. The chain makes each PUT await the previous (server
  // sees them in drag order), and the seq gate means only the newest reorder's reload is
  // authoritative. Optimistic re-rank still happens synchronously, so the UI is instant.
  const reorderChain = useRef<Promise<void>>(Promise.resolve())
  const reorderSeq = useRef(0)

  const projectScope: ProjectScope | null = useMemo(() => {
    if (scope === 'personal') {
      return null
    }
    const p = (projects ?? []).find(
      (pr) => pr.slug === scope || pr.id === scope || pr.aliases?.includes(scope),
    )
    return p
      ? {
          id: p.id,
          slug: p.slug,
          handle: p.handle,
          label: projectLabel(p),
          path: p.path,
          aliases: p.aliases ?? [],
          canonicalScope: p.slug,
        }
      : null
  }, [scope, projects])

  // The scale defaults to the route's scope: a project route focuses the project band,
  // the personal route the (only) personal band. A reset here — keyed to the project
  // identity — also drops a stale project selection when the user switches projects.
  useEffect(() => {
    setActiveScope(projectScope ? 'project' : 'personal')
  }, [projectScope])

  // On a project→project switch the page does not remount (the route has no key), so the
  // previous project's context would linger non-null and render under the new project's
  // header until the reload lands — and a mute click in that window would hit the WRONG
  // (still-visible) note id. Drop the project axis to its skeleton the instant the
  // project identity changes; load() refills it. This runs before the [load] effect
  // below, so `liveScope` is the new scope before any load for it starts — and an
  // in-flight/stale load for the old scope is rejected at commit. Also drop the old
  // project's error tokens so its banner doesn't linger under the new header. (#207)
  useEffect(() => {
    liveScope.current = projectScope?.id ?? null
    setProject(null)
    setProjectMemory(null)
    setFailed((f) => f.filter((x) => x !== 'project memory' && x !== 'project context'))
  }, [projectScope?.id])

  // A bookmarked/stale project scope should not leave the constructor in a dead
  // selection. Wait until projects are loaded, then replace to personal. Legacy
  // id-based URLs from the first Context iteration are canonicalised to slug URLs.
  useEffect(() => {
    if (scope === 'personal' || !projects) {
      return
    }
    if (projectsSpace !== space) {
      return
    }
    if (!projectScope) {
      const remembered = rememberedContextScopeSpace(scope)

      if (remembered && remembered !== space) {
        reportNoteSpace(remembered)
        return
      }
      navigate(agentContextRoute('personal'), { replace: true })
      return
    }
    for (const key of [projectScope.canonicalScope, projectScope.id, ...projectScope.aliases]) {
      rememberContextScopeSpace(key, space)
    }
    if (scope !== projectScope.canonicalScope) {
      navigate(agentContextRoute(projectScope.canonicalScope), { replace: true })
    }
  }, [scope, projects, projectsSpace, projectScope, space, reportNoteSpace, navigate])

  const load = useCallback(async () => {
    // Bail on a stale scope BEFORE consuming a sequence number. A `load` re-fired from a
    // mute/pin finally captured the project it was created on; if the user has since
    // switched away it must not even claim a `seq` — otherwise it would out-number, and
    // so starve, the legitimate load for the now-current project. (#207)
    const myScope = projectScope?.id ?? null

    if (myScope !== liveScope.current) {
      return
    }
    const my = ++seq.current
    const fails: string[] = []

    if (projectScope) {
      // The PROJECT scope (#208): its agent-context (project pins + the embedded personal
      // background curated against Q + the auto index) AND its about-project memory audit
      // (recall-on-demand, the same axis the explorer's MemoryTree shows).
      const [proj, projMem] = await Promise.all([
        api.projectAgentContextGet(space, projectScope.id).catch(() => {
          fails.push('project context')
          return EMPTY_PROJECT
        }),
        // `eager` = the STABLE memory order (#210): muting a project category dims it in
        // place, never reflows it (the default newest-first order would bump a just-muted
        // category to the top, since a mute writes a revision). Mirrors the profile axis.
        api.projectMemoryGet(space, projectScope.id, 'eager').catch(() => {
          fails.push('project memory')
          return [] as MemoryCategory[]
        }),
      ])

      if (my !== seq.current || myScope !== liveScope.current) {
        return
      }
      setProject(proj)
      setProjectMemory(projMem)
      setPersonal(null)
      setFailed(fails)
      return
    }
    const ctx = await api.meAgentContextGet().catch(() => {
      fails.push('personal context')
      return EMPTY_PERSONAL
    })

    if (my !== seq.current || myScope !== liveScope.current) {
      return
    }
    setPersonal(ctx)
    updateContext(ctx)
    setProject(null)
    setProjectMemory(null)
    setFailed(fails)
  }, [space, projectScope, updateContext])

  useEffect(() => {
    void load()
  }, [load])

  // Pinned notes carry only id+title — fetch their previews so a pin card shows a
  // DESCRIPTION (collapsed) and its meta (tags · reading length) on expand, not a
  // bare heading (#165 UX r5). One batch; best-effort. Covers the project pins AND the
  // embedded personal pins (a project route) or the personal pins (a personal route).
  useEffect(() => {
    const setItemIds = (ss: ContextSetView[] | undefined) =>
      (ss ?? []).flatMap((s) => s.items.map((i) => i.noteId))
    const ids = [
      ...(personal?.pins ?? []).map((p) => p.noteId),
      ...(project?.pins ?? []).map((p) => p.noteId),
      ...(project?.personal.pins ?? []).map((p) => p.noteId),
      ...setItemIds(personal?.sets),
      ...setItemIds(project?.sets),
      ...setItemIds(project?.personal.sets),
    ]
    const missing = ids.filter((id) => !(id in previews))

    if (missing.length === 0) {
      return
    }
    let live = true
    api
      .previewsPost(missing)
      .then((res) => {
        if (!live) {
          return
        }
        setPreviews((prev) => {
          const next = { ...prev }

          for (const [id, pv] of Object.entries(res.previews)) {
            next[id] = pv
          }
          // Mark resolved-but-empty ids (null) so we don't refetch them forever.
          for (const id of missing) {
            if (!(id in next)) {
              next[id] = null
            }
          }

          return next
        })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [personal, project, previews])

  // Live freshness: the active space's SSE stream covers project changes; coalesce.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = subscribe((event) => {
      if (event.type !== STORE_EVENT.CHANGED || timer) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        void load()
      }, CHANGED_COALESCE_MS)
    })

    return () => {
      if (timer) {
        clearTimeout(timer)
      }
      unsub()
    }
  }, [subscribe, load])

  // Mute is id-addressed server-side (#207): flip `muted` optimistically wherever the
  // note lives (personal scope, the project's embedded personal, or the project audit),
  // then reload so the server re-curates loaded/trimmed (muting frees budget for others).
  const flipMuted =
    (id: string) =>
    <C extends { noteId: string; muted: boolean }>(c: C): C =>
      c.noteId === id ? { ...c, muted: !c.muted } : c
  const toggleMute = useCallback(
    async (cat: MemoryCategory) => {
      const flip = flipMuted(cat.noteId)
      setPersonal((p) => (p ? { ...p, memory: p.memory.map(flip) } : p))
      setProject((p) =>
        p ? { ...p, personal: { ...p.personal, memory: p.personal.memory.map(flip) } } : p,
      )
      setProjectMemory((m) => (m ? m.map(flip) : m))
      try {
        await api.noteMute(cat.noteId, !cat.muted)
      } catch {
        toast.error('Couldn’t update memory state.')
      } finally {
        void load()
      }
    },
    [toast, load],
  )

  // The caller's sets (with home space, #209) — refreshed on mount + every mutation.
  const reloadSets = useCallback(() => {
    void api
      .contextSetsGet()
      .then(setAllSets)
      .catch(() => {})
  }, [])
  useEffect(() => {
    reloadSets()
  }, [reloadSets])
  const homeSpaceOf = useCallback(
    (setId: string) => allSets.find((s) => s.id === setId)?.homeSpace,
    [allSets],
  )

  // The ACTIVE scope decides where a set attaches + where a NEW set is homed.
  const isProjectScope = activeScope === 'project' && !!projectScope
  const scopeHomeSpace = isProjectScope ? space : (personalSpace?.slug ?? space)
  const attachToScope = useCallback(
    async (id: string) => {
      if (isProjectScope && projectScope) {
        await api.contextSetAttachProject(space, projectScope.id, id)
      } else {
        await api.contextSetAttachPersonal(id)
      }
    },
    [isProjectScope, projectScope, space],
  )

  // Pin the multi-selected notes into the ACTIVE scope (the picker's Notes mode). A note
  // in the scope's OWN space uses the location-bound `always-load` tag (#165); one from
  // ANOTHER space becomes a cross-space scope-pin ref (#209) — same UX, honest mechanism.
  const pinNotes = async (items: Array<{ space: string; noteId: string }>) => {
    setPicker(null)
    try {
      await Promise.all(
        items.map((it) =>
          it.space === scopeHomeSpace
            ? api.notePin(it.noteId, true)
            : isProjectScope && projectScope
              ? api.contextPinAttachProject(space, projectScope.id, it.space, it.noteId)
              : api.contextPinAttachPersonal(it.space, it.noteId),
        ),
      )
    } catch {
      toast.error('Couldn’t pin notes.')
    } finally {
      // `load()` re-curates the scope AND (on the personal scope) feeds the Context pill via
      // updateContext; a project-scope pin never changes the personal pill, so no extra refresh.
      void load()
    }
  }

  // Unpin from the active scope. A cross-space pin (carries `pinSpace`) drops from the
  // scope-pin registry; a same-space pin clears its `always-load` tag. Optimistic drop
  // from whichever list shows it; reload re-curates the budget.
  const unpin = useCallback(
    async (id: string, pinSpace?: string) => {
      setPersonal((p) => (p ? { ...p, pins: p.pins.filter((x) => x.noteId !== id) } : p))
      setProject((p) =>
        p
          ? {
              ...p,
              pins: p.pins.filter((x) => x.noteId !== id),
              personal: { ...p.personal, pins: p.personal.pins.filter((x) => x.noteId !== id) },
            }
          : p,
      )
      try {
        if (pinSpace) {
          // A pure cross-space pin — drop the registry row only; the note lives in ANOTHER
          // space, so we must NOT touch its own-space `always-load` tag.
          if (isProjectScope && projectScope) {
            await api.contextPinDetachProject(space, projectScope.id, id)
          } else {
            await api.contextPinDetachPersonal(id)
          }
        } else {
          // A same-space pin — remove its `always-load` tag (primary). It may ALSO carry a
          // cross-space scope-pin registry row for the same id (dedup hides it on the wire,
          // the tag wins), so best-effort detach that too; else it reappears on reload
          // and the first unpin looks like it silently failed (#209 review).
          await api.notePin(id, false)
          try {
            if (isProjectScope && projectScope) {
              await api.contextPinDetachProject(space, projectScope.id, id)
            } else {
              await api.contextPinDetachPersonal(id)
            }
          } catch {
            // The visible tag pin is already gone; a lingering registry row clears on the next unpin.
          }
        }
      } catch {
        toast.error('Couldn’t unpin note.')
      } finally {
        void load()
      }
    },
    [toast, load, isProjectScope, projectScope, space],
  )

  // Save a set (the picker's Set mode): create-or-reuse, add the cross-space items, attach here.
  const saveSet = async ({ setId, name, items, home: homeIn }: SetSave) => {
    setPicker(null)
    try {
      let id = setId
      // Existing set: address its own home (carried from the view/allSets), never fall back
      // to the active scope's space, which would 404 a cross-space-homed set (#209).
      let home = id ? (homeIn ?? homeSpaceOf(id) ?? scopeHomeSpace) : scopeHomeSpace

      if (!id) {
        const created = await api.contextSetCreate(scopeHomeSpace, name)
        id = created.id
        home = created.homeSpace
      }
      // Attach FIRST so even a partial membership yields a VISIBLE, completable set — never
      // an invisible orphan the user believes failed and re-creates. Then add items
      // best-effort: one deleted/unreachable note can't abort the whole batch (#209 review).
      await attachToScope(id)
      let failedCount = 0

      for (const it of items) {
        try {
          await api.contextSetItemAdd(home, id, it.space, it.noteId)
        } catch {
          failedCount++
        }
      }
      if (failedCount > 0) {
        toast.error(
          `Added the set, but ${failedCount} of ${items.length} note${items.length === 1 ? '' : 's'} couldn’t be added.`,
        )
      }
    } catch {
      toast.error('Couldn’t save the set.')
    } finally {
      reloadSets()
      void load()
    }
  }

  const detachSet = async (set: ContextSetView) => {
    try {
      if (isProjectScope && projectScope) {
        await api.contextSetDetachProject(space, projectScope.id, set.id)
      } else {
        await api.contextSetDetachPersonal(set.id)
      }
    } catch {
      toast.error('Couldn’t detach the set.')
    } finally {
      reloadSets()
      void load()
    }
  }

  // Deleting a set DESTROYS it for every scope it's attached to (not just here) — a
  // destructive act, so confirm it (guards a misclick). Detach/remove are reversible
  // and stay one-click.
  const deleteSet = async (set: ContextSetView) => {
    const ok = await confirm({
      title: `Delete «${set.name}»?`,
      message:
        'This deletes the set everywhere it is attached. The notes themselves are not deleted.',
      confirmLabel: 'Delete set',
      danger: true,
    })

    if (!ok) {
      return
    }
    try {
      // Address CRUD against the set's AUTHORITATIVE home space (carried on the view, #209) —
      // never the active scope's space, which would 404 a cross-space-homed set and make a
      // confirmed Delete silently no-op if the separate sets list were stale.
      await api.contextSetDelete(set.homeSpace, set.id)
    } catch {
      toast.error('Couldn’t delete the set.')
    } finally {
      reloadSets()
      void load()
    }
  }

  const removeSetItem = async (set: ContextSetView, noteId: string) => {
    try {
      await api.contextSetItemRemove(set.homeSpace, set.id, noteId)
    } catch {
      toast.error('Couldn’t remove the note.')
    } finally {
      reloadSets()
      void load()
    }
  }

  // Reorder the pin+set list of a scope (#210): stamp the new `order` locally so the merged
  // list re-sorts INSTANTLY (no snap-back until the reload), persist the whole sequence, then
  // reload so the server re-curates the budget trim in the new order (order = load priority).
  // Run a reorder WRITE serialized behind the prior one (last drag commits last), reloading
  // only if this is still the latest reorder (an older chained call must not revert the newer
  // optimistic order). The optimistic re-rank is done by the caller BEFORE this, synchronously.
  const serializeReorder = (
    write: () => Promise<unknown>,
    errMsg: string,
    alsoReloadSets = false,
  ): void => {
    const mySeq = ++reorderSeq.current
    reorderChain.current = reorderChain.current
      .catch(() => {})
      .then(async () => {
        try {
          await write()
        } catch {
          toast.error(errMsg)
        }
        if (mySeq === reorderSeq.current) {
          if (alsoReloadSets) {
            reloadSets()
          }
          await load()
        }
      })
  }

  const reorderPersonal = (entries: ContextOrderEntry[]) => {
    setPersonal((p) => (p ? { ...p, ...reRankByEntries(p.pins, p.sets, entries) } : p))
    setProject((p) =>
      p
        ? {
            ...p,
            personal: {
              ...p.personal,
              ...reRankByEntries(p.personal.pins, p.personal.sets, entries),
            },
          }
        : p,
    )
    serializeReorder(() => api.contextOrderPersonal(entries), 'Couldn’t save the order.')
  }

  const reorderProject = (entries: ContextOrderEntry[]) => {
    if (!projectScope) {
      return
    }
    setProject((p) => (p ? { ...p, ...reRankByEntries(p.pins, p.sets, entries) } : p))
    serializeReorder(
      () => api.contextOrderProject(space, projectScope.id, entries),
      'Couldn’t save the order.',
    )
  }

  // Reorder the ITEMS inside a set (#210) — a home-space write, so it addresses the set's real
  // home. Optimistic on every list that may show this set (personal + the project's embedded
  // personal + project sets).
  const reorderSetItems = (set: ContextSetView, noteIds: string[]) => {
    const reorder = (s: ContextSetView): ContextSetView =>
      s.id === set.id ? { ...s, items: orderItemsBy(s.items, noteIds) } : s
    setPersonal((p) => (p ? { ...p, sets: p.sets.map(reorder) } : p))
    setProject((p) =>
      p
        ? {
            ...p,
            sets: p.sets.map(reorder),
            personal: { ...p.personal, sets: p.personal.sets.map(reorder) },
          }
        : p,
    )
    serializeReorder(
      () => api.contextSetItemsOrder(set.homeSpace, set.id, noteIds),
      'Couldn’t reorder the set.',
      true,
    )
  }

  const scopeGroups = useMemo<SettingsTab[][]>(() => {
    // The personal domain's ROOT project collapses its handle to the space, but its
    // slug is `personal` — which collides with the reserved Personal tab id (a
    // duplicate React key + a redundant "Space root" tab that just re-routes to
    // Personal). Drop that collision so the reserved tab is the single source.
    const projectTabs = (projects ?? [])
      .filter((p) => p.slug !== 'personal')
      .map((p) => ({
        id: p.slug,
        label: projectLabel(p),
        icon: <IconFolderKanban size={14} />,
      }))
    return projectTabs.length
      ? [[{ id: 'personal', label: 'Personal', icon: <IconUser size={14} /> }], projectTabs]
      : [[{ id: 'personal', label: 'Personal', icon: <IconUser size={14} /> }]]
  }, [projects])

  // The eager memory lists as MemoryItems (state from the SERVER's loaded flags, #208), in
  // the server's STABLE order — NOT re-sorted by state (#210): muting dims a row in place,
  // it never jumps to the bottom. The personal one is P-curated on a personal route and
  // Q-embedded on a project route; the project audit has no budget (recall-on-demand).
  const scopeMemoryItems = (memory: ContextMemory[] | undefined): MemoryItem[] | null =>
    memory ? memory.map((cat) => ({ cat, state: memoryState(cat) })) : null
  const auditMemoryItems = (memory: MemoryCategory[] | null): MemoryItem[] | null =>
    memory ? memory.map((cat) => ({ cat, state: cat.muted ? 'muted' : 'loaded' })) : null

  const projectMemoryTokens = useMemo(
    () => (projectMemory ?? []).reduce((sum, c) => sum + (c.muted ? 0 : c.tokens), 0),
    [projectMemory],
  )

  // The aggregate context load (#208): ONE scale = the active scope's SINGLE budget. On
  // a project route the current PROJECT band leads, then the embedded PERSONAL, both
  // against Q; on the personal route, Personal alone against P. loaded ≤ budget always,
  // so the bar is strictly the budget with headroom — never over.
  const aggregate = useMemo(() => {
    if (projectScope) {
      if (!project) {
        return null
      }
      const scopes: ScopeCard[] = [
        {
          key: 'project',
          label: projectScope.label,
          loaded: project.projectLoadedTokens,
          trimmed: pinsTrimmed(project.pins) + setsTrimmed(project.sets),
        },
        {
          key: 'personal',
          label: 'Personal',
          loaded: project.personal.loadedTokens,
          trimmed:
            pinsTrimmed(project.personal.pins) +
            setsTrimmed(project.personal.sets) +
            memoryTrimmed(project.personal.memory),
        },
      ]
      return { scopes, totalLoaded: project.loadedTokens, budgetTokens: project.budgetTokens }
    }
    if (!personal) {
      return null
    }

    return {
      scopes: [
        {
          key: 'personal',
          label: 'Personal',
          loaded: personal.loadedTokens,
          trimmed:
            pinsTrimmed(personal.pins) +
            setsTrimmed(personal.sets) +
            memoryTrimmed(personal.memory),
        } as ScopeCard,
      ],
      totalLoaded: personal.loadedTokens,
      budgetTokens: personal.budgetTokens,
    }
  }, [projectScope, project, personal])

  const personalPinIds = useMemo(
    () =>
      new Set([...(personal?.pins ?? []), ...(project?.personal.pins ?? [])].map((p) => p.noteId)),
    [personal, project],
  )
  const projectPinIds = useMemo(
    () => new Set((project?.pins ?? []).map((p) => p.noteId)),
    [project],
  )
  const openMemoryNote = useCallback(
    (id: string) => {
      const href = memoryNoteRoute(id)

      if (href) {
        navigate(href)
      }
    },
    [navigate],
  )
  const openPinnedNote = useCallback(
    (id: string) => {
      const href = noteRoute(id)

      if (href) {
        navigate(href, { state: { preserveSpaceOnNoteOpen: space } })
      }
    },
    [navigate, space],
  )

  // The PERSONAL panel (Profile) — used on the personal route (P-curated) AND, on a
  // project route, under the Personal tab (the embedded personal, Q-curated). Same
  // component, different source + budget; the personal context is never duplicated.
  const personalScope = projectScope ? project?.personal : personal
  const personalBudget = projectScope ? (project?.budgetTokens ?? 0) : (personal?.budgetTokens ?? 0)

  // The readable spaces (personal first) feed the picker's cross-space set-item selector.
  const spaceOptions = useMemo(() => {
    const opts: Array<{ slug: string; label: string }> = []

    if (personalSpace) {
      opts.push({ slug: personalSpace.slug, label: personalSpace.displayName || 'Personal' })
    }
    for (const s of (allSpaces ?? []) as Space[]) {
      if (!opts.some((o) => o.slug === s.slug)) {
        opts.push({ slug: s.slug, label: s.displayName || s.slug })
      }
    }

    return opts
  }, [allSpaces, personalSpace])
  // Sets attachable to the ACTIVE scope: a personal-homed set can't feed a project (#209).
  const attachableSets = useMemo(
    () => allSets.filter((s) => (isProjectScope ? !s.personal : true)),
    [allSets, isProjectScope],
  )
  const attachedSetIds = useMemo(
    () => new Set(((isProjectScope ? project?.sets : personalScope?.sets) ?? []).map((s) => s.id)),
    [isProjectScope, project, personalScope],
  )
  // Shared set handlers for whichever panel is showing (they act on the active scope).
  const pinsBlockSetProps = {
    onAddNotesToSet: (set: ContextSetView) =>
      setPicker({ addToSetId: set.id, addToSetHome: set.homeSpace }),
    onDetachSet: detachSet,
    onDeleteSet: deleteSet,
    onRemoveItem: removeSetItem,
    onReorderSetItems: reorderSetItems,
  }

  const profileSection = (
    <section className={styles.section} data-testid="context-profile">
      {/* Pins + sets in ONE list (#209): a set is a badged, expandable row. Add via the
          one multi-select picker (pin notes or build a set) — no separate manager. */}
      <PinsBlock
        pins={personalScope?.pins ?? null}
        sets={personalScope?.sets ?? null}
        previews={previews}
        scale={personalBudget}
        onAdd={() => setPicker({})}
        onOpen={openPinnedNote}
        onUnpin={unpin}
        onReorder={reorderPersonal}
        {...pinsBlockSetProps}
        emptyHint="Pin a note — or build a reusable set — that should always be in the profile context."
        addTestId="context-add-personal-pin"
        listTestId="context-personal-pins"
      />

      <MemoryBlock
        items={scopeMemoryItems(personalScope?.memory)}
        variant="profile"
        scale={personalBudget}
        failed={failed.includes('personal context')}
        onOpenNote={openMemoryNote}
        onToggleMute={toggleMute}
        testIdBase="context-memory"
      />
    </section>
  )

  const projectSection = projectScope ? (
    <section className={styles.section} data-testid="context-project">
      <PinsBlock
        pins={project?.pins ?? null}
        sets={project?.sets ?? null}
        previews={previews}
        scale={project?.budgetTokens ?? 0}
        onAdd={() => setPicker({})}
        onOpen={openPinnedNote}
        onUnpin={unpin}
        onReorder={reorderProject}
        {...pinsBlockSetProps}
        emptyHint="Pin a project note — or attach a reusable set — that should always be in this project context."
        addTestId="context-add-project-pin"
        listTestId="context-project-pins"
      />

      <MemoryBlock
        items={auditMemoryItems(projectMemory)}
        variant="project"
        scale={projectMemoryTokens}
        recallTokens={projectMemoryTokens}
        failed={failed.includes('project memory')}
        onOpenNote={openMemoryNote}
        onToggleMute={toggleMute}
        testIdBase="context-project-memory"
      />

      <div className={styles.block}>
        <div className={styles.blockHead}>
          <IconFolderKanban size={13} />
          <span>Auto</span>
        </div>
        {project && (
          <p className={styles.auto} data-testid="context-auto">
            <Chip>{project.index.noteCount} notes</Chip>
            <Chip>{project.index.folderCount} folders</Chip>
            <span className={styles.muted}>+ recent changes</span>
          </p>
        )}
      </div>
    </section>
  ) : null

  return (
    <SettingsLayout
      trail={[{ label: 'Agents' }, { label: 'Context' }]}
      spaceLess
      sectionTabs={<AgentsTabs active="context" />}
      groups={scopeGroups}
      routeFor={agentContextRoute}
      testIdPrefix="context-scope"
    >
      <div className={styles.page} data-testid="agents-context">
        <div className={styles.inner}>
          <header className={styles.pageHead}>
            <h1 className={styles.pageTitle}>Context constructor</h1>
            <p className={styles.pageSub}>
              What an agent carries into every session before it starts — your pinned notes and the
              memory it keeps about you, under one token budget. Curate it here so the agent always
              has the right background, and nothing it doesn’t.
            </p>
          </header>

          {/* Reserve the meter's exact box while the scope loads, so the blocks below don't
              jump when it appears; a load failure shows the notice instead (no skeleton). */}
          {aggregate
            ? aggregate.budgetTokens > 0 && (
                <AggregateBar
                  scopes={aggregate.scopes}
                  totalLoaded={aggregate.totalLoaded}
                  budgetTokens={aggregate.budgetTokens}
                  activeScope={activeScope}
                  onSelect={setActiveScope}
                  testId="context-aggregate"
                />
              )
            : failed.length === 0 && <AggregateBarSkeleton />}

          {failed.length > 0 && (
            <Notice variant="error" data-testid="context-error">
              Couldn’t load {failed.join(', ')}.
            </Notice>
          )}

          {/* One scale up top; below it only the SELECTED scope's panels. Selecting the
              Personal tab switches to it inline (its band lights, its panels replace the
              project's) — the personal context is never duplicated as a second panel. */}
          {activeScope === 'project' && projectScope ? projectSection : profileSection}
        </div>
      </div>

      {picker && (
        <PinPicker
          space={isProjectScope && projectScope ? space : (personalSpace?.slug ?? space)}
          folder={isProjectScope && projectScope ? projectScope.path : undefined}
          excludeIds={isProjectScope ? projectPinIds : personalPinIds}
          spaceOptions={spaceOptions}
          sets={attachableSets}
          attachedSetIds={attachedSetIds}
          initialSetId={picker.addToSetId}
          initialSetHome={picker.addToSetHome}
          onPinNotes={pinNotes}
          onSaveSet={saveSet}
          onClose={() => setPicker(null)}
        />
      )}
    </SettingsLayout>
  )
}
