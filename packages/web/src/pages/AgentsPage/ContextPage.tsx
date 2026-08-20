import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import type {
  ContextMemory,
  ContextOrderEntry,
  ContextSet,
  MeAgentContext,
  MemoryCategory,
  MeRoleContext,
  Preview,
  ProjectAgentContext,
  RoleContextView,
  RoleInactiveReason,
  Space,
} from '@notarium/contract'
import { STORE_EVENT } from '@notarium/contract/events'
import { HTTP_STATUS } from '@notarium/contract/http'
import { encodeAbilityLocator } from '@notarium/core'
import { useProjects } from '../../composers/ProjectsProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { CHANGED_COALESCE_MS, useSync } from '../../composers/SyncProvider'
import { Chip } from '../../core/Chips'
import { useDialog } from '../../core/Dialog'
import { IconFolderKanban } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { Select } from '../../core/Select'
import { useToast } from '../../core/Toast'
import { agentContextRoute, memoryNoteRoute, noteRoute } from '../../libs/routing/routePaths'
import { api, ApiError } from '../../services/api'
import { useAgentsShell, useAgentsSummary } from './AgentsProvider'
import { EMPTY_PERSONAL, EMPTY_PROJECT } from './consts'
import { AggregateBar } from './ContextMeters'
import { AggregateBarSkeleton } from './ContextSkeletons'
import { orderSetItemsIn, reRankByEntries } from './helpers/contextOrder'
import { CONTEXT_ROLE_PARAM } from './helpers/contextScope'
import { memoryState, memoryTrimmed, pinsTrimmed, setsTrimmed } from './helpers/contextTrim'
import { projectLabel } from './helpers/format'
import { roleLayerRows } from './helpers/roleLayer'
import { rememberContextScopeSpace, rememberedContextScopeSpace } from './helpers/scopeStorage'
import { MemoryBlock } from './MemoryBlock'
import { PinPicker } from './PinPicker'
import { PinsBlock } from './PinsBlock'
import type {
  ContextSetRowView,
  MemoryItem,
  ProjectScope,
  ScopeCard,
  ScopeKey,
  SetSave,
} from './types'
import styles from './ContextPage.module.scss'

// The Context constructor (#165/#208): the control surface for what an agent loads
// before work — a flexible TOKEN-BUDGET tool, not a passive payload dump.
//
// The whole eager cost is ONE token scale, ONE budget per SCOPE. PERSONAL has a
// budget P (pins + memory share it). A PROJECT has a budget Q, and the personal
// background EMBEDS into it: an optional Role loads first, then the project's own
// context, and personal fills whatever of Q remains. So a project route shows a
// single Q-wide scale with Role → Project → Personal bands (two without a role),
// plus a clickable tab per scope that swaps the panels below. The server
// curates the loaded/trimmed split (one shared scan with start_session), so the pult
// shows EXACTLY what the agent loads — the web never re-derives the trim. Because a
// scope is ONE budget, the scale can never read "budget still free, yet trimming".
// Every note carries a weight meter (its share of the scope budget) so the fattest —
// the ones worth trimming — stand out.

/** Resolution order, and therefore reading order: the role that would actually win
 *  in this context is listed first. */
const ROLE_SCOPE_ORDER = ['project', 'space', 'personal'] as const
const ROLE_SCOPE_CAPTION: Record<string, string> = {
  project: 'From this project',
  space: 'From the space',
  personal: 'Personal',
}

/** Why the agent does not load the addressed role HERE (#309) — one sentence per cause,
 *  because the three are not the same news to the person reading them, and each closes
 *  the same way: the layer below is still theirs to change. Editing a shared role is a
 *  question about the space; whether this reader happens to load it is not.
 *
 *  `out-of-reach` is deliberately the vaguer of the three, because the reason word covers
 *  both halves of reach — a placement this context never visits (a Project role addressed
 *  from Personal) and a Space role narrowed away from this project. Naming only the second
 *  would be the more useful sentence and a false one half the time. */
