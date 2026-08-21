import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import type {
  AbilityLocator,
  AddAgentRoleRequest,
  AddAgentSkillRequest,
  AgentAbilityDetailResponse,
  MeAgentSkillsResponse,
} from '@notarium/contract'
import {
  ABILITY_AVAILABILITY_MODE,
  ABILITY_KIND,
  ABILITY_ORIGIN,
  ABILITY_SOURCE,
  ROLE_SCOPE,
} from '@notarium/contract/enums'
import { decodeAbilityLocator, encodeAbilityLocator, isAbilityLocator } from '@notarium/core'
import { useAgentsExplorer } from '../../composers/AgentsExplorerProvider'
import { useEditing } from '../../composers/EditingProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { AsideField, AsidePanel, AsideValue } from '../../core/AsidePanel'
import { Button } from '../../core/Button'
import { Chip } from '../../core/Chips'
import { useDialog } from '../../core/Dialog'
import { IconEdit, IconX } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { Skeleton, SkeletonText } from '../../core/Skeleton'
import { StateView } from '../../core/StateView'
import { useToast } from '../../core/Toast'
import { errorText } from '../../libs/errors'
import { renderMarkdown } from '../../libs/markdown/markdown'
import { useMarkdownEnhance } from '../../libs/markdown/useMarkdownEnhance'
import { pushRecentNote, recentNotesBucket } from '../../libs/recentNotes'
import {
  agentAbilityRoute,
  agentContextRoute,
  agentRolesRoute,
  agentSkillsRoute,
  DEFAULT_AGENT_CONTEXT_SCOPE,
} from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { AbilityActionsMenu } from './AbilityActionsMenu'
import { AbilityEditorSurface } from './AbilityEditorSurface'
import { AgentsPanel } from './AgentsPanel'
import { useAgentsShell } from './AgentsProvider'
import { CatalogAbilityAddDialog, type CatalogInstallAvailability } from './CatalogAbilityAddDialog'
import {
  abilitySaveLanded,
  type AbilitySaveProgress,
  abilitySaveProgress,
  runAbilitySave,
} from './helpers/abilitySave'
import { projectContextScope } from './helpers/contextScope'
import { projectChoiceLabels } from './helpers/format'
import { rememberContextScopeSpace } from './helpers/scopeStorage'
import { useSkillInventory } from './hooks/useSkillInventory'
import styles from './AbilityDetailPage.module.scss'

const locatorFromParams = (
  params: {
    kind?: string
    source?: string
    locator?: string
    packageId?: string
  },
  expectedKind?: 'role' | 'skill',
  expectedSource?: 'owned' | 'system' | 'catalog',
): AbilityLocator | null => {
  const kind =
    expectedKind ??
    (params.kind === 'roles'
      ? ABILITY_KIND.role
      : params.kind === 'skills'
        ? ABILITY_KIND.skill
        : null)
  const source = expectedSource ?? params.source

  if (!kind) {
    return null
  }
  if (source === ABILITY_SOURCE.owned && params.locator) {
    const decoded = decodeAbilityLocator(params.locator)
    return decoded?.source === ABILITY_SOURCE.owned && decoded.kind === kind ? decoded : null
  }

  // A bundled ability carries its package id in the URL RAW, so what arrives here is
  // whatever a stale link, an old bookmark or a typo holds — and a route segment is
  // not an address. `encodeAbilityLocator`, which this page runs on every render,
  // refuses what the system could not have minted by THROWING; a throw in render is
  // not this page's error state, it takes the whole Agents surface down to the crash
  // screen. So the address is judged here, and one that is not an address is none.
  const bundled: unknown = { source, kind, packageId: params.packageId }

  return isAbilityLocator(bundled) ? bundled : null
}

