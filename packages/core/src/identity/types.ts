// Internal shapes of the identity registry. The persistence PORT
// (IdentityPersistence, IdentityRecord) lives in the knowledgeStore port —
// the domain boundary the meta-DB drivers implement; this file keeps only what
// stays private to the registry implementation.

export type AdoptResult =
  | { kind: 'noop' }
  /** The path's registry id changed (frontmatter won) — callers re-key. The id it
   *  moved OFF is deliberately not carried here: one convergence can re-arbitrate
   *  a path more than once, so the only safe source of the pair is the registry's
   *  current id for the path, read after the last hop (#327). */
  | { kind: 'adopted' }
  /** The file carries an id that already belongs to another live path — a
   *  user-copied file. The path keeps its registry id; the file's claim is
   *  ignored until its frontmatter is rewritten by a save through us. */
  | { kind: 'duplicate'; ownerPath: string }
  /** The file carries an id another SPACE durably owns. The owner is untouched
   *  and this path keeps `currentId`; convergence writes that id into the file
   *  before the note is published. canon: docs/core.md#identity */
  | { kind: 'foreign-owner'; ownerSpace: string; currentId: string }
