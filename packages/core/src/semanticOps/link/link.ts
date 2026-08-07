// link: materialize a typed wikilink from one note to another — a core helper over the
// KnowledgeStore port (composes read + write). Appends a typed-relation line
// `- <relation> [[<target>]]` to `from`'s body; the target is either a human-name
// forward reference or the reserved stable-id envelope produced by the gateway, and
// the relation rides co-located
// (the form read later — not a frontmatter block the graph would never see). Mono-typed in
// v1 (`links-to`). Idempotent: re-linking the same (relation, target) is a no-op, and the internal
// CAS write retries a lost race itself (link takes no versionToken).
// canon: docs/note-model.md#note-ontology

import type { KnowledgeStore, WriteResult } from '../../knowledgeStore'
import { isDurableScalar } from '../../libs/id'
import {
  decodeWikilinkIdentity,
  isWikilinkIdentityTarget,
  normalizeWikilinkTarget,
} from '../../libs/markdown'
import { linkKey } from '../../libs/slug'
import { normTags } from '../../libs/tags'
import type { LinkInput, LinkManyInput, LinkSpec } from './types'

/** A typed-relation line — `- <relation> [[<target>]]` (the co-located form
 *  reads for typed edges). Capture: 1 = relation, 2 = target. The
 *  relation is non-greedy so a multi-word relation still stops at the wikilink. */
const RELATION_LINE = /^[ \t]*[-*][ \t]+(.+?)[ \t]+\[\[([^\]]+?)\]\][ \t]*$/

/** Is this body line already a typed-relation line (any relation/target)? Used
 *  to keep relation lines a contiguous block on append rather than scattering
 *  single-item lists. */
const isRelationLine = (line: string): boolean => RELATION_LINE.test(line)

const assertMaterializableLink = (input: { toTitle: string; relation: string }): void => {
  if (
    !isDurableScalar(input.relation) ||
    input.relation.trim() === '' ||
    /[[\]]/u.test(input.relation)
  ) {
    throw new TypeError('link relation must be a non-blank durable label without brackets')
  }
  if (!isDurableScalar(input.toTitle) || /[[\]]/u.test(input.toTitle)) {
    throw new TypeError('link target cannot be represented as one wikilink')
  }
}

/** Does `body` already assert THIS typed relation to THIS target? Human targets use
 *  the shared name key; identity envelopes compare decoded IDs exactly because IDs
 *  are case-sensitive. Relation is trimmed-exact (a different relation to the same
 *  target is a distinct edge). */
export const hasLink = (body: string, relation: string, toTitle: string): boolean => {
  // `linkKey` — the key the RESOLVER puts this same label under. Two rungs were wrong
  // here, each merging targets the resolver keeps apart, and each merge is silent data
  // loss: the second link is reported as already present and its edge never written.
  // The bare slug merged every target with nothing sluggable onto ''; `nameKey` fixed
  // that but still flattens a path, so `journal/🎉` and `journal/✨` — two real notes
  // this branch made distinct — collapsed onto `journal` (#296).
  const normalizedWant = normalizeWikilinkTarget(toTitle)
  const wantIdentity = decodeWikilinkIdentity(normalizedWant)
  const wantReserved = isWikilinkIdentityTarget(normalizedWant)
  const wantTarget = linkKey(normalizedWant)
  const wantRelation = relation.trim()

  for (const raw of body.split('\n')) {
    const m = RELATION_LINE.exec(raw)

    if (!m) {
      continue
    }
    // Mirror parseWikilinks: an alias (`|`) / fragment (`#`) is not part of the
    // resolution target.
    const target = normalizeWikilinkTarget(m[2])
    const targetIdentity = decodeWikilinkIdentity(target)
    const targetReserved = isWikilinkIdentityTarget(target)
    let sameTarget: boolean

    if (wantIdentity != null || targetIdentity != null) {
      // Plain exact ids remain resolver addresses. Therefore a pre-envelope authored
      // `[[id]]` may be upgraded to the canonical `[[notarium-id:id|title]]` when the
      // caller selected an EXISTING id through `to`. The reverse is not safe: a
      // forward `toTitle` has no resolver proof that its human text denotes the stale
      // identity inside an existing envelope, so suppressing it would lose a distinct,
      // creatable link intent.
      sameTarget =
        wantIdentity != null &&
        (targetIdentity === wantIdentity || (!targetReserved && target === wantIdentity))
    } else if (wantReserved || targetReserved) {
      // Malformed reserved payloads are distinct tombstones, not human names: keep
      // their spelling exact instead of case-folding `%ZZ` onto `%zz`.
      sameTarget = wantReserved && targetReserved && normalizedWant === target
    } else {
      sameTarget = linkKey(target) === wantTarget
    }

    if (m[1].trim() === wantRelation && sameTarget) {
      return true
    }
  }

  return false
}

