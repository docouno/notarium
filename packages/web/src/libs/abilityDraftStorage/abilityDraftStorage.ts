import type { AuthoredAttachment } from '@notarium/contract'
import {
  ABILITY_AVAILABILITY_MODE,
  ABILITY_KIND,
  ABILITY_SOURCE,
  AUTH_MODE,
  ROLE_SCOPE,
} from '@notarium/contract/enums'
import { isGeneratedNoteId, isSkillName, MAX_SKILL_NAME, MAX_SKILL_TOKEN } from '@notarium/core'
import { STORAGE_KEYS } from '../storageKeys'

type AbilityKind = (typeof ABILITY_KIND)[keyof typeof ABILITY_KIND]

export type AbilityDraftRecord = {
  version: 1
  owner: string
  draftId: string
  kind: AbilityKind
  createdAt: string
  updatedAt: string
  authoredDraft: {
    name: string
    description: string
    instructions: string
    attachments: AuthoredAttachment[]
  }
  creationSettings: {
    home: typeof ROLE_SCOPE.personal | typeof ROLE_SCOPE.space
    space: string
    availability:
      | typeof ABILITY_AVAILABILITY_MODE.allProjects
      | typeof ABILITY_AVAILABILITY_MODE.selectedProjects
    /** The projects the ability will cover, by stable project id. */
    projects: string[]
  }
}

/** The ONE owner of a draft namespace, for the writer and for the cleaner alike: the
 *  stable account id, never the handle — a rename must neither lose a draft nor leave
 *  one orphaned under a name nobody clears. `@system` is the lone principal of
 *  AUTH_MODE=none; a session without an account owns nothing yet. */
export const abilityDraftOwner = (
  mode: string | undefined,
  userId: string | null | undefined,
): string | null => (mode === AUTH_MODE.none ? '@system' : (userId ?? null))

const ownerPrefix = (owner: string): string =>
  `${STORAGE_KEYS.abilityDraftPrefix}${encodeURIComponent(owner)}:`

const keyOf = (owner: string, draftId: string): string => `${ownerPrefix(owner)}${draftId}`

const hasOnlyKeys = (value: object, keys: readonly string[]): boolean => {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

const scalar = (value: unknown, max = Number.POSITIVE_INFINITY): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\r\n\u0085\u2028\u2029]/u.test(value) &&
  // Persisted draft identity uses the same non-text control boundary as the wire.
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)

/** Asked, not restated. This spelled the grammar out with its own length, and the
 *  register did not see it for one character — a `u` flag. A draft that disagreed with
 *  the server about what a skill may be called reaches Save and is refused there. */
const skillName = (value: unknown): value is string =>
  typeof value === 'string' && scalar(value, MAX_SKILL_NAME) && isSkillName(value)

const validAttachment = (value: unknown): value is AuthoredAttachment => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const attachment = value as Record<string, unknown>

  if (attachment.kind === 'invalid') {
    return (
      hasOnlyKeys(attachment, ['kind', 'raw', 'reason']) &&
      // Asked, not restated — and restating it here got the number wrong: this said
      // 1 024 while core and the wire both say `MAX_SKILL_TOKEN`. A draft rejected here
      // is not a validation message, it is the whole draft dropped from session storage.
      typeof attachment.raw === 'string' &&
      [...attachment.raw].length <= MAX_SKILL_TOKEN &&
      attachment.raw.length > 0 &&
      attachment.reason === 'invalid-locator'
    )
  }
  if (
    attachment.kind !== 'exact' ||
    !hasOnlyKeys(attachment, ['kind', 'locator', 'label']) ||
    !skillName(attachment.label) ||
    !attachment.locator ||
    typeof attachment.locator !== 'object'
  ) {
    return false
  }
  const locator = attachment.locator as Record<string, unknown>

  if (
    typeof locator.packageId !== 'string' ||
    !isGeneratedNoteId(locator.packageId) ||
    locator.kind !== ABILITY_KIND.skill ||
    (locator.source !== ABILITY_SOURCE.system && locator.source !== ABILITY_SOURCE.owned)
  ) {
    return false
  }
  if (locator.source === ABILITY_SOURCE.system) {
    return hasOnlyKeys(locator, ['source', 'kind', 'packageId'])
  }
  if (
    !hasOnlyKeys(locator, ['source', 'kind', 'packageId', 'location']) ||
    !locator.location ||
    typeof locator.location !== 'object'
  ) {
    return false
  }
  const location = locator.location as Record<string, unknown>

  return (
    hasOnlyKeys(location, ['scope', 'spaceId']) &&
    (location.scope === ROLE_SCOPE.personal || location.scope === ROLE_SCOPE.space) &&
    scalar(location.spaceId)
  )
}

const validRecord = (
  value: unknown,
  owner: string,
  draftId: string,
  kind: AbilityKind,
): value is AbilityDraftRecord => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Partial<AbilityDraftRecord>

  return (
    hasOnlyKeys(record, [
      'version',
      'owner',
      'draftId',
      'kind',
      'createdAt',
      'updatedAt',
      'authoredDraft',
      'creationSettings',
    ]) &&
    record.version === 1 &&
    record.owner === owner &&
    record.draftId === draftId &&
    record.kind === kind &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    record.authoredDraft != null &&
    hasOnlyKeys(record.authoredDraft, ['name', 'description', 'instructions', 'attachments']) &&
    typeof record.authoredDraft.name === 'string' &&
    typeof record.authoredDraft.description === 'string' &&
    typeof record.authoredDraft.instructions === 'string' &&
    Array.isArray(record.authoredDraft.attachments) &&
    record.authoredDraft.attachments.length <= 64 &&
    record.authoredDraft.attachments.every(validAttachment) &&
    record.creationSettings != null &&
    hasOnlyKeys(record.creationSettings, ['home', 'space', 'availability', 'projects']) &&
    (record.creationSettings.home === ROLE_SCOPE.personal ||
      record.creationSettings.home === ROLE_SCOPE.space) &&
    typeof record.creationSettings.space === 'string' &&
    (record.creationSettings.availability === ABILITY_AVAILABILITY_MODE.allProjects ||
      record.creationSettings.availability === ABILITY_AVAILABILITY_MODE.selectedProjects) &&
    Array.isArray(record.creationSettings.projects) &&
    record.creationSettings.projects.every((project) => typeof project === 'string')
  )
}

export const readAbilityDraft = (
  owner: string,
  draftId: string,
  kind: AbilityKind,
): AbilityDraftRecord | null => {
  try {
    const key = keyOf(owner, draftId)
    const raw = sessionStorage.getItem(key)

    if (!raw) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)

    if (!validRecord(parsed, owner, draftId, kind)) {
      sessionStorage.removeItem(key)
      return null
    }

    return parsed
  } catch {
    return null
  }
}

export const writeAbilityDraft = (record: AbilityDraftRecord): void => {
  try {
    sessionStorage.setItem(keyOf(record.owner, record.draftId), JSON.stringify(record))
  } catch {
    // A disabled/full browser store degrades to an in-memory draft for this visit.
  }
}

export const removeAbilityDraft = (owner: string, draftId: string): void => {
  try {
    sessionStorage.removeItem(keyOf(owner, draftId))
  } catch {
    // Best effort: storage may be unavailable.
  }
}

export const clearAbilityDrafts = (owner: string): void => {
  try {
    const prefix = ownerPrefix(owner)

    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index)

      if (key?.startsWith(prefix)) {
        sessionStorage.removeItem(key)
      }
    }
  } catch {
    // Best effort: auth still changes even when browser storage is unavailable.
  }
}
