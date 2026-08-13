// Alias-history algebra. An alias is a RAW past human name (a former
// title/slug) the resolver still honours — so a rename never breaks the inbound
// [[Old Name]] links that point at it. Aliases live in the note's frontmatter
// (`aliases:`, Obsidian-native — survives an external re-clone) and
// in the derived index; the resolver registers nameKey(alias) keys so an old
// name resolves id-first → current name → alias-history
// (core/referenceResolver buildLinkIndex).
//
// Stored RAW, not pre-slugified: the alias stays human-readable and Obsidian-
// compatible; the resolver slugifies on lookup, exactly as it does for current
// names. Dedup is BY SLUG (two raws that slug the same are redundant for
// resolution), keeping the first raw form seen.

import { nameKey, namePathKey } from '../slug'

/** Normalise a frontmatter `aliases:` value to a string array — a YAML list or
 *  a comma-separated string, mirroring normTags; anything else means none.
 *  Blank entries are dropped (an empty alias would slug to '' and collide). */
export const normAliases = (v: unknown): string[] | undefined => {
  const arr = Array.isArray(v)
    ? (v as unknown[]).map(String)
    : typeof v === 'string'
      ? v.split(',')
      : null

  if (!arr) {
    return undefined
  }

  return arr.map((s) => s.trim()).filter(Boolean)
}

/** Dedupe raw names by a normalisation key, keeping the first raw form for each
 *  key and dropping anything that normalises to empty. The key is `nameKey` for
 *  handle/title aliases (a single token) and `namePathKey` for folder PATH
 *  aliases (`/` is a structural separator a bare name key would collapse). */
const dedupeBy = (names: Iterable<string>, keyOf: (s: string) => string): string[] => {
  const out: string[] = []
  const seen = new Set<string>()

  for (const raw of names) {
    const name = raw.trim()
    const key = keyOf(name)

    if (!key || seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(name)
  }

  return out
}

/** Dedupe raw names by their key, keeping the first raw form for each and dropping
 *  anything that normalises to empty. Keyed by `nameKey`, the one the resolver uses:
 *  on the bare slug a letterless past name would fall out of the history entirely, so
 *  renaming a note titled `🎉🎉` would break every inbound link instead of retiring it. */
export const dedupeAliases = (names: Iterable<string>): string[] => dedupeBy(names, nameKey)

/** The alias set after renaming a target from `oldName` to `newName`: the old
 *  name joins the history, and the new (now-current) name is removed from it —
 *  so an A→B→A round-trip leaves no stale self-alias, and the live name is never
 *  shadowed by its own alias (idempotent, the collision rule's other half).
 *  Returns RAW names, deduped by slug. */
export const nextAliases = (
  existing: readonly string[] | undefined,
  oldName: string,
  newName: string,
): string[] => nextAliasesMulti(existing, [oldName], [newName])

/** nextAliases generalised to an entity with MULTIPLE current names — a note
 *  carries BOTH a title and a slug, and changing either retires the
 *  old form. Every old name that is no longer current joins the history; every
 *  still-current name is dropped from it. Dedup by slug keeps the first raw form
 *  seen, so passing names title-first lets a title's raw form win over its own
 *  slug-form when the two would collide (an unrenamed slug needs no alias). */
export const nextAliasesMulti = (
  existing: readonly string[] | undefined,
  oldNames: readonly string[],
  currentNames: readonly string[],
): string[] => nextMultiBy(existing, oldNames, currentNames, nameKey)

/** The shared core of nextAliases*, parameterised by the normalisation key —
 *  `nameKey` for handle/title aliases, `namePathKey` for folder PATH aliases. */
const nextMultiBy = (
  existing: readonly string[] | undefined,
  oldNames: readonly string[],
  currentNames: readonly string[],
  keyOf: (s: string) => string,
): string[] => {
  const currentKeys = new Set(currentNames.map(keyOf).filter(Boolean))
  return dedupeBy([...(existing ?? []), ...oldNames], keyOf).filter(
    (a) => !currentKeys.has(keyOf(a)),
  )
}

/** nextAliases for folder PATH history: renaming/moving a folder from
 *  `oldPath` to `newPath` retires the old path so `[[oldPath/note]]` keeps
 *  resolving (the folder-alias pass of the reference resolver's `buildLinkIndex`).
 *  Dedup is BY `namePathKey` —
 *  paths are multi-segment, so the structural `/` must survive (a bare name key would
 *  collapse it, conflating `a/b` with `ab`), and it must be the SAME key the
 *  folder-alias pass looks these up by: on `slugifyPath` a folder whose name has no
 *  romanisable letters keys to '' and `dedupeBy` drops it, so renaming `📥` retired
 *  nothing and every `[[📥/note]]` broke. RAW paths, idempotent A→B→A. */
export const nextPathAliases = (
  existing: readonly string[] | undefined,
  oldPath: string,
  newPath: string,
): string[] => nextMultiBy(existing, [oldPath], [newPath], namePathKey)

/** nextPathAliases generalised to multiple old/current paths — the boot reconcile
 *  merges the marker's path-history ∪ the row's, and HEALS a path
 *  displaced by an external move by folding the old path in. Same key. */
export const nextPathAliasesMulti = (
  existing: readonly string[] | undefined,
  oldPaths: readonly string[],
  currentPaths: readonly string[],
): string[] => nextMultiBy(existing, oldPaths, currentPaths, namePathKey)