/** Append `- <relation> [[<toTitle>]]` to a note body, UNLESS the typed link is
 *  already present. PURE — no I/O. Returns the SAME string (by value) for a
 *  no-op so the orchestrator can skip a pointless write (keeping provenance
 *  honest, like edit_note). A real link always adds a non-empty body line, so —
 *  unlike an empty append — it never synthesizes a content-dedup'd baseline. */
export const applyLink = (body: string, input: { toTitle: string; relation: string }): string => {
  assertMaterializableLink(input)
  if (hasLink(body, input.relation, input.toTitle)) {
    return body
  }
  const line = `- ${input.relation} [[${input.toTitle}]]`
  const base = body.replace(/\s+$/, '')

  if (!base) {
    return line
  }
  // Glue onto a trailing relation block (single newline) so relations stay a
  // contiguous list; otherwise separate from prose with a blank line.
  const lastLine = base.slice(base.lastIndexOf('\n') + 1)
  return `${base}\n${isRelationLine(lastLine) ? '' : '\n'}${line}`
}

/** Fold several links into a body, each through applyLink — so dedup and the
 *  contiguous-relation-block glue apply per link, and the result is the same as
 *  appending them one at a time (later links see the earlier ones' lines, so a
 *  trailing relation block stays contiguous). PURE — returns the SAME string when
 *  every link was already present (the orchestrator skips a pointless write). */
export const applyLinks = (body: string, links: LinkSpec[]): string =>
  links.reduce((acc, l) => applyLink(acc, l), body)

/** read → splice ALL links → CAS-write once, with a bounded internal retry.
 *  The store is already resolved + authorised by the transport, and every
 *  target is confirmed co-located (or a forward-reference by title). Takes NO
 *  caller versionToken (idempotent by construction), so the op reads the live token
 *  itself; a lost CAS race is retried rather than surfaced as a conflict the caller
 *  can't re-pass a token for. A whole-batch no-op (every link already present)
 *  returns the live token without writing. Throws the store's noteNotFound if
 *  `from` vanished between resolution and read. */
export const linkNotesMany = async (
  store: KnowledgeStore,
  input: LinkManyInput,
): Promise<WriteResult> => {
  for (let attempt = 0; ; attempt++) {
    const from = await store.read(input.fromId)
    const fromId = from.id ?? input.fromId

    // The transport may have addressed the source through a cold/provisional id,
    // while an existing target is already materialized as the durable envelope.
    // Enforce the invariant on the authoritative source returned by read(), not on
    // the caller's alias — this is the final defence shared by every link caller.
    if (
      input.links.some(
        (link) => decodeWikilinkIdentity(normalizeWikilinkTarget(link.toTitle)) === fromId,
      )
    ) {
      throw new TypeError('a note cannot be linked to itself')
    }
    const token = from.versionToken ?? ''
    const next = applyLinks(from.content, input.links)

    if (next === from.content) {
      return { id: fromId, versionToken: token }
    } // idempotent no-op
    try {
      return await store.write({
        title: from.title ?? '',
        content: next,
        originalId: fromId,
        versionToken: token,
        // Carry tags/type forward — a write that omits them clears them (the
        // engine normalises absent tags to []); link only touches the body.
        tags: normTags(from.frontmatter?.tags),
        noteType: typeof from.frontmatter?.type === 'string' ? from.frontmatter.type : undefined,
        principal: input.principal,
        agent: input.agent,
      })
    } catch (err) {
      if ((err as { isConflict?: boolean }).isConflict && attempt < 2) {
        continue
      }
      throw err
    }
  }
}

/** Materialize ONE typed link — the single-edge case of linkNotesMany (kept as the
 *  named intent the single `link` tool calls; one write path, no duplication). */
export const linkNotes = async (store: KnowledgeStore, input: LinkInput): Promise<WriteResult> =>
  linkNotesMany(store, {
    fromId: input.fromId,
    links: [{ toTitle: input.toTitle, relation: input.relation }],
    principal: input.principal,
  })
