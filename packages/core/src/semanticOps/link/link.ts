// link: materialize a typed wikilink from one note to another — a core helper over the
// KnowledgeStore port (composes read + write). Appends a typed-relation line
// `- <relation> [[<target title>]]` to `from`'s body; the graph resolves the `[[…]]` by SLUGGED
// TITLE (not id), so the edge works in prod and the fake alike, and the relation rides co-located
// (the form read later — not a frontmatter block the graph would never see). Mono-typed in
// v1 (`links-to`). Idempotent: re-linking the same (relation, target) is a no-op, and the internal
// CAS write retries a lost race itself (link takes no versionToken).
// canon: docs/note-model.md#note-ontology

import type { KnowledgeStore, WriteResult } from '../../knowledgeStore'
import { slugify } from '../../libs/slug'
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

/** Does `body` already assert THIS typed relation to THIS target? Idempotency
 *  keys on (relation, slugged-target): re-linking the same pair is a no-op (spec
 *  §4). Target is compared by slug so a prior link written with a slightly
 *  different title casing still matches; relation is compared trimmed-exact (a
 *  different relation to the same target is a DISTINCT typed edge, not a dupe). */
export const hasLink = (body: string, relation: string, toTitle: string): boolean => {
  const wantTarget = slugify(toTitle)
  const wantRelation = relation.trim()

  for (const raw of body.split('\n')) {
    const m = RELATION_LINE.exec(raw)

    if (!m) {
      continue
    }
    // Mirror parseWikilinks: an alias (`|`) / fragment (`#`) is not part of the
    // resolution target.
    const target = m[2].split('|')[0].split('#')[0].trim()

    if (m[1].trim() === wantRelation && slugify(target) === wantTarget) {
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
