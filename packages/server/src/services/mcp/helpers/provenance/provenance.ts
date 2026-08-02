// Provenance projection (read tools): a note's latest journal revision as the {who, how, when} triple + one-line footer.
// canon: docs/note-history.md#model
import { type Provenance } from '@notarium/contract/tools'

import { type SpaceStore } from '../../../spaces'

/** Project a note's latest journal revision into the provenance triple; `undefined`
 *  when the store doesn't journal or the note has no recorded history yet.
 *
 *  NOT sanitised: `principal` is a server-generated, charset-constrained id (not
 *  untrusted note-derived content), so the tool-poisoning defang doesn't apply.
 *
 *  Read-after-write: the journal append is fire-and-forget on the write path, but
 *  `store.revisions()` drains THIS note's append queue before listing — so this
 *  reflects every write whose write() has returned, even under parallel load. */
export const projectProvenance = async (
  store: SpaceStore,
  noteId: string,
): Promise<Provenance | undefined> => {
  if (!store.revisions) {
    return undefined
  }
  const { items } = await store.revisions(noteId, { offset: 0, limit: 1 })
  const latest = items[0]

  if (!latest) {
    return undefined
  }

  return { principal: latest.principal, kind: latest.kind, modifiedAt: latest.createdAt }
}

/** One-line human-readable provenance footer for the detailed read. */
export const renderProvenance = (p: Provenance): string => {
  const when = p.modifiedAt ? ` on ${p.modifiedAt}` : ''
  return p.principal
    ? `— last edited by \`${p.principal}\` (${p.kind})${when}`
    : `— last changed externally (${p.kind})${when}`
}
