// Public data shapes of the shared reference resolver.
// canon: docs/core.md#graph-derivation

/** A ghost's identity + create-from-ghost prefill, as the read-model
 *  registry keeps it. Degree and backlink sources are derived at shape time. */
export type GhostStub = {
  id: string
  title: string
  target: string
  prefillTitle: string
  /** Raw/current directory the create flow must use to close a path-form link. */
  prefillDirectory?: string
  /** False for a missing stable identity: minting a different note cannot close it. */
  creatable: boolean
}

/** internal resolve key → node id. Keys cover the exact stable-id namespace plus
 *  every way a [[wikilink]] names a note: the
 *  slugged full path, the slugged filename, the slugged title, the note's custom
 *  display slug, and — so a rename never breaks inbound links —
 *  the slug of each past name (alias). */
export type LinkIndex = Map<string, string>

/** One raw current folder path and one retired raw path, supplied by callers from
 *  the space's folder history. */
export type FolderAlias = { current: string; alias: string }
