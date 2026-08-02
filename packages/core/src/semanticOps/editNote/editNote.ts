// edit_note: incremental note editing as a core helper over the port (composes read + write).
// Two parts: applyEdit — PURE (body + operation → new body, no I/O; throws EditError for an
// unsatisfiable op like a missing section or ambiguous find); editNote — read → splice → CAS-write.
// It READS the live note for the current token (CachedStore demands one for an originalId update)
// and writes with THAT; the caller's optional versionToken is a conflict GUARD. A true no-op writes
// NOTHING and returns the current token — idempotent, and avoids journaling a synthesized baseline
// that would misattribute the note.

import type { KnowledgeStore } from '../../knowledgeStore'
import { StoreError, versionConflict } from '../../knowledgeStore'
import { sha256Hex } from '../../libs/hash'
import { replaceMarkdownSection, stripFrontmatter, stripTitleHeading } from '../../libs/markdown'
import { normTags } from '../../libs/tags'
import { EDIT_OPERATION } from './consts'
import type { EditNoteInput, EditResult } from './types'

/** A caller-fault edit error: an unsatisfiable operation (no such section, a
 *  `find` that is missing or ambiguous, a missing required argument). A
 *  StoreError subclass carrying `isToolError`, so it speaks the SAME error
 *  vocabulary every engine and host already share (knowledgeStore/storeError) —
 *  the host maps the flag, not the class, to an actionable 400-class tool error. */
export class EditError extends StoreError {
  isToolError = true as const
}

/** Apply one edit operation to a note body. PURE — no I/O. Returns the new body,
 *  or the SAME string (referentially, when nothing changed) for a true no-op so
 *  the orchestrator can skip a pointless write. Throws EditError when the
 *  operation cannot be satisfied. */
export const applyEdit = (body: string, input: EditNoteInput): string => {
  const { operation, content, section, find } = input

  switch (operation) {
    case EDIT_OPERATION.append: {
      if (!content) {
        return body
      } // empty append = no-op (no spurious revision)
      const base = body.replace(/\s+$/, '')
      return base ? `${base}\n\n${content}` : content
    }
    case EDIT_OPERATION.prepend: {
      if (!content) {
        return body
      }
      const rest = body.replace(/^\s+/, '')
      return rest ? `${content}\n\n${rest}` : content
    }
    case EDIT_OPERATION.replace: {
      // The whole body, verbatim — a full rewrite with no matching. An empty
      // `content` legitimately CLEARS the note (the no-op guard in editNote still
      // catches replacing the body with what it already was).
      return content
    }
    case EDIT_OPERATION.replaceSection: {
      if (section === undefined || section.trim() === '') {
        throw new EditError('replaceSection requires a `section` (the heading to replace under).')
      }
      const res = replaceMarkdownSection(body, section, content)

      if (!res.ok) {
        const present = res.headings.length
          ? ` Headings present: ${res.headings.map((h) => `"${h}"`).join(', ')}.`
          : ' The note has no headings.'
        throw new EditError(`No section titled "${section}".${present}`)
      }

      return res.body
    }
    case EDIT_OPERATION.findReplace: {
      if (find === undefined || find === '') {
        throw new EditError('findReplace requires a non-empty `find` (the exact text to replace).')
      }
      const first = body.indexOf(find)

      if (first === -1) {
        throw new EditError(
          'The text in `find` was not found. Re-read the note and copy an exact snippet to replace.',
        )
      }
      if (body.indexOf(find, first + find.length) !== -1) {
        throw new EditError(
          'The text in `find` appears more than once — include enough surrounding context to make it unique.',
        )
      }
      if (find === content) {
        return body
      } // replacing text with itself = no-op
      const before = body.slice(0, first)
      const after = body.slice(first + find.length)

      // Empty `content` = DELETE the snippet (the word-based "remove this fact"
      // path, esp. for a memory observation). Heal the seam WITHOUT damaging
      // structure: strip ONLY the blank-line runs that bordered the snippet (a run
      // of newlines, each with optional inline whitespace — never the next content
      // line's indentation), then rejoin with the LARGER of the two original
      // separators, capped at one blank line. So a paragraph (\n\n) leaves one
      // blank, a tight list line (\n) stays a list (no injected blank), an inline
      // snippet just closes up (no paragraph break), and deleting the first/last
      // block drops its dangling separator. Newline-style agnostic (\n or \r\n).
      if (content === '') {
        const beforeSep = before.match(/(?:[ \t]*\r?\n)+$/)?.[0] ?? ''
        const afterSep = after.match(/^(?:[ \t]*\r?\n)+/)?.[0] ?? ''
        const b = before.slice(0, before.length - beforeSep.length)
        const a = after.slice(afterSep.length)

        if (!b) {
          return a
        } // deleted the first block — no leading separator to keep
        if (!a) {
          return b
        } // deleted the last block — no trailing separator to keep
        const countNl = (s: string): number => (s.match(/\n/g) ?? []).length
        const nl = Math.min(Math.max(countNl(beforeSep), countNl(afterSep)), 2)
        return nl > 0 ? `${b}${'\n'.repeat(nl)}${a}` : b + a
      }

      return before + content + after
    }
  }
}

