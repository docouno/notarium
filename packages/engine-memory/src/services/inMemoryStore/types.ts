import type { NoteClass } from '@notarium/core'

/** One note as seeded into / held by the in-memory engine. */
export type NoteSnapshot = {
  /** Internal note-id (P7). Fixtures may pin one; absent, the store derives a
   *  deterministic id from the seeded path (`fake-<slugged-path>`) so e2e
   *  journeys can hardcode URLs. */
  id?: string
  title: string
  /** The note's class (#78); default user-doc. Seed an agent-memory note to
   *  exercise the visibility invariant (the real engine derives this from the
   *  mount; the fake has none, so it's seeded directly). */
  class?: NoteClass
  filePath: string
  /** ISO instants (#54) — the same shape the wire serves. */
  modifiedAt?: string | null
  createdAt?: string | null
  /** Storage-format body — may start with the conventional "# <title>" H1,
   *  which read() normalises away (the conventional storage format). */
  content?: string
  /** Decorative note type (`frontmatter.type`), defaulting to `note`. */
  noteType?: string
  tags?: string[]
  /** Alias-history (#100): past human names the resolver still honours. Seed it
   *  to exercise alias resolution; a rename through write() appends to it. */
  aliases?: string[]
  /** The editable display slug (#100 phase 1): seed a CUSTOM slug to exercise the
   *  slug resolve key / canonical URL. Absent = the implicit slug(title). */
  slug?: string
  /** The agent-memory `summary` frontmatter (#21) — served back in
   *  read().frontmatter.summary, mirroring the real engine's parsed frontmatter
   *  so the derived memory index works against the fake too. */
  summary?: string
  /** The agent-memory `muted` opt-out flag (#165) — seed it to exercise the
   *  profile/audit split (muted categories stay in the audit but drop from the
   *  eager profile). Served back in read().frontmatter.muted. */
  muted?: boolean
}

export type StoreSnapshot = {
  /** The space this store serves (default "main"). */
  space?: string
  /** Fixed "now" (ISO instant) stamped onto dates by mutations. Pass it for
   *  deterministic output (the e2e fake does); defaults to the wall clock. */
  now?: string
  notes: NoteSnapshot[]
}