const ROLE_INACTIVE_NOTICE: Record<RoleInactiveReason, string> = {
  disabled:
    'You switched this role off for yourself, so the agent won’t load it here. What it loads is still yours to change.',
  'out-of-reach':
    'This role belongs to a scope this context doesn’t reach, so the agent won’t load it here. What it loads is still yours to change.',
  unhealthy:
    'This role’s attachments no longer resolve, so a session refuses to raise it. What it loads is still yours to change.',
}

export const ContextPage = () => {
  const { space, spaces: allSpaces, personalSpace, reportNoteSpace, canWrite } = useSpace()
  const { projects, projectsSpace } = useProjects()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const toast = useToast()
  const { confirm } = useDialog()
  const { scope: routeScope } = useParams()
  const { subscribe } = useSync()
  const { updateContext } = useAgentsSummary()
  const { setBreadcrumbTail } = useAgentsShell()

  const scope = routeScope ?? 'personal'
  const selectedRoleLocator = searchParams.get(CONTEXT_ROLE_PARAM) ?? ''
  // The eager scope as the SERVER curated it (#208): `personal` is the personal-route
  // scope (budget P); `project` carries the project pins AND the embedded personal
  // (budget Q); `projectMemory` is the about-project audit (recall-on-demand, #207).
  const [personal, setPersonal] = useState<MeAgentContext | null>(null)
  const [project, setProject] = useState<ProjectAgentContext | null>(null)
  // The IDENTITY of the addressed role (#309): which role it is, its own EDITABLE layer,
  // and whether the agent would load it where we stand. A separate door from the preview
  // above, because the preview answers only "what does the agent load here, at what cost"
  // and therefore omits a role it does not load — which is not an answer to "which role
  // does this address name, and may I configure it". `roleUnnamed` is the ONE way an
  // address can name nothing: that door's 404.
  const [roleIdentity, setRoleIdentity] = useState<MeRoleContext | null>(null)
  const [roleUnnamed, setRoleUnnamed] = useState(false)
  const [loadedContextKey, setLoadedContextKey] = useState<string | null>(null)
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
  // The exact project+role selection a commit is allowed to land under. `seq` alone cannot guard a
  // STALE re-invocation of `load` (a finally that captured an old project's closure
  // gets a NEWER seq and would win); gating the commit on the live scope makes a
  // load that fetched project A drop its result the moment the user is on B. (#207)
  const liveContextKey = useRef('')
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
  const scopeIdentity = projectScope?.id ?? (scope === 'personal' ? 'personal' : 'pending')
  const requestContextKey = `${scopeIdentity}\u0000${selectedRoleLocator}`
  const contextIsCurrent = loadedContextKey === requestContextKey
  const loadedScopeIdentity = loadedContextKey?.split('\u0000', 1)[0]

  // A role switch is a new curation request even inside the same project. Keep the old
  // inventory available to the selector (so A → B can be immediate), but make its panels
  // non-interactive until the matching response lands. Closing a picker prevents a dialog
  // opened for A from saving into B after URL navigation.
  useEffect(() => {
    liveContextKey.current = requestContextKey
    setPicker(null)
    setFailed((current) =>
      current.filter((item) => item !== 'personal context' && item !== 'project context'),
    )
  }, [requestContextKey])

  // The scale defaults to the route's scope: a project route focuses the project band,
  // the personal route the (only) personal band. A reset here — keyed to the project
  // identity — also drops a stale project selection when the user switches projects.
  useEffect(() => {
    setActiveScope(selectedRoleLocator ? 'role' : projectScope ? 'project' : 'personal')
  }, [projectScope, selectedRoleLocator])

  // On a project→project switch the page does not remount (the route has no key), so the
  // previous project's context would linger non-null and render under the new project's
  // header until the reload lands — and a mute click in that window would hit the WRONG
  // (still-visible) note id. Drop the project axis to its skeleton the instant the
  // project identity changes; load() refills it. This runs before the [load] effect
  // below, so `liveContextKey` is current before any load for it starts — and an
  // in-flight/stale load for the old scope is rejected at commit. Also drop the old
  // project's error tokens so its banner doesn't linger under the new header. (#207)
  useEffect(() => {
    setProjectMemory(null)
    setFailed((f) => f.filter((x) => x !== 'project memory'))
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
      const search = searchParams.toString()
      navigate(`${agentContextRoute('personal')}${search ? `?${search}` : ''}`, { replace: true })
      return
    }
    for (const key of [projectScope.canonicalScope, projectScope.id, ...projectScope.aliases]) {
      rememberContextScopeSpace(key, space)
    }
    if (scope !== projectScope.canonicalScope) {
      const search = searchParams.toString()
      navigate(`${agentContextRoute(projectScope.canonicalScope)}${search ? `?${search}` : ''}`, {
        replace: true,
      })
    }
  }, [scope, projects, projectsSpace, projectScope, space, reportNoteSpace, navigate, searchParams])

  const load = useCallback(async () => {
    // A project deep-link renders before ProjectsProvider has resolved its slug. Do not
    // briefly treat that unresolved project route as Personal: that can flash a same-name
    // personal role preset, then remove it while the real project preview is loading.
    if (scope !== 'personal' && !projectScope) {
      return
    }
    // Bail on a stale scope BEFORE consuming a sequence number. A `load` re-fired from a
    // mute/pin finally captured the project it was created on; if the user has since
    // switched away it must not even claim a `seq` — otherwise it would out-number, and
    // so starve, the legitimate load for the now-current project. (#207)
    const myContextKey = requestContextKey

    if (myContextKey !== liveContextKey.current) {
      return
    }
    const my = ++seq.current
    const fails: string[] = []
    // Asked beside the preview, never derived from it: a role the agent does not load
    // here is still a role this page configures, and only a 404 means the address names
    // none. `project` is where the caller stands, because reach is a question about one.
    const askIdentity = (): Promise<{ named: MeRoleContext | null; unnamed: boolean }> =>
      selectedRoleLocator
        ? api
            .meRoleContextGet(selectedRoleLocator, projectScope?.id)
            .then((named) => ({ named, unnamed: false }))
            .catch((err: unknown) => {
              const unnamed = err instanceof ApiError && err.status === HTTP_STATUS.NOT_FOUND

              if (!unnamed) {
                fails.push('role context')
              }

              return { named: null, unnamed }
            })
        : Promise.resolve({ named: null, unnamed: false })

    if (projectScope) {
      // The PROJECT scope (#208): its agent-context (project pins + the embedded personal
      // background curated against Q + the auto index) AND its about-project memory audit
      // (recall-on-demand, the same axis the explorer's MemoryTree shows).
      const [proj, projMem, identity] = await Promise.all([
        api
          .projectAgentContextGet(space, projectScope.id, selectedRoleLocator || undefined)
          .catch(() => {
            fails.push('project context')
            return EMPTY_PROJECT
          }),
        // `eager` = the STABLE memory order (#210): muting a project category dims it in
        // place, never reflows it (the default newest-first order would bump a just-muted
        // category to the top, since a mute writes a revision). Mirrors the profile axis.
        api.projectMemoryGet(space, projectScope.id, { order: 'eager' }).catch(() => {
          fails.push('project memory')
          return [] as MemoryCategory[]
        }),
        askIdentity(),
      ])

      if (my !== seq.current || myContextKey !== liveContextKey.current) {
        return
      }
      setProject(proj)
      setProjectMemory(projMem)
      setPersonal(null)
      setRoleIdentity(identity.named)
      setRoleUnnamed(identity.unnamed)
      setLoadedContextKey(myContextKey)
      setFailed(fails)
      return
    }
    const [ctx, identity] = await Promise.all([
      api.meAgentContextGet(selectedRoleLocator || undefined).catch(() => {
        fails.push('personal context')
        return EMPTY_PERSONAL
      }),
      askIdentity(),
    ])

    if (my !== seq.current || myContextKey !== liveContextKey.current) {
      return
    }
    setPersonal(ctx)
    updateContext(ctx)
    setProject(null)
    setProjectMemory(null)
    setRoleIdentity(identity.named)
    setRoleUnnamed(identity.unnamed)
    setLoadedContextKey(myContextKey)
    setFailed(fails)
  }, [scope, space, projectScope, selectedRoleLocator, requestContextKey, updateContext])

  useEffect(() => {
    void load()
  }, [load])

  // Pinned notes carry only id+title — fetch their previews so a pin card shows a
  // DESCRIPTION (collapsed) and its meta (tags · reading length) on expand, not a
  // bare heading (#165 UX r5). One batch; best-effort. Covers the project pins AND the
  // embedded personal pins (a project route) or the personal pins (a personal route).
  useEffect(() => {
    const setItemIds = (ss: ContextSetRowView[] | undefined) =>
      (ss ?? []).flatMap((s) => s.items.map((i) => i.noteId))
    const ids = [
      ...(personal?.pins ?? []).map((p) => p.noteId),
      ...(project?.pins ?? []).map((p) => p.noteId),
      ...(project?.personal.pins ?? []).map((p) => p.noteId),
      // The role rows come from the identity door, so its layer is what needs previews.
      ...(roleIdentity?.role.pins ?? []).map((p) => p.noteId),
      ...setItemIds(personal?.sets),
      ...setItemIds(project?.sets),
      ...setItemIds(project?.personal.sets),
      ...setItemIds(roleIdentity?.role.sets),
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
  }, [personal, project, roleIdentity, previews])

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
  const previewFailure = projectScope ? 'project context' : 'personal context'
  const contextLoadFailed = contextIsCurrent && failed.includes(previewFailure)
  const currentPersonal = contextIsCurrent && !contextLoadFailed ? personal : null
  const currentProject = contextIsCurrent && !contextLoadFailed ? project : null
  const currentPreview = projectScope ? currentProject : currentPersonal
  const contextReady = currentPreview !== null
  // The two halves of one addressed role, kept apart on purpose (#309). `roleLayer` is
  // the identity door's answer — WHICH role and WHAT is in it, the thing this page edits.
  // `roleWeighed` is the preview's — present only when the agent loads it here, and the
  // only source allowed to say what any of it costs.
  const namedRole = contextIsCurrent ? roleIdentity : null
  const roleLayer = namedRole?.role
  const roleWeighed: RoleContextView | undefined = projectScope
    ? currentProject?.role
    : currentPersonal?.role
  const roleInactive = namedRole && !namedRole.active ? namedRole.inactive : undefined
  const roleRows = useMemo(
    () => (roleLayer ? roleLayerRows(roleLayer, roleWeighed) : null),
    [roleLayer, roleWeighed],
  )

  useEffect(() => {
    setBreadcrumbTail(roleLayer ? { label: roleLayer.title ?? roleLayer.name } : null)
    return () => setBreadcrumbTail(null)
  }, [roleLayer, setBreadcrumbTail])
  const isRoleScope = activeScope === 'role' && !!selectedRoleLocator && !!roleLayer
  const isProjectScope = activeScope === 'project' && !!projectScope
  // Whether a shared role's context may be CHANGED is a question about the space — not
  // about whether this reader happens to load it. All three inactive causes stay editable.
  const roleEditable = !!roleLayer && (roleLayer.scope === 'personal' || canWrite)
  // An address stops naming a role for exactly ONE reason: there is nothing to name, and
  // the identity door spells that as a 404. Absence from the preview is not that reason —
  // it says the agent does not load this role here, which is a different sentence and
  // gets its own one below. Reading it as this one is what threw a member out of the page
  // that configures the shared role they had switched off for themselves.
  const roleSelectionUnavailable = !!selectedRoleLocator && contextIsCurrent && roleUnnamed
  const scopeHomeSpace = isRoleScope
    ? roleLayer.scope === 'personal'
      ? (personalSpace?.slug ?? space)
      : roleLayer.space
    : isProjectScope
      ? space
      : (personalSpace?.slug ?? space)

  // A bookmark can outlive an owned role placement. The server intentionally answers with
  // the safe base preview; normalize the URL before exposing any base mutation controls so a
  // role-intent can never silently write Personal/Project instead.
  useEffect(() => {
    if (!roleSelectionUnavailable) {
      return
    }
    const next = new URLSearchParams(searchParams)
    next.delete(CONTEXT_ROLE_PARAM)
    setSearchParams(next, { replace: true })
    setActiveScope(projectScope ? 'project' : 'personal')
    toast.warning('That role is no longer available here. Showing base context.')
  }, [roleSelectionUnavailable, searchParams, setSearchParams, projectScope, toast])
  const attachToScope = useCallback(
    async (id: string) => {
      if (isRoleScope) {
        await api.contextSetAttachRole(selectedRoleLocator, id)
      } else if (isProjectScope && projectScope) {
        await api.contextSetAttachProject(space, projectScope.id, id)
      } else {
        await api.contextSetAttachPersonal(id)
      }
    },
    [isRoleScope, selectedRoleLocator, isProjectScope, projectScope, space],
  )

  // Pin the multi-selected notes into the ACTIVE scope (the picker's Notes mode). A note
  // in the scope's OWN space uses the location-bound `always-load` tag (#165); one from
  // ANOTHER space becomes a cross-space scope-pin ref (#209) — same UX, honest mechanism.
  const pinNotes = async (items: Array<{ space: string; noteId: string }>) => {
    setPicker(null)
    try {
      await Promise.all(
        items.map((it) =>
          isRoleScope
            ? api.contextPinAttachRole(selectedRoleLocator, it.space, it.noteId)
            : it.space === scopeHomeSpace
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
      const without = <P extends { noteId: string }>(pins: P[]) =>
        pins.filter((x) => x.noteId !== id)
      setPersonal((p) => (p ? { ...p, pins: without(p.pins) } : p))
      setProject((p) =>
        p
          ? {
              ...p,
              pins: without(p.pins),
              personal: { ...p.personal, pins: without(p.personal.pins) },
            }
          : p,
      )
      // The role's rows come from the identity door, so the optimistic drop belongs to
      // ITS copy of the layer — dropping it from the preview instead would leave the row
      // on screen until the reload landed.
      setRoleIdentity((r) => (r ? { ...r, role: { ...r.role, pins: without(r.role.pins) } } : r))
      try {
        if (isRoleScope) {
          await api.contextPinDetachRole(selectedRoleLocator, id)
        } else if (pinSpace) {
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
    [toast, load, isRoleScope, selectedRoleLocator, isProjectScope, projectScope, space],
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

  const detachSet = async (set: ContextSetRowView) => {
    try {
      if (isRoleScope) {
        await api.contextSetDetachRole(selectedRoleLocator, set.id)
      } else if (isProjectScope && projectScope) {
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
  const deleteSet = async (set: ContextSetRowView) => {
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

  const removeSetItem = async (set: ContextSetRowView, noteId: string) => {
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

  const reorderRole = (entries: ContextOrderEntry[]) => {
    if (!selectedRoleLocator || !roleLayer) {
      return
    }
    setRoleIdentity((r) =>
      r ? { ...r, role: { ...r.role, ...reRankByEntries(r.role.pins, r.role.sets, entries) } } : r,
    )
    serializeReorder(
      () => api.contextOrderRole(selectedRoleLocator, entries),
      'Couldn’t save the role order.',
    )
  }

  // Reorder the ITEMS inside a set (#210) — a home-space write, so it addresses the set's real
  // home. Optimistic on every list that may show this set (personal + the project's embedded
  // personal + project sets).
  const reorderSetItems = (set: ContextSetRowView, noteIds: string[]) => {
    const reorder = <I extends { noteId: string }, S extends { id: string; items: I[] }>(
      sets: S[],
    ): S[] => orderSetItemsIn(sets, set.id, noteIds)
    setPersonal((p) => (p ? { ...p, sets: reorder(p.sets) } : p))
    setProject((p) =>
      p
        ? {
            ...p,
            sets: reorder(p.sets),
            personal: { ...p.personal, sets: reorder(p.personal.sets) },
          }
        : p,
    )
    setRoleIdentity((r) => (r ? { ...r, role: { ...r.role, sets: reorder(r.role.sets) } } : r))
    serializeReorder(
      () => api.contextSetItemsOrder(set.homeSpace, set.id, noteIds),
      'Couldn’t reorder the set.',
      true,
    )
  }

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

  // The role band (#309): a TAB whenever a role is addressed — the panel below has to
  // stay reachable after a click on Personal — but a WEIGHT only from the door that
  // weighed one. A role the agent does not load here costs this budget nothing, and the
  // band says exactly that with a zero instead of by quietly taking a slice of the bar.
  const roleBand: ScopeCard[] = useMemo(
    () =>
      roleLayer
        ? [
            {
              key: 'role',
              label: `Role · ${roleLayer.title}`,
              loaded: roleWeighed?.loadedTokens ?? 0,
              trimmed: roleWeighed
                ? pinsTrimmed(roleWeighed.pins) + setsTrimmed(roleWeighed.sets)
                : 0,
            },
          ]
        : [],
    [roleLayer, roleWeighed],
  )

  // The aggregate context load (#208): ONE scale = the active scope's SINGLE budget. On
  // a project route the current PROJECT band leads, then the embedded PERSONAL, both
  // against Q; on the personal route, Personal alone against P. loaded ≤ budget always,
  // so the bar is strictly the budget with headroom — never over.
  const aggregate = useMemo(() => {
    if (projectScope) {
      if (!currentProject) {
        return null
      }
      const scopes: ScopeCard[] = [
        ...roleBand,
        {
          key: 'project',
          label: projectScope.label,
          loaded: currentProject.projectLoadedTokens,
          trimmed: pinsTrimmed(currentProject.pins) + setsTrimmed(currentProject.sets),
        },
        {
          key: 'personal',
          label: 'Personal',
          loaded: currentProject.personal.loadedTokens,
          trimmed:
            pinsTrimmed(currentProject.personal.pins) +
            setsTrimmed(currentProject.personal.sets) +
            memoryTrimmed(currentProject.personal.memory),
        },
      ]
      return {
        scopes,
        totalLoaded: currentProject.loadedTokens,
        budgetTokens: currentProject.budgetTokens,
      }
    }
    if (!currentPersonal) {
      return null
    }
    const roleLoaded = roleWeighed?.loadedTokens ?? 0

    return {
      scopes: [
        ...roleBand,
        {
          key: 'personal',
          label: 'Personal',
          loaded: Math.max(0, currentPersonal.loadedTokens - roleLoaded),
          trimmed:
            pinsTrimmed(currentPersonal.pins) +
            setsTrimmed(currentPersonal.sets) +
            memoryTrimmed(currentPersonal.memory),
        } as ScopeCard,
      ],
      totalLoaded: currentPersonal.loadedTokens,
      budgetTokens: currentPersonal.budgetTokens,
    }
  }, [projectScope, currentProject, currentPersonal, roleBand, roleWeighed])

  const personalPinIds = useMemo(
    () =>
      new Set(
        [...(currentPersonal?.pins ?? []), ...(currentProject?.personal.pins ?? [])].map(
          (pin) => pin.noteId,
        ),
      ),
    [currentPersonal, currentProject],
  )
  const projectPinIds = useMemo(
    () => new Set((currentProject?.pins ?? []).map((pin) => pin.noteId)),
    [currentProject],
  )
  const rolePinIds = useMemo(
    () => new Set((roleLayer?.pins ?? []).map((pin) => pin.noteId)),
    [roleLayer],
  )
  const openMemoryNote = useCallback(
    (id: string) => {
      const href = memoryNoteRoute(id, undefined, projectScope?.canonicalScope ?? 'personal')

      if (href) {
        navigate(href)
      }
    },
    [navigate, projectScope],
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
  const personalScope = projectScope ? currentProject?.personal : currentPersonal
  const personalBudget = projectScope
    ? (currentProject?.budgetTokens ?? 0)
    : (currentPersonal?.budgetTokens ?? 0)

  const roleOptions = useMemo(() => {
    const rolesFromCurrentScope = loadedScopeIdentity === scopeIdentity
    const availableRoles = rolesFromCurrentScope
      ? projectScope
        ? (project?.roles ?? [])
        : (personal?.roles ?? [])
      : []
    // Grouped by where a role comes from, in the order resolution prefers them
    // (Project beats Space beats Personal). The caption states the scope once, so a
    // role reads as its own name instead of "name · Scope".
    const grouped = ROLE_SCOPE_ORDER.flatMap((roleScope) =>
      availableRoles
        .filter((role) => role.scope === roleScope)
        .map((role) => ({
          value: encodeAbilityLocator(role.locator),
          label: role.title,
          group: ROLE_SCOPE_CAPTION[roleScope],
        })),
    )
    const options = [{ value: '', label: 'Base context' }, ...grouped]

    if (
      selectedRoleLocator &&
      !availableRoles.some((role) => encodeAbilityLocator(role.locator) === selectedRoleLocator)
    ) {
      options.push(
        roleLayer
          ? {
              value: selectedRoleLocator,
              label: roleLayer.title,
              group: ROLE_SCOPE_CAPTION[roleLayer.scope] ?? 'Unavailable',
            }
          : { value: selectedRoleLocator, label: 'Unavailable role', group: 'Unavailable' },
      )
    }

    return options
  }, [
    loadedScopeIdentity,
    scopeIdentity,
    projectScope,
    project?.roles,
    personal?.roles,
    selectedRoleLocator,
    roleLayer,
  ])

  const selectRole = (locator: string) => {
    const next = new URLSearchParams(searchParams)

    if (locator) {
      next.set(CONTEXT_ROLE_PARAM, locator)
    } else {
      next.delete(CONTEXT_ROLE_PARAM)
    }
    setSearchParams(next, { replace: true })
    setActiveScope(locator ? 'role' : projectScope ? 'project' : 'personal')
  }

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
  // Sets attachable to the ACTIVE scope: personal data cannot feed a shared project/role.
  const sharedRoleScope = isRoleScope && roleLayer?.scope !== 'personal'
  const attachableSets = useMemo(
    () => allSets.filter((s) => (isProjectScope || sharedRoleScope ? !s.personal : true)),
    [allSets, isProjectScope, sharedRoleScope],
  )
  const attachedSetIds = useMemo(
    () =>
      new Set(
        (
          (isRoleScope
            ? roleLayer.sets
            : isProjectScope
              ? currentProject?.sets
              : personalScope?.sets) ?? []
        ).map((set) => set.id),
      ),
    [isRoleScope, roleLayer, isProjectScope, currentProject, personalScope],
  )
  // Shared set handlers for whichever panel is showing (they act on the active scope).
  const pinsBlockSetProps = {
    onAddNotesToSet: (set: ContextSetRowView) =>
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
        pins={currentProject?.pins ?? null}
        sets={currentProject?.sets ?? null}
        previews={previews}
        scale={currentProject?.budgetTokens ?? 0}
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
        {currentProject && (
          <p className={styles.auto} data-testid="context-auto">
            <Chip>{currentProject.index.noteCount} notes</Chip>
            <Chip>{currentProject.index.folderCount} folders</Chip>
            <span className={styles.muted}>+ recent changes</span>
          </p>
        )}
      </div>
    </section>
  ) : null

  const roleSection = roleRows ? (
    <section className={styles.section} data-testid="context-role">
      {roleInactive && (
        <Notice variant="warning" data-testid="context-role-inactive">
          {ROLE_INACTIVE_NOTICE[roleInactive]}
        </Notice>
      )}
      <PinsBlock
        pins={roleRows.pins}
        sets={roleRows.sets}
        previews={previews}
        scale={
          projectScope ? (currentProject?.budgetTokens ?? 0) : (currentPersonal?.budgetTokens ?? 0)
        }
        onAdd={() => setPicker({})}
        onOpen={openPinnedNote}
        onUnpin={unpin}
        onReorder={reorderRole}
        {...pinsBlockSetProps}
        emptyHint="Pin a note — or attach a reusable set — that this owned role should load before the base context."
        addTestId="context-add-role-pin"
        listTestId="context-role-pins"
        editable={roleEditable}
      />
      {!roleEditable && (
        <Notice variant="info" data-testid="context-role-readonly">
          You can inspect this shared role preset, but only a space writer can change it.
        </Notice>
      )}
    </section>
  ) : null

  return (
    <>
      <div className={styles.page} data-testid="agents-context">
        <div className={styles.inner}>
          <header className={styles.pageHead}>
            <h1 className={styles.pageTitle}>Context constructor</h1>
            <p className={styles.pageSub}>
              What an agent carries into every session before it starts — your pinned notes and the
              memory it keeps about you, under one token budget. Curate it here so the agent always
              has the right background, and nothing it doesn’t.
            </p>
            <div className={styles.rolePicker}>
              <span className={styles.rolePickerLabel}>Effective role</span>
              <Select
                value={selectedRoleLocator}
                options={roleOptions}
                onChange={selectRole}
                aria-label="Effective role context"
                data-testid="context-role-selector"
              />
              <span>A role’s own context loads first, inside the same budget.</span>
            </div>
          </header>

          {/* Reserve the meter's exact box while the scope loads, so the blocks below don't
              jump when it appears; a load failure shows the notice instead (no skeleton). */}
          {aggregate && !roleSelectionUnavailable
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

          {(currentPreview?.rolesTruncated ?? false) && (
            <Notice variant="warning" data-testid="context-roles-truncated">
              The effective role list hit the host limit, so this selector is not exhaustive.
            </Notice>
          )}

          {roleSelectionUnavailable && (
            <Notice variant="warning" data-testid="context-role-unavailable">
              That role is no longer available here. Returning to the base context…
            </Notice>
          )}

          {/* One scale up top; below it only the SELECTED scope's panels. Selecting the
              Personal tab switches to it inline (its band lights, its panels replace the
              project's) — the personal context is never duplicated as a second panel. */}
          {contextReady && !roleSelectionUnavailable
            ? activeScope === 'role' && roleRows
              ? roleSection
              : activeScope === 'project' && projectScope
                ? projectSection
                : profileSection
            : null}
        </div>
      </div>

      {picker && (
        <PinPicker
          space={scopeHomeSpace}
          folder={
            (isProjectScope || (isRoleScope && roleLayer?.scope === 'project')) && projectScope
              ? projectScope.path
              : undefined
          }
          excludeIds={isRoleScope ? rolePinIds : isProjectScope ? projectPinIds : personalPinIds}
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
    </>
  )
}
