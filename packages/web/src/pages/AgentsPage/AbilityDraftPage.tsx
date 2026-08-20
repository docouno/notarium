import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import type { AgentAbilitySummary, MeAgentSkillsResponse } from '@notarium/contract'
import { ABILITY_AVAILABILITY_MODE, ABILITY_KIND, ROLE_SCOPE } from '@notarium/contract/enums'
import { DEFAULT_NOTE_TYPE } from '@notarium/core'
import { useAgentsExplorer } from '../../composers/AgentsExplorerProvider'
import { useAuth } from '../../composers/AuthProvider'
import { useEditing } from '../../composers/EditingProvider'
import { useSpace } from '../../composers/SpaceProvider'
import { Button } from '../../core/Button'
import { IconX } from '../../core/Icons'
import { StateView } from '../../core/StateView'
import {
  type AbilityDraftRecord,
  readAbilityDraft,
  removeAbilityDraft,
  writeAbilityDraft,
} from '../../libs/abilityDraftStorage'
import { errorText } from '../../libs/errors'
import { agentAbilityRoute, agentRolesRoute, agentSkillsRoute } from '../../libs/routing/routePaths'
import { api } from '../../services/api'
import { AbilityEditorSurface } from './AbilityEditorSurface'
import { useAgentsShell } from './AgentsProvider'
import { abilityDraftSessionOf, abilityDraftSync } from './helpers/abilityDraftSync'
import { loadSkillInventory } from './helpers/skillInventory'

const DRAFT_ID = /^[A-Za-z0-9-]{1,128}$/

