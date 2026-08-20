import type { Draft } from '../../../../composers/EditingProvider/useNoteDraft'
import type { AbilityDraftRecord } from '../../../../libs/abilityDraftStorage'

/** The persisted draft an editing session was seeded from. The pair is the point:
 *  the route names a draft id and the editor answers for the session it was seeded
 *  with, and between a navigation and the provider's re-seed those are DIFFERENT
 *  drafts — so a writer that takes its key from one and its body from the other
 *  files the body it is holding under the key it just moved to. */
export type AbilityDraftSession = {
  owner: string
  draftId: string
  /** Whether the session opened on a record read back from storage. Then "not dirty"
   *  means "still equal to what is stored", not "nothing to lose". */
  restored: boolean
}

export type AbilityDraftSyncAction =
  | { kind: 'idle' }
  | { kind: 'remove'; owner: string; draftId: string }
  | { kind: 'write'; record: AbilityDraftRecord; signature: string }

/** Compared without `updatedAt`, which moves on every pass: an unchanged draft must
 *  not spend a synchronous `setItem`. */
export const abilityDraftSignature = (record: AbilityDraftRecord): string =>
  JSON.stringify({ ...record, updatedAt: '' })

/** The live session, but only while the route and the session name the SAME draft. */
export const abilityDraftSessionOf = (
  draft: Draft | null,
  owner: string,
  routeDraftId: string,
): AbilityDraftSession | null => {
  const session = draft?.abilityDraft

  return session && session.owner === owner && session.draftId === routeDraftId ? session : null
}

/** What the persisted copy of an ability draft should become. Opening the form is not
 *  authoring: a key is written only once there is something to lose and taken back out
 *  when the last edit is reverted — but only for a session that STARTED empty, since a
 *  restored one is undirty exactly when the store already holds the text on screen. */
export const abilityDraftSync = ({
  session,
  dirty,
  written,
  build,
}: {
  session: AbilityDraftSession | null
  dirty: boolean
  /** The signature of the record this page last persisted, or null for none. */
  written: string | null
  build: () => AbilityDraftRecord
}): AbilityDraftSyncAction => {
  if (!session) {
    return { kind: 'idle' }
  }
  if (!dirty) {
    return !session.restored && written !== null
      ? { kind: 'remove', owner: session.owner, draftId: session.draftId }
      : { kind: 'idle' }
  }
  const record = build()
  const signature = abilityDraftSignature(record)

  return signature === written ? { kind: 'idle' } : { kind: 'write', record, signature }
}