export const AbilityDetailPage = ({
  expectedKind,
  expectedSource,
}: {
  expectedKind?: 'role' | 'skill'
  expectedSource?: 'owned' | 'system' | 'catalog'
}) => {
  const params = useParams()
  const locator = useMemo(
    () => locatorFromParams(params, expectedKind, expectedSource),
    [expectedKind, expectedSource, params],
  )
  // The address this page is on, as ONE comparable value. Every source shares its
  // route entry, so walking from A to B never remounts this component: anything that
  // waits on the network can land on an address the reader has already left.
  const address = locator ? encodeAbilityLocator(locator) : null
  const addressRef = useRef(address)
  addressRef.current = address

  const { space, spaces, personalSpace, canWrite, reportNoteSpace } = useSpace()
  const { scope, invalidate, versions } = useAgentsExplorer()
  const { actionsHost, setBreadcrumbTail } = useAgentsShell()
  const editing = useEditing()
  const { confirm } = useDialog()
  const toast = useToast()
  const navigate = useNavigate()
  const routeLocation = useLocation()
  const [detail, setDetail] = useState<AgentAbilityDetailResponse | null>(null)
  // Whether this page already HAS the document, readable from an effect that must not
  // re-run when it arrives — the same render-assigned idiom as `addressRef` above.
  const detailRef = useRef(detail)
  detailRef.current = detail
  const { inventory, skills, read: readInventory } = useSkillInventory(scope?.spaceId ?? null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [catalogAddOpen, setCatalogAddOpen] = useState(false)
  // Which targets this host can publish to, for the kind being added. A role's
  // answer is per PROJECT and a skill's per Space, so the skill inventory this
  // page already reads cannot stand in for the role library's — it is read
  // alongside, once, when the dialog is about to open.
  const [installTargets, setInstallTargets] = useState<CatalogInstallAvailability | undefined>()
  const markdownRef = useRef<HTMLDivElement>(null)
  const handledEditIntent = useRef<string | null>(null)
  // The save closure is minted when editing starts; the settings it must apply are
  // whatever the user left in the draft at Save time, so it reads them through a ref.
  const editorRef = useRef(editing.editor)
  // What this edit has already committed, as one value — the address included, since
  // a home move relocates the package and every later write has to be addressed at
  // where it now is. Seeded at Edit, folded by the save run, adopted by the page when
  // the edit ends either way.
  const progress = useRef<AbilitySaveProgress | null>(null)
  const seq = useRef(0)
  const catalogAddSeq = useRef(0)
  const pendingCatalogAdd = useRef<number | null>(null)
  const seenAddress = useRef<string | null>(null)

  // Leaving the section is a walk too, and a ref only ever written while RENDERING
  // answers "still here" forever after the last render. An Add read belongs to that
  // address as well: walking invalidates its generation, closes any dialog already
  // open for the old package, and releases only the busy state owned by that read.
  useEffect(() => {
    addressRef.current = address
    if (pendingCatalogAdd.current !== null) {
      pendingCatalogAdd.current = null
      setBusy(false)
    }
    setCatalogAddOpen(false)
    setInstallTargets(undefined)

    return () => {
      addressRef.current = null
      catalogAddSeq.current += 1
    }
  }, [address])

  useEffect(() => {
    editorRef.current = editing.editor
  }, [editing.editor])
  // The title is the document's heading, rendered by the shared `.doc-title` the way
  // every other document surface renders it — not as an `h1` inside the body, which
  // would give the same section two heading sizes on neighbouring routes.
  const html = useMemo(() => (detail ? renderMarkdown(detail.ability.instructions) : ''), [detail])
  useMarkdownEnhance(markdownRef, html)

  const load = useCallback(async () => {
    if (!locator) {
      setFailed('Invalid ability address.')
      return
    }
    // Owned and System abilities share one route entry, so walking from A to B keeps
    // this component mounted and A's answer can land after B's. A late answer must
    // not paint B's screen with A: it would also push A into Recent, name A in the
    // breadcrumb, and hand Edit a session for the document the user is not reading.
    const request = ++seq.current

    try {
      const next = await api.agentAbilityGet(locator)

      if (request !== seq.current) {
        return
      }
      setDetail(next)
      setFailed(null)
    } catch (error) {
      if (request === seq.current) {
        setFailed(errorText(error))
      }
    }
  }, [locator])

  // The section's reload key, the same one the Explorer, the library and the shell
  // counters ride: this page hands `invalidate` to five of its own writes and lives
  // through the same CHANGED frames and reconnects, so a detail read once per address
  // goes stale in place — and Edit then mints its draft from the stale half while
  // taking a FRESH version token, which is exactly the shape a CAS cannot catch.
  const dataVersion = versions[locator?.kind === ABILITY_KIND.skill ? 'skills' : 'roles']
  // An open draft for THIS address carries what Edit read; re-reading under it can
  // only swap the surface for a skeleton or an error while the user types, and
  // refreshes nothing the editor still reads. The session's exit runs this effect
  // again, so a bump that arrived meanwhile is answered then. A draft for a DIFFERENT
  // address is not this page's business and must not hold its document hostage.
  const editingAbility =
    editing.isEditing &&
    editing.draft?.documentKind === 'ability' &&
    editing.draft.abilityLocator != null &&
    encodeAbilityLocator(editing.draft.abilityLocator) === address

  useEffect(() => {
    // A new address is a different document and starts from its skeleton; a bump is a
    // REFRESH of this one and must not cost the reader the page they are reading.
    if (seenAddress.current !== address) {
      seenAddress.current = address
      setDetail(null)
    }
    // Only a RE-read is withheld while a draft is open — a background refresh under the
    // editor can only flash a skeleton. The FIRST read still has to happen: arriving at
    // a freshly created version opens its draft before this page has ever loaded that
    // address, and withholding the read there left the editor with no document to show.
    if (editingAbility && detailRef.current) {
      return
    }
    void load()
    return () => {
      seq.current += 1
    }
  }, [address, dataVersion, editingAbility, load])

  useEffect(() => {
    setBreadcrumbTail(detail ? { label: detail.ability.title } : null)
    return () => setBreadcrumbTail(null)
  }, [detail, setBreadcrumbTail])

  // Recording the visit is its own concern, and its own KEY: the MRU is per Space and
  // the Space is the ability's, not the chrome's — these routes are space-free, so the
  // chrome's Space is whatever the user last browsed. Reading the document must not
  // depend on it either: fused into `load`, a Space switch re-fetched the page.
  const ownedAbility = detail?.ability.source === ABILITY_SOURCE.owned ? detail.ability : null
  useEffect(() => {
    if (!ownedAbility) {
      return
    }
    const bucket = recentNotesBucket(
      ownedAbility.locator.location.spaceId,
      [...spaces, ...(personalSpace ? [personalSpace] : [])],
      space,
    )

    pushRecentNote(bucket, {
      kind: 'owned-ability',
      id: ownedAbility.noteId,
      title: ownedAbility.title,
      noteType: ownedAbility.locator.kind === ABILITY_KIND.role ? 'Role' : 'Skill',
      href: agentAbilityRoute(ownedAbility.locator),
      modifiedAt: null,
      createdAt: null,
    })
  }, [ownedAbility, personalSpace, space, spaces])

  const availabilityInventoryKey =
    detail?.ability.source === ABILITY_SOURCE.owned &&
    (detail.ability.locator.kind === ABILITY_KIND.role ||
      detail.ability.locator.location.scope !== ROLE_SCOPE.personal)
      ? detail.ability.locator.location.spaceId
      : null

  useEffect(() => {
    if (availabilityInventoryKey) {
      void readInventory(availabilityInventoryKey)
    }
  }, [availabilityInventoryKey, readInventory])

  // The page adopts what the edit committed, however the edit ended. Anything landed
  // means the loaded detail is stale; a landed MOVE means the URL addresses a package
  // that is no longer there, and a route built from the seed address 404s on reload.
  const adoptProgress = useCallback(
    async (asked: string | null) => {
      const committed = progress.current
      progress.current = null

      if (!committed || !abilitySaveLanded(committed)) {
        return
      }
      // The session outlives the address it was minted at: the editor clears it BEFORE
      // it awaits this, so an edit that ended after the reader walked on lands on
      // whatever they are reading NOW. Neither half of the adoption is theirs to take —
      // the move's `replace` rewrites the history entry of the page they opened, so
      // Back no longer returns, and the re-read runs through a `load` that is still
      // addressed at the ability they left and would paint it over the one they chose.
      if (asked !== addressRef.current) {
        return
      }
      if (committed.moved) {
        navigate(agentAbilityRoute(committed.locator), { replace: true })
        return
      }
      await load()
    },
    [load, navigate],
  )

  const startEdit = useCallback(async () => {
    // The document has to be the one this URL addresses. Right after a navigation the
    // page still holds the PREVIOUS document for a beat — its own load effect has not
    // committed the reset yet — and minting a draft from it here produced a session for
    // the package the reader came FROM, on the page of the one they arrived at.
    if (
      !detail ||
      detail.ability.source !== ABILITY_SOURCE.owned ||
      busy ||
      encodeAbilityLocator(detail.ability.locator) !== addressRef.current
    ) {
      return
    }
    setBusy(true)
    try {
      const ability = detail.ability
      const location = ability.locator.location
      const asked = addressRef.current
      const [note] = await Promise.all([
        api.noteGet(ability.noteId),
        readInventory(location.spaceId),
      ])

      // The reader walked on while this waited. Opening the session now would hand
      // them an editor for the ability they LEFT, judged against the inventory of the
      // one they are looking at: its attachments read as unavailable, and the Save
      // that follows writes that verdict back into the ability they never opened.
      if (asked !== addressRef.current) {
        return
      }
      const availability = ability.availability
      const reach =
        availability?.mode === ABILITY_AVAILABILITY_MODE.selectedProjects
          ? availability.projectIds
          : []
      // Nothing this edit has committed yet, and it starts where the package is now.
      progress.current = abilitySaveProgress(ability.locator)
      const documentTitle = note.documentTitle || note.title
      editing.startSession({
        id: `owned-ability:${encodeAbilityLocator(ability.locator)}`,
        canWrite: canWrite || location.scope === ROLE_SCOPE.personal,
        versionToken: note.versionToken,
        draft: {
          isNew: false,
          documentKind: 'ability',
          abilityKind: ability.locator.kind,
          abilityLocator: ability.locator,
          lockDirectory: true,
          slug: note.slug || '',
          directory: note.filePath?.split('/').slice(0, -1).join('/') ?? '',
          content: documentTitle ? `# ${documentTitle}\n\n${note.content}` : note.content,
          tags: [],
          noteType: 'note',
          abilityName: ability.name,
          abilityDescription: ability.description,
          attachments: detail.health?.attachments.map(({ attachment }) => attachment) ?? [],
          // The draft carries the PRODUCT answer, not the storage scope: a role that
          // lives in one project covers exactly that project, which is the same
          // sentence a Space role with one project ticked says. Where the package
          // sits is decided at save, from the answer.
          abilityHome:
            location.scope === ROLE_SCOPE.personal ? ROLE_SCOPE.personal : ROLE_SCOPE.space,
          abilitySpace: note.space ?? space,
          abilitySpaceId: location.spaceId,
          abilityAvailability:
            location.scope === ROLE_SCOPE.project
              ? ABILITY_AVAILABILITY_MODE.selectedProjects
              : (availability?.mode ?? ABILITY_AVAILABILITY_MODE.allProjects),
          // The reach is carried as the server states it — project IDS, not names
          // resolved through the picker's list. That list is filtered (active,
          // writable, capped), so round-tripping through it would silently drop a
          // binding the user cannot even see, on a save that only touched the body.
          abilityProjects: location.scope === ROLE_SCOPE.project ? [location.projectId] : reach,
          createdAt: note.createdAt ?? null,
        },
        save: async (payload, versionToken) => {
          const edited = editorRef.current

          return runAbilitySave({
            progress: progress.current ?? abilitySaveProgress(ability.locator),
            commit: (next) => {
              progress.current = next
            },
            payload,
            noteId: note.id,
            versionToken,
            seedReach: ability.availability ?? null,
            answer: {
              covers:
                edited.abilityAvailability === ABILITY_AVAILABILITY_MODE.selectedProjects
                  ? edited.abilityProjects
                  : null,
              attachments: edited.attachmentsDirty ? edited.attachments : null,
            },
            effects: {
              saveDocument: (body) => api.noteSave(note.space ?? space, body),
              moveHome: (at) => api.agentAbilitySetHome(at, { scope: ROLE_SCOPE.space }),
              setReach: async (at, next) => {
                await api.agentAbilitySetAvailability(at, next)
              },
            },
          })
        },
        onSaved: async () => {
          invalidate(ability.locator.kind === ABILITY_KIND.role ? 'roles' : 'skills')
          await adoptProgress(asked)
        },
        // Abandoning a PART-applied save still leaves the page addressing a package
        // that has moved and showing a document that has been rewritten — so the exit
        // re-reads truth instead of keeping the screen the edit invalidated.
        onCancel: () => {
          void adoptProgress(asked)
        },
      })
    } catch (error) {
      setFailed(errorText(error))
    } finally {
      setBusy(false)
    }
  }, [detail, busy, readInventory, editing, canWrite, space, invalidate, adoptProgress])

  useEffect(() => {
    const state = routeLocation.state as { editAbility?: boolean } | null

    // The intent is spent only when it can actually be FULFILLED. A busy page and a
    // document that is not yet the one this URL addresses are both a WAIT, not a
    // refusal: `startEdit` declines on either, and the navigation that carries this
    // intent arrives with the busy flag of the action that created the package still
    // set. Marking the intent handled there spent it on that no-op and nothing asked
    // again — the reader landed on a freshly forked version in read mode.
    if (
      !state?.editAbility ||
      !detail ||
      busy ||
      encodeAbilityLocator(detail.ability.locator) !== address ||
      handledEditIntent.current === routeLocation.key
    ) {
      return
    }
    handledEditIntent.current = routeLocation.key
    void startEdit()
  }, [address, busy, detail, routeLocation.key, routeLocation.state, startEdit])

  const setEnabled = async (enabled: boolean) => {
    if (!detail || detail.ability.source === ABILITY_SOURCE.catalog || busy) {
      return
    }
    const key = encodeAbilityLocator(detail.ability.locator)
    const asked = addressRef.current

    setBusy(true)
    try {
      await api.agentAbilitySetEnabled(detail.ability.locator, enabled)
      // Written into whatever is on screen NOW, by address — the page may be reading
      // a different ability by the time this lands, and a refresh may have replaced
      // the very detail this closure captured.
      setDetail((current) =>
        current && encodeAbilityLocator(current.ability.locator) === key
          ? ({ ...current, ability: { ...current.ability, enabled } } as AgentAbilityDetailResponse)
          : current,
      )
      invalidate(detail.ability.locator.kind === ABILITY_KIND.role ? 'roles' : 'skills')
    } catch (error) {
      // The page-wide error surface belongs to the page the reader is ON: a toggle
      // that failed for an ability they have since left must not take its place.
      if (asked === addressRef.current) {
        setFailed(errorText(error))
      }
    } finally {
      setBusy(false)
    }
  }

  const openCatalogAdd = async () => {
    if (!detail || detail.ability.source !== ABILITY_SOURCE.catalog || busy) {
      return
    }
    const asked = addressRef.current
    const request = ++catalogAddSeq.current
    pendingCatalogAdd.current = request

    setBusy(true)
    try {
      // Through the wrapper, not the bare reader: the dialog offers destinations out
      // of `inventory`, and a reader whose answer is thrown away leaves it empty.
      const [loaded, roleLibrary] = await Promise.all([
        readInventory(),
        detail.ability.locator.kind === ABILITY_KIND.role
          ? api.agentRolesGet({ limit: 1, ...(scope?.spaceId ? { spaceId: scope.spaceId } : {}) })
          : null,
      ])

      // Availability and the dialog are one accepted result. Splitting this gate lets
      // a late read replace the targets of a newer dialog even when it no longer opens
      // its own; the generation also covers a newer request for the same address.
      if (asked !== addressRef.current || request !== catalogAddSeq.current) {
        return
      }
      setInstallTargets((roleLibrary ?? loaded.first)?.installAvailability)
      setCatalogAddOpen(true)
    } catch (error) {
      if (asked === addressRef.current && request === catalogAddSeq.current) {
        setFailed(errorText(error))
      }
    } finally {
      if (pendingCatalogAdd.current === request && request === catalogAddSeq.current) {
        pendingCatalogAdd.current = null
        setBusy(false)
      }
    }
  }

  const addCatalog = async (input: AddAgentRoleRequest | AddAgentSkillRequest) => {
    if (!detail || detail.ability.source !== ABILITY_SOURCE.catalog) {
      return
    }
    const asked = addressRef.current
    const request = catalogAddSeq.current
    const result =
      detail.ability.locator.kind === ABILITY_KIND.role
        ? await api.agentRoleAddExact(input as AddAgentRoleRequest)
        : await api.agentSkillAddExact(input as AddAgentSkillRequest)
    // The write happened, so every listing re-reads either way. Closing and landing
    // belong to the exact dialog generation that submitted it: the same address may
    // have walked away and back, or a newer address may already own another dialog.
    invalidate(detail.ability.locator.kind === ABILITY_KIND.role ? 'roles' : 'skills')
    if (asked !== addressRef.current || request !== catalogAddSeq.current) {
      return
    }
    setCatalogAddOpen(false)
    navigate(agentAbilityRoute(result.locator), { replace: true })
  }

  const addRoleVersion = async (project: MeAgentSkillsResponse['projects'][number]) => {
    if (
      !detail ||
      detail.ability.source !== ABILITY_SOURCE.owned ||
      detail.ability.locator.kind !== ABILITY_KIND.role
    ) {
      return
    }
    const base = detail.ability.locator
    const asked = addressRef.current

    setBusy(true)
    try {
      const created = await api.agentAbilityCreateVersion(base, project.id)
      invalidate('roles')
      // A version starts as a copy of its base, so the next thing anyone wants is to
      // say how it differs — the same landing the New flow uses. Unless the reader
      // has already opened something else: then this would drag them out of it, into
      // an editor for a package they are no longer looking at.
      if (asked === addressRef.current) {
        navigate(agentAbilityRoute(created.locator), { state: { editAbility: true } })
      }
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      // Both ends of this navigation are the SAME route pattern, so this component is
      // reused rather than remounted: a `busy` left standing would outlive the action
      // and silently refuse the edit intent it just navigated with.
      setBusy(false)
    }
  }

  const deleteOwned = async () => {
    if (!detail || detail.ability.source !== ABILITY_SOURCE.owned || busy) {
      return
    }
    const ability = detail.ability
    const ok = await confirm({
      title: `Delete “${ability.title}”?`,
      message: `This moves the ${ability.locator.kind} to Trash.`,
      confirmLabel: 'Delete',
      danger: true,
    })

    if (!ok) {
      return
    }
    const asked = addressRef.current

    setBusy(true)
    try {
      await api.noteRemove(ability.noteId)
      invalidate(ability.locator.kind === ABILITY_KIND.role ? 'roles' : 'skills')

      if (asked === addressRef.current) {
        // This navigation unmounts the page, so `busy` is deliberately left standing.
        navigate(
          ability.locator.kind === ABILITY_KIND.role ? agentRolesRoute() : agentSkillsRoute(),
        )
        return
      }
    } catch (error) {
      toast.error(errorText(error))
    }
    setBusy(false)
  }

  if (failed) {
    // The same error surface the note page shows, with the same way out of it — an
    // error a user cannot retry is a dead end, not a state.
    return (
      <StateView
        tone="error"
        code="Error"
        icon={<IconX size={30} />}
        title="Couldn’t open this ability"
        description={failed}
        testId="ability-error"
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setFailed(null)
              void load()
            }}
          >
            Try again
          </Button>
        }
      />
    )
  }
  if (!detail) {
    return (
      <div className={styles.detailSkeleton} data-testid="ability-detail-skeleton">
        <Skeleton w="46%" h={34} radius={6} />
        <SkeletonText lines={4} lastWidth="62%" />
        <SkeletonText lines={5} lastWidth="40%" />
      </div>
    )
  }
  const { ability, health } = detail
  const abilityProject =
    ability.source === ABILITY_SOURCE.owned && ability.locator.location.scope === ROLE_SCOPE.project
      ? inventory?.projects.find(
          (entry) =>
            ability.locator.location.scope === ROLE_SCOPE.project &&
            entry.id === ability.locator.location.projectId,
        )
      : undefined
  const homeSpaceName =
    ability.source === ABILITY_SOURCE.owned
      ? (spaces.find((entry) => entry.id === ability.locator.location.spaceId)?.displayName ??
        'the Space')
      : ''
  // Where it belongs, named the way the user named it — and, only when the move is
  // genuinely available, what it may become. A project role can take the Space's name
  // exactly when nothing there already holds that name and the Space is shared: a
  // personal library keeps its Personal and Space packages in one place, so there is
  // no second address to move to.
  const placement =
    ability.source !== ABILITY_SOURCE.owned
      ? undefined
      : {
          spaceLabel: homeSpaceName,
          label:
            ability.locator.location.scope === ROLE_SCOPE.personal
              ? 'Personal'
              : ability.locator.location.scope === ROLE_SCOPE.space
                ? homeSpaceName
                : (abilityProject?.displayName ?? 'This project'),
          // Which projects an ability covers is an ordinary setting — it is the reach,
          // and it changes without anything relocating. The control is dead only where
          // answering it WOULD require a move that is not possible: a Personal ability
          // (a different space, which the engine cannot move a note between) and a
          // project role that overrides a Space one of the same name.
          movable:
            canWrite &&
            ability.locator.location.scope !== ROLE_SCOPE.personal &&
            personalSpace?.id !== ability.locator.location.spaceId &&
            !ability.baseLocator,
          fixedReason:
            ability.locator.location.scope === ROLE_SCOPE.personal ||
            personalSpace?.id === ability.locator.location.spaceId
              ? 'Moving between Personal and a Space is not available yet'
              : ability.baseLocator
                ? 'This role overrides the Space role of the same name, so that name is taken above it'
                : 'You cannot change this ability',
          ...(ability.baseLocator ? { overrides: homeSpaceName } : {}),
        }

  // WHOSE draft, not merely whether one is open: this component is reused across
  // abilities, so an ability session belongs to this page only while the document on
  // screen is the one it was minted from — otherwise the editor would be answering
  // for one package while every list, project and skill around it describes another.
  if (
    editing.isEditing &&
    editing.draft?.documentKind === 'ability' &&
    editing.draft.abilityLocator &&
    encodeAbilityLocator(editing.draft.abilityLocator) === encodeAbilityLocator(ability.locator)
  ) {
    return (
      <AbilityEditorSurface
        projects={inventory?.projects ?? []}
        skills={skills}
        placement={placement}
      />
    )
  }

  const contextTarget = (axis: string, targetSpace?: string) => {
    if (targetSpace) {
      rememberContextScopeSpace(axis, targetSpace)
      reportNoteSpace(targetSpace)
    }
    const query = new URLSearchParams({ role: encodeAbilityLocator(ability.locator) })
    navigate(`${agentContextRoute(axis)}?${query}`)
  }
  const configure =
    ability.source === ABILITY_SOURCE.owned && ability.locator.kind === ABILITY_KIND.role
      ? (() => {
          const location = ability.locator.location

          return location.scope === ROLE_SCOPE.personal
            ? { onClick: () => contextTarget(DEFAULT_AGENT_CONTEXT_SCOPE) }
            : location.scope === ROLE_SCOPE.project
              ? (() => {
                  const project = inventory?.projects.find(
                    (entry) => entry.id === location.projectId,
                  )
                  return project
                    ? {
                        onClick: () =>
                          contextTarget(projectContextScope(project.handle), project.space),
                      }
                    : undefined
                })()
              : inventory?.projects.length
                ? {
                    onClick: () => {},
                    children: inventory.projects.map((project) => ({
                      label: project.displayName,
                      onClick: () =>
                        contextTarget(projectContextScope(project.handle), project.space),
                    })),
                  }
                : undefined
        })()
      : undefined

  const actions = (
    <>
      {ability.source === ABILITY_SOURCE.owned &&
        (canWrite || ability.locator.location.scope === ROLE_SCOPE.personal) && (
          <Button variant="ghost" disabled={busy} onClick={() => void startEdit()}>
            <IconEdit size={15} /> Edit
          </Button>
        )}
      <AbilityActionsMenu
        ability={ability}
        busy={busy}
        configure={configure}
        addVersion={
          ability.source === ABILITY_SOURCE.owned &&
          ability.locator.kind === ABILITY_KIND.role &&
          ability.locator.location.scope === ROLE_SCOPE.space &&
          canWrite
            ? projectChoiceLabels(
                (inventory?.projects ?? []).filter(
                  (project) =>
                    !(ability.versions ?? []).some((version) => version.projectId === project.id),
                ),
              ).map((project) => ({
                label: project.label,
                onClick: () => void addRoleVersion(project),
              }))
            : undefined
        }
        onToggle={
          ability.source === ABILITY_SOURCE.catalog
            ? undefined
            : (enabled) => void setEnabled(enabled)
        }
        onDelete={
          ability.source === ABILITY_SOURCE.owned &&
          (canWrite || ability.locator.location.scope === ROLE_SCOPE.personal)
            ? () => void deleteOwned()
            : undefined
        }
        onAdd={ability.source === ABILITY_SOURCE.catalog ? () => void openCatalogAdd() : undefined}
        testId="ability-detail-menu"
      />
    </>
  )
  // Read mode states the current values in the same field rhythm the reading
  // inspector uses; every mutation lives in the topbar kebab or in Edit.
  const settings = (
    <AsidePanel testId="ability-settings">
      {ability.description && (
        <AsideField label="Description">
          <AsideValue>{ability.description}</AsideValue>
        </AsideField>
      )}
      <AsideField label="Status">
        <AsideValue>{'enabled' in ability && ability.enabled ? 'Enabled' : 'Disabled'}</AsideValue>
      </AsideField>
      <AsideField label="Source">
        <Chip>{ability.source}</Chip>
      </AsideField>
      {ability.source === ABILITY_SOURCE.owned && (
        <>
          <AsideField label="Origin">
            <Chip>{ability.origin === ABILITY_ORIGIN.catalog ? 'From catalog' : 'Custom'}</Chip>
          </AsideField>
          {/* One answer, read the way it was asked: the whole Space, or the
              projects it covers. */}
          <AsideField label="Belongs to">
            {ability.availability?.mode === ABILITY_AVAILABILITY_MODE.selectedProjects ? (
              <ul className={styles.projectList}>
                {ability.availability.projectIds.map((id) => (
                  <li key={id}>
                    {inventory?.projects.find((project) => project.id === id)?.displayName ?? id}
                  </li>
                ))}
              </ul>
            ) : (
              <Chip>{placement?.label ?? ability.locator.location.scope}</Chip>
            )}
          </AsideField>
        </>
      )}
      {ability.source === ABILITY_SOURCE.owned && ability.baseLocator && (
        <AsideField label="Overrides">
          <ul className={styles.projectList}>
            <li>
              <Link to={agentAbilityRoute(ability.baseLocator)}>{homeSpaceName}</Link>
            </li>
          </ul>
        </AsideField>
      )}
      {/* A version is not a card of its own, so this list is the way to it: without
          links the user could create one and never open it again. */}
      {ability.source === ABILITY_SOURCE.owned && (ability.versions?.length ?? 0) > 0 && (
        <AsideField label="Versions">
          <ul className={styles.projectList}>
            {(ability.versions ?? []).map((version) => (
              <li key={version.projectId}>
                <Link to={agentAbilityRoute(version.locator)}>
                  {inventory?.projects.find((project) => project.id === version.projectId)
                    ?.displayName ?? version.projectId}
                </Link>
              </li>
            ))}
          </ul>
        </AsideField>
      )}
    </AsidePanel>
  )

  return (
    <article className={`${styles.page} doc`} data-testid="agent-ability-detail">
      {detail.truncated && (
        <Notice variant="warning">This preview reached the host token limit.</Notice>
      )}
      {health && !health.healthy && (
        <Notice variant="warning">
          This role has unavailable attachments. Agent activation remains fail-closed.
        </Notice>
      )}
      {health?.attachments.length ? (
        <div className={styles.health}>
          {health.attachments.map(({ attachment, health: state }, index) => (
            <Chip key={`${index}:${JSON.stringify(attachment)}`}>
              {attachment.kind === 'exact'
                ? (skills.find(
                    (candidate) =>
                      encodeAbilityLocator(candidate.locator) ===
                      encodeAbilityLocator(attachment.locator),
                  )?.title ?? attachment.label)
                : attachment.raw}{' '}
              · {state}
            </Chip>
          ))}
        </div>
      ) : null}
      <header className="doc-head">
        <h1 className="doc-title">{ability.title}</h1>
      </header>
      <div ref={markdownRef} className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
      {actionsHost ? createPortal(actions, actionsHost) : null}
      <AgentsPanel
        panels={[{ id: 'details', label: 'Details', render: () => settings }]}
        defaultLayout={[{ panels: ['details'], activeTab: 'details' }]}
        label={`${ability.locator.kind} details`}
      />
      {catalogAddOpen && (
        <CatalogAbilityAddDialog
          kind={ability.locator.kind}
          name={ability.name}
          space={space}
          spaceAvailable={canWrite && personalSpace?.slug !== space}
          projects={inventory?.projects ?? []}
          install={installTargets}
          onAdd={addCatalog}
          onClose={() => setCatalogAddOpen(false)}
        />
      )}
    </article>
  )
}