export const AbilityDraftPage = ({ expectedKind }: { expectedKind?: 'roles' | 'skills' }) => {
  const { kind: routeKind, draftId = '' } = useParams<{
    kind?: 'roles' | 'skills'
    draftId: string
  }>()
  const kind = expectedKind ?? routeKind ?? 'roles'
  const abilityKind = kind === 'skills' ? 'skill' : 'role'
  const { mode, me } = useAuth()
  const owner = mode === 'none' ? '@system' : (me?.username ?? '')
  const { scope, invalidate } = useAgentsExplorer()
  const { setBreadcrumbTail } = useAgentsShell()
  const { space, canWrite } = useSpace()
  const navigate = useNavigate()
  const editing = useEditing()
  const editorRef = useRef(editing.editor)
  editorRef.current = editing.editor

  useEffect(() => {
    setBreadcrumbTail({ label: `New ${abilityKind}` })
    return () => setBreadcrumbTail(null)
  }, [abilityKind, setBreadcrumbTail])
  const [inventory, setInventory] = useState<MeAgentSkillsResponse | null>(null)
  const [skills, setSkills] = useState<AgentAbilitySummary[]>([])
  const [failed, setFailed] = useState<string | null>(null)
  const createdAtRef = useRef<string | null>(null)
  // The last record actually persisted, so an unchanged draft is not rewritten.
  const writtenRef = useRef<string | null>(null)

  useEffect(() => {
    if (!owner || !DRAFT_ID.test(draftId)) {
      setFailed('Invalid ability draft address.')
      return
    }
    let alive = true

    void (async () => {
      try {
        const { first, all } = await loadSkillInventory(scope?.spaceId ?? null)

        if (!alive) {
          return
        }
        setInventory(first)
        setSkills(all)
        const stored = readAbilityDraft(owner, draftId, abilityKind)
        const now = new Date().toISOString()
        // A RESTORED session is not dirty exactly when it still equals the record it
        // opened on, so the storage writer must know which it is before it may decide
        // that "not dirty" means "nothing to lose".
        const restored = stored !== null
        const record: AbilityDraftRecord = stored ?? {
          version: 1,
          owner,
          draftId,
          kind: abilityKind,
          createdAt: now,
          updatedAt: now,
          authoredDraft: { name: '', description: '', instructions: '', attachments: [] },
          creationSettings: {
            home: ROLE_SCOPE.personal,
            space,
            availability: ABILITY_AVAILABILITY_MODE.allProjects,
            projects: [],
          },
        }
        createdAtRef.current = record.createdAt
        // Both refs belong to the session being opened, not to the page: a `+ New`
        // navigation reuses this component, so a signature left from the previous
        // draft would answer for this one.
        writtenRef.current = null
        editing.startSession({
          id: `ability-draft:${owner}:${draftId}`,
          // Personal publication is always writable for the draft owner. Shared
          // placements stay disabled below and are still authorization-checked by REST.
          canWrite: true,
          draft: {
            isNew: true,
            documentKind: 'ability',
            abilityKind,
            abilityDraft: { owner, draftId, restored },
            abilityNameFallback: `${abilityKind}-${draftId
              .replace(/[^A-Za-z0-9]/g, '')
              .slice(0, 16)
              .toLowerCase()}`,
            slug: '',
            directory: '',
            content: record.authoredDraft.instructions || '# ',
            tags: [],
            noteType: DEFAULT_NOTE_TYPE,
            abilityDescription: record.authoredDraft.description,
            attachments: record.authoredDraft.attachments,
            abilityHome: record.creationSettings.home,
            abilitySpace: record.creationSettings.space || space,
            abilitySpaceId: scope?.spaceId ?? '',
            abilityAvailability: record.creationSettings.availability,
            abilityProjects: record.creationSettings.projects,
            createdAt: null,
          },
          discardMessage: `Your new ${abilityKind} has not been published.`,
          onDiscard: () => removeAbilityDraft(owner, draftId),
          onCancel: () =>
            navigate(abilityKind === ABILITY_KIND.role ? agentRolesRoute() : agentSkillsRoute(), {
              replace: true,
            }),
          save: async (payload) => {
            const editor = editorRef.current
            const identity = {
              name: payload.name ?? '',
              description: payload.description ?? '',
              instructions: payload.content ?? '',
            }
            // Publication names projects by HANDLE — the package does not exist yet,
            // so there is nothing to key a reach by id against. Everywhere after
            // this the reach is stated in ids.
            const covered = editor.abilityProjects.flatMap((id) => {
              const project = first.projects.find((entry) => entry.id === id)
              return project ? [project.handle] : []
            })

            if (abilityKind === ABILITY_KIND.role) {
              // Two answers, not three: Personal, or the Space with the projects it
              // covers. "Only these projects" is a Space role with a chosen reach —
              // one package, several projects, which is what a copy used to be for.
              const input =
                editor.abilityHome === ROLE_SCOPE.personal
                  ? ({
                      ...identity,
                      scope: ROLE_SCOPE.personal,
                      attachments: editor.attachments,
                    } as const)
                  : ({
                      ...identity,
                      scope: ROLE_SCOPE.space,
                      space: editor.abilitySpace,
                      attachments: editor.attachments,
                      availability:
                        editor.abilityAvailability === ABILITY_AVAILABILITY_MODE.allProjects
                          ? ({ mode: ABILITY_AVAILABILITY_MODE.allProjects } as const)
                          : ({
                              mode: ABILITY_AVAILABILITY_MODE.selectedProjects,
                              projects: covered,
                            } as const),
                    } as const)

              return api.agentRoleCreate(input)
            }
            const input =
              editor.abilityHome === ROLE_SCOPE.personal
                ? ({ ...identity, scope: ROLE_SCOPE.personal } as const)
                : ({
                    ...identity,
                    scope: ROLE_SCOPE.space,
                    space: editor.abilitySpace,
                    availability:
                      editor.abilityAvailability === ABILITY_AVAILABILITY_MODE.allProjects
                        ? ({ mode: ABILITY_AVAILABILITY_MODE.allProjects } as const)
                        : ({
                            mode: ABILITY_AVAILABILITY_MODE.selectedProjects,
                            projects: covered,
                          } as const),
                  } as const)

            return api.agentSkillPublish(input)
          },
          onSaved: (result) => {
            const published = result as { locator: Parameters<typeof agentAbilityRoute>[0] }
            removeAbilityDraft(owner, draftId)
            invalidate(kind)
            navigate(agentAbilityRoute(published.locator), { replace: true })
          },
        })
      } catch (error) {
        if (alive) {
          setFailed(errorText(error))
        }
      }
    })()

    return () => {
      alive = false
    }
    // startSession is stable; editing itself deliberately stays out so typing
    // cannot re-seed the adapter's immutable initial draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abilityKind, canWrite, draftId, kind, navigate, owner, space, scope?.spaceId])

  useEffect(() => {
    // The route names a draft id and the editor answers for the session it was seeded
    // with; a navigation makes those two DIFFERENT drafts for one commit, and a writer
    // that takes its key from one and its body from the other files the discarded body
    // under the new key. `abilityDraftSessionOf` is that pair, resolved as one value.
    const session = abilityDraftSessionOf(editing.draft, owner, draftId)

    if (!inventory || !session) {
      return
    }
    // Read through the ref, watched through its FIELDS: `useNoteDraft` returns a
    // fresh literal on every render of the provider, and this effect's body reads the
    // document out of CodeMirror — a run per render is a cost, not a save.
    const editor = editorRef.current
    const action = abilityDraftSync({
      session,
      dirty: editor.dirty,
      written: writtenRef.current,
      build: () => {
        const now = new Date().toISOString()
        return {
          version: 1,
          owner: session.owner,
          draftId: session.draftId,
          kind: abilityKind,
          createdAt: createdAtRef.current ?? now,
          updatedAt: now,
          authoredDraft: {
            name: editor.abilityMachineName,
            description: editor.abilityDescription,
            instructions: editor.buildPayload().content ?? '',
            attachments: editor.attachments,
          },
          creationSettings: {
            home: editor.abilityHome,
            space: editor.abilitySpace,
            availability: editor.abilityAvailability,
            projects: editor.abilityProjects,
          },
        }
      },
    })

    if (action.kind === 'remove') {
      removeAbilityDraft(action.owner, action.draftId)
      writtenRef.current = null
      return
    }
    if (action.kind === 'write') {
      writtenRef.current = action.signature
      createdAtRef.current = action.record.createdAt
      writeAbilityDraft(action.record)
    }
  }, [
    abilityKind,
    draftId,
    editing.draft,
    editing.editor.abilityAvailability,
    editing.editor.abilityDescription,
    editing.editor.abilityHome,
    editing.editor.abilityMachineName,
    editing.editor.abilityProjects,
    editing.editor.abilitySpace,
    editing.editor.attachments,
    editing.editor.contentVersion,
    editing.editor.dirty,
    inventory,
    owner,
  ])

  if (failed) {
    return (
      <StateView
        tone="error"
        code="Error"
        icon={<IconX size={30} />}
        title="Couldn’t open this draft"
        description={failed}
        testId="ability-draft-error"
        actions={
          <Button
            variant="primary"
            onClick={() =>
              navigate(abilityKind === ABILITY_KIND.role ? agentRolesRoute() : agentSkillsRoute())
            }
          >
            Back to {abilityKind === ABILITY_KIND.role ? 'roles' : 'skills'}
          </Button>
        }
      />
    )
  }
  // WHOSE draft, by the same pair the writer above is keyed on: `+ New` from a draft
  // route reuses this component and the re-seed waits on the inventory read, so
  // between the two the route names one draft and the open session another. The
  // editor answers for the session, so showing it here would put the previous
  // draft's body under the new draft's address.
  if (!inventory || !editing.isEditing || !abilityDraftSessionOf(editing.draft, owner, draftId)) {
    return null
  }

  return (
    <AbilityEditorSurface projects={inventory.projects} skills={skills} spaceAvailable={canWrite} />
  )
}
