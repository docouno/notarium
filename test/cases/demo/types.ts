// The demo world's AUTHORED STRINGS, bundled per locale (#256). The demo case
// (`cases/demo.ts`) owns the world's SHAPE — folders, dates, who edited what, the
// link web, the activity spread — and addresses every note by a stable `key`. A
// locale bundle owns only what a reader sees: paths, titles, bodies, tags.
//
// That split is the whole point. Adding a locale can never move a note, change a
// revision chain or reshuffle the heatmap — it can only re-word the pixels — so a
// screenshot set stays comparable across languages and a translator can't break
// the fixture. The product's UI chrome is NOT localized yet (no i18n layer as of
// #256), so today only `en` exists; the bundle shape is what makes adding the
// other eight a translation job rather than a rewrite.

/** One authored note. `path` is space-relative and localized too: the folder
 *  names a reader sees in the tree fall out of it, so a locale gets its own
 *  folder wording without the case knowing. */
export type DemoNote = {
  /** Stable, locale-independent handle — how the case refers to this note. */
  key: string
  /** Space-relative storage path, e.g. `architecture/ingest-pipeline.md`. */
  path: string
  title: string
  /** Storage-format body INCLUDING the leading `# title` H1 (both engines
   *  normalise it away on read — see generators.noteBody). */
  body: string
  tags?: string[]
}

/** One later edit's replacement body, keyed to the note it rewrites. The case
 *  decides WHEN each edit lands and WHO signs it; the bundle only says what the
 *  note read like afterwards. `step` correlates the two (0 = the first edit). */
export type DemoEdit = {
  key: string
  step: number
  body: string
  /** A rename landing with this edit (#160 — a title change in the history). */
  title?: string
}

export type DemoBundle = {
  locale: string
  /** The workspace's display name — the rail's space header. */
  spaceName: string
  /** The seeded user's display name (the "you" of every screenshot). */
  displayName: string
  /** The query typed into Spotlight for the search screenshot — must actually
   *  hit several notes in this bundle. */
  searchQuery: string
  notes: DemoNote[]
  edits: DemoEdit[]
  /** The line a generated note closes with, linking it back to its anchor —
   *  e.g. "Related". Without it the tail is thirteen orphans, which the dashboard
   *  correctly reports as thirteen things "to tidy" on a public screenshot. */
  relatedLabel: string
  /** The generated tail — enough everyday notes that the tree and the heatmap
   *  read as a lived-in base rather than a demo of twelve. Grouped into folders
   *  on purpose: the tree is the backdrop of EVERY frame, and twenty titles in
   *  one bucket photographs as a dumping ground, not as someone's knowledge base.
   *  `anchor` is the TITLE of the hand-authored note each one links to. */
  filler: Array<{ folder: string; anchor: string; titles: string[] }>
}
