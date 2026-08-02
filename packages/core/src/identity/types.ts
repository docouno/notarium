// Internal shapes of the identity registry. The persistence PORT
// (IdentityPersistence, IdentityRecord) lives in the knowledgeStore port —
// the domain boundary the meta-DB drivers implement; this file keeps only what
// stays private to the registry implementation.

export type AdoptResult =
  | { kind: 'noop' }
  /** The path's registry id changed (frontmatter won) — callers re-key. */
  | { kind: 'adopted'; previousId: string | null }
  /** The file carries an id that already belongs to another live path — a
   *  user-copied file. The path keeps its registry id; the file's claim is
   *  ignored until its frontmatter is rewritten by a save through us. */
  | { kind: 'duplicate'; ownerPath: string }
