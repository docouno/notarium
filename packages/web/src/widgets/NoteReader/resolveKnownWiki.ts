import {
  decodeWikilinkIdentity,
  isVisibleOn,
  isWikilinkIdentityTarget,
  normalizeWikilinkTarget,
  SURFACE,
} from '@notarium/core'

import type { NoteView } from '../../libs/wire'

/** Resolve only identities a partial session inventory can prove. Human names and
 *  storage paths depend on notes the client may not have loaded: an unseen note's
 *  plain id outranks even an exact path hit. Those targets always go to the
 *  authoritative server resolver; only a known stable id is locally conclusive. */
export const resolveKnownWiki = (target: string | null, notes: readonly NoteView[]) => {
  if (!target) {
    return null
  }
  const normalized = normalizeWikilinkTarget(target)

  if (!normalized) {
    return null
  }
  const identityEnvelope = isWikilinkIdentityTarget(normalized)
  const identity = identityEnvelope ? decodeWikilinkIdentity(normalized) : normalized
  const byId =
    identity == null
      ? undefined
      : notes.find((note) => note.id === identity && isVisibleOn(SURFACE.graph, note.class))

  if (byId || identityEnvelope) {
    return byId ?? null
  }

  return null
}
