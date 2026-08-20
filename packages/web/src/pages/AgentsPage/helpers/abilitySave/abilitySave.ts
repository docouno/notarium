import type {
  AgentAbilityAvailabilityState,
  AuthoredAttachment,
  OwnedAbilityLocator,
} from '@notarium/contract'
import { ABILITY_AVAILABILITY_MODE, ABILITY_KIND, ROLE_SCOPE } from '@notarium/contract/enums'
import type { SaveInput } from '../../../../libs/wire'

type OwnedRoleLocator = Extract<OwnedAbilityLocator, { kind: 'role' }>

/** Whether two reaches are the same answer. The wire states the projects ordered by
 *  id and the editor in the order the user ticked them, so only the SET is the
 *  answer — comparing the serialized shapes would call the endpoint on every save. */
export const sameAbilityReach = (
  left: AgentAbilityAvailabilityState,
  right: AgentAbilityAvailabilityState,
): boolean => {
  if (
    left.mode === ABILITY_AVAILABILITY_MODE.allProjects ||
    right.mode === ABILITY_AVAILABILITY_MODE.allProjects
  ) {
    return left.mode === right.mode
  }
  const covered = new Set(left.projectIds)
  const next = new Set(right.projectIds)

  return covered.size === next.size && [...next].every((id) => covered.has(id))
}

/** What one Save has already committed, as ONE value. The edit lands in up to three
 *  writes on three endpoints, so a failure part-way leaves work behind that the next
 *  attempt must CONTINUE from — and the first thing it leaves behind is an ADDRESS:
 *  a home move physically relocates the package, so every later write, the document
 *  write included, has to be addressed at where it now is. Keeping the address here,
 *  next to what has already landed, is what makes a stale-address retry unwritable. */
export type AbilitySaveProgress = {
  /** Where the package lives right now. */
  locator: OwnedAbilityLocator
  /** Whether a step of this edit relocated it. */
  moved: boolean
  /** The reach already applied AT `locator`; null while this edit has applied none. */
  reach: AgentAbilityAvailabilityState | null
  /** The version the document carries after a landed write; undefined hands the
   *  question back to the session (whose conflict flow supplies the next one). */
  versionToken: string | undefined
}

export const abilitySaveProgress = (locator: OwnedAbilityLocator): AbilitySaveProgress => ({
  locator,
  moved: false,
  reach: null,
  versionToken: undefined,
})

/** Has any step of this edit reached the server? From that moment the page's loaded
 *  detail is stale, so abandoning the edit has to re-read rather than keep showing it. */
export const abilitySaveLanded = (progress: AbilitySaveProgress): boolean =>
  progress.moved || progress.reach !== null || progress.versionToken !== undefined

/** The placement the user left in the editor at Save time. */
export type AbilitySaveAnswer = {
  /** The projects the ability covers, or null for the whole Space. */
  covers: readonly string[] | null
  /** The authored attachment list when the user changed it; null leaves it alone. */
  attachments: readonly AuthoredAttachment[] | null
}

export type AbilitySaveEffects<S extends { versionToken: string }> = {
  saveDocument: (payload: SaveInput) => Promise<S>
  moveHome: (
    locator: OwnedRoleLocator,
  ) => Promise<{ locator: OwnedRoleLocator; availability: AgentAbilityAvailabilityState }>
  setReach: (locator: OwnedAbilityLocator, reach: AgentAbilityAvailabilityState) => Promise<void>
}

/** One Save owns the whole edit: where an ability belongs and how far it reaches are
 *  settings rather than authored bytes, so they travel on their own endpoints — but
 *  they leave WITH the document. Each step is skipped when `progress` says it already
 *  landed, so a retry continues instead of replaying, and every step (the document
 *  write included) is addressed at `progress.locator` rather than at the address the
 *  editing session was seeded with.
 *  canon: docs/web-ui.md#web-react */
export const runAbilitySave = async <S extends { versionToken: string }>({
  progress,
  commit,
  payload,
  noteId,
  versionToken,
  seedReach,
  answer,
  effects,
}: {
  progress: AbilitySaveProgress
  /** Fold a landed step into the one value the retry and the page both read. */
  commit: (next: AbilitySaveProgress) => void
  /** The document payload — addressless: the address is this run's to state. */
  payload: SaveInput
  noteId: string
  /** The version the editing session pinned when the edit started. */
  versionToken: string | undefined
  /** The reach the ability carried when the edit started. */
  seedReach: AgentAbilityAvailabilityState | null
  answer: AbilitySaveAnswer
  effects: AbilitySaveEffects<S>
}): Promise<S> => {
  let current = progress

  const fold = (next: AbilitySaveProgress) => {
    current = next
    commit(next)
  }
  const attachments =
    answer.attachments && current.locator.kind === ABILITY_KIND.role
      ? {
          abilityLocator: current.locator as OwnedRoleLocator,
          attachments: [...answer.attachments],
        }
      : {}
  let saved: S

  try {
    saved = await effects.saveDocument({
      ...payload,
      ...attachments,
      originalId: noteId,
      versionToken: current.versionToken ?? versionToken,
    })
  } catch (error) {
    // The document write owns the token; if it failed, ours is not the truth and the
    // session's conflict flow supplies the next one.
    fold({ ...current, versionToken: undefined })
    throw error
  }
  fold({ ...current, versionToken: saved.versionToken })
  const covers = answer.covers ? [...new Set(answer.covers)] : null
  const home = current.locator.location
  const stillItsOwnProject =
    home.scope === ROLE_SCOPE.project &&
    covers != null &&
    covers.length === 1 &&
    covers[0] === home.projectId

  // Covering anything other than exactly its own project is something only a Space
  // home can do, so a project role given a wider answer relocates. The user is not
  // asked about it: which projects it covers is the question, where the package sits
  // is our business.
  if (
    current.locator.kind === ABILITY_KIND.role &&
    current.locator.location.scope === ROLE_SCOPE.project &&
    !stillItsOwnProject
  ) {
    const moved = await effects.moveHome(current.locator as OwnedRoleLocator)
    // The move states the reach it kept, so the step after it compares against the
    // truth rather than against what the page loaded.
    fold({ ...current, locator: moved.locator, moved: true, reach: moved.availability })
  }

  if (current.locator.location.scope === ROLE_SCOPE.space) {
    const next: AgentAbilityAvailabilityState =
      covers == null
        ? { mode: ABILITY_AVAILABILITY_MODE.allProjects }
        : { mode: ABILITY_AVAILABILITY_MODE.selectedProjects, projectIds: covers }
    const previous = current.reach ?? seedReach ?? { mode: ABILITY_AVAILABILITY_MODE.allProjects }

    if (!sameAbilityReach(previous, next)) {
      await effects.setReach(current.locator, next)
      fold({ ...current, reach: next })
    }
  }

  return saved
}