/** read → splice → CAS-write. The store is already resolved and authorised by
 *  the transport. Throws: EditError (bad operation), the store's versionConflict
 *  (stale token), the store's noteNotFound (the note vanished between
 *  resolution and read). */
export const editNote = async (
  store: KnowledgeStore,
  input: EditNoteInput,
): Promise<EditResult> => {
  const note = await store.read(input.noteId)
  const current = note.versionToken ?? ''
  const id = note.id ?? input.noteId

  // Conflict guard: if the caller told us what they read, hold them to it — a
  // stale token means the note moved under them, so refuse instead of clobber.
  if (input.versionToken && input.versionToken !== current) {
    throw versionConflict({ ...note, id, versionToken: current })
  }
  const next = applyEdit(note.content, input)
  // No-op detection mirrors the journal's content normalisation
  // (stripTitleHeading∘stripFrontmatter) — not raw equality — so an edit whose
  // result is EFFECTIVELY unchanged (an empty append, or prepending the title
  // heading the reader strips back off) writes NOTHING. A spurious write here
  // would lay down a synthesized 'external' baseline; the real revision then
  // dedups to nothing against it, leaving the baseline as the latest, so
  // read_note would report {principal:null, kind:'external'} for a note the
  // agent just touched. Skipping keeps provenance honest.
  const normalise = (body: string): string => stripTitleHeading(stripFrontmatter(body), note.title)

  if (normalise(next) === normalise(note.content)) {
    return { id, versionToken: current }
  }
  // Carry the note's tags/type forward: an edit changes only the body, but a
  // write that omits them would clear them (the engine normalises absent tags to
  // []), exactly as the UI editor re-sends them. No directory → the note stays
  // in its current mount/folder; the class is never relabelled on an edit.
  const r = await store.write({
    title: note.title ?? '',
    content: next,
    originalId: id,
    versionToken: current,
    tags: normTags(note.frontmatter?.tags),
    noteType: typeof note.frontmatter?.type === 'string' ? note.frontmatter.type : undefined,
    principal: input.principal,
  })
  // Integrity echo: hash the body THIS edit wrote (`next`). For
  // `replace` the agent can recompute it from its own `content`; for the surgical
  // modes it confirms the post-edit size/hash without a get_note. Same caveat as
  // create_note — the engine may strip a leading inline-frontmatter/`# title` on
  // store, so this echoes what we sent the engine, not a re-read of disk.
  return {
    ...r,
    bodyBytes: Buffer.byteLength(next, 'utf8'),
    bodyHash: await sha256Hex(next),
  }
}
