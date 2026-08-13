// Pure shared resolution for wikilinks and folder-shaped references.
// canon: docs/core.md#graph-derivation · docs/note-model.md#note-ontology

import type { NoteMeta, ResolvedVia } from '../knowledgeStore'
import { RESOLVED_VIA } from '../knowledgeStore'
import {
  decodeWikilinkIdentity,
  isWikilinkIdentityTarget,
  normalizeWikilinkTarget,
} from '../libs/markdown'
import { deKebab, linkKey, nameKey, namePathKey } from '../libs/slug'
import type { FolderAlias, GhostStub, LinkIndex } from './types'

const idIndexKey = (id: string): string => `\u0000id:${id}`
const rawPathIndexKey = (path: string): string => `\u0000path:${path}`

export type FolderResolveContext = {
  aliases: readonly FolderAlias[]
  currentPaths: readonly string[]
}

/** Folder context belongs to an index build but is not itself a link key. Keeping it
 *  out of the Map prevents reserved metadata from participating in normal resolution. */
const folderContextByIndex = new WeakMap<LinkIndex, FolderResolveContext>()

const pathParts = (path: string): string[] => path.split('/').filter(Boolean)
const prefixOf = (parts: readonly string[], length: number): string =>
  parts.slice(0, length).join('/')

/** Canonicalize a folder-shaped human reference using the same precedence as note
 *  resolution: an exact live RAW path wins, then a unique key-equivalent live path,
 *  then the longest historical alias. A tie between distinct current paths is unsafe
 *  and returns null; an unknown path is returned unchanged. */
export const resolveFolderReference = (
  rawPath: string,
  aliases: readonly FolderAlias[] = [],
  currentPaths: readonly string[] = [],
): string | null => {
  if (!rawPath) {
    return ''
  }
  const rawParts = pathParts(rawPath)

  if (!rawParts.length) {
    return rawPath
  }
  const currents = [...new Set(currentPaths.filter(Boolean))]
  const currentSet = new Set(currents)
  let currentClaim: { length: number; path: string } | { length: number; path: null } | undefined

  // Find the most-specific live ancestor. Exact RAW wins a tie against an
  // equivalent spelling, but not against a LONGER historical prefix: a live
  // parent `old/` must not steal the retired child `old/sub→other`.
  for (let length = rawParts.length; length > 0; length--) {
    const rawPrefix = prefixOf(rawParts, length)

    if (currentSet.has(rawPrefix)) {
      currentClaim = { length, path: rawPath }
      break
    }
    const key = namePathKey(rawPrefix)

    if (!key) {
      continue
    }
    const matches = currents.filter((path) => namePathKey(path) === key)

    if (matches.length > 1) {
      currentClaim = { length, path: null }
      break
    }
    if (matches.length === 1) {
      const suffix = rawParts.slice(length).join('/')
      currentClaim = {
        length,
        path: suffix ? `${matches[0]}/${suffix}` : matches[0],
      }
      break
    }
  }

  type AliasClaim = { aliasLength: number; current: string; exact: boolean }
  const claims: AliasClaim[] = []

  for (const pair of aliases) {
    const aliasParts = pathParts(pair.alias)
    const aliasKey = namePathKey(pair.alias)

    if (
      !aliasKey ||
      aliasKey === namePathKey(pair.current) ||
      aliasParts.length > rawParts.length
    ) {
      continue
    }
    const rawPrefix = prefixOf(rawParts, aliasParts.length)

    if (namePathKey(rawPrefix) === aliasKey) {
      claims.push({
        aliasLength: aliasParts.length,
        current: pair.current,
        exact: rawPrefix === pair.alias,
      })
    }
  }

  const longest = claims.length ? Math.max(...claims.map((claim) => claim.aliasLength)) : 0

  if (currentClaim && currentClaim.length >= longest) {
    return currentClaim.path
  }
  if (!longest) {
    return rawPath
  }
  const mostSpecific = claims.filter((claim) => claim.aliasLength === longest)
  const exact = mostSpecific.filter((claim) => claim.exact)
  const targets = new Set((exact.length ? exact : mostSpecific).map((claim) => claim.current))

  if (targets.size !== 1) {
    return null
  }
  const current = [...targets][0]!
  const suffix = rawParts.slice(longest).join('/')
  return suffix ? `${current}/${suffix}` : current
}

const currentFoldersOf = (notes: readonly NoteMeta[]): string[] => {
  const folders = new Set<string>()

  for (const note of notes) {
    const parts = note.filePath.replace(/\.md$/i, '').split('/').slice(0, -1)

    for (let length = 1; length <= parts.length; length++) {
      folders.add(prefixOf(parts, length))
    }
  }

  return [...folders]
}

/** Add an exact stable-id address without changing the target's native key. A bare
 *  engine targets its storage path; an identity-capable read-model targets the id. */
export const registerLinkIdentity = (index: LinkIndex, id: string, targetId: string): void => {
  if (id && !index.has(idIndexKey(id))) {
    index.set(idIndexKey(id), targetId)
  }
}

export const buildLinkIndex = (
  notes: Iterable<NoteMeta>,
  folderAliases?: readonly FolderAlias[],
  /** Optional out-param: for each index key, which axis CLAIMED it —
   *  `current` (pass 1), `slug` (1.5), `note-alias` (2), `folder-alias` (3). The
   *  grooming health derivation passes one in to learn HOW each edge resolved; the
   *  hot resolve paths (engine/read-model/fake) pass none and pay nothing. A
   *  key is claimed exactly once (passes 1.5–3 only fill FREE keys), so its
   *  provenance is unambiguous. */
  provenance?: Map<string, ResolvedVia>,
  /** First-class directory inventory (empty folders included). Note-derived
   *  ancestors are always added; callers with a directory channel provide the rest. */
  currentFolders?: readonly string[],
): LinkIndex => {
  const index: LinkIndex = new Map()
  // Inventory order differs by adapter (SQL path order, insertion order, cache
  // arrival). A collision must still choose one deterministic note everywhere.
  const list = [...notes].sort((a, b) =>
    a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0,
  )
  const folderContext: FolderResolveContext = {
    aliases: folderAliases ?? [],
    currentPaths: [...new Set([...currentFoldersOf(list), ...(currentFolders ?? [])])],
  }
  folderContextByIndex.set(index, folderContext)
  const idOf = (n: NoteMeta): string => n.id ?? n.filePath // note-id or storage path (bare engine)

  const claimCurrent = (key: string, id: string): void => {
    if (!key || index.has(key)) {
      return
    }
    index.set(key, id)
    provenance?.set(key, RESOLVED_VIA.current)
  }

  // Exact RAW storage spelling is a current-name axis ahead of the normalized
  // name key. Two files may legally differ only by case or Unicode composition;
  // `[[foo]]` must then choose the literal `foo.md`, just like the engine's direct
  // reader, while a non-exact spelling still follows the deterministic normalized
  // collision rule below.
  for (const n of list) {
    const rawPath = n.filePath.replace(/\.md$/i, '')

    if (!rawPath) {
      continue
    }
    const key = rawPathIndexKey(rawPath)

    if (!index.has(key)) {
      index.set(key, idOf(n))
      provenance?.set(key, RESOLVED_VIA.current)
    }
  }

  for (const n of list) {
    if (n.id) {
      registerLinkIdentity(index, n.id, idOf(n))
    }
  }

  // Pass 1 — CURRENT names of EVERY note (path, filename, title). A live note's
  // own names always win, so no note can be shadowed by another's stale alias.
  // An EMPTY key is never registered: it is not a name, and every note whose name
  // slugs to nothing would otherwise share it — the whole non-Latin corpus resolving
  // as one arbitrary note (#296). The later passes already guarded it; pass 1 did not.
  // Axes are separate passes: literal path > filename > title. Interleaving them per
  // note lets a later title overwrite an earlier filename and makes list order part of
  // the product contract. First claimant in bytewise path order wins within an axis.
  for (const n of list) {
    claimCurrent(namePathKey(n.filePath.replace(/\.md$/, '')), idOf(n))
  }
  for (const n of list) {
    const path = n.filePath.replace(/\.md$/, '')
    claimCurrent(nameKey(path.split('/').pop() ?? ''), idOf(n))
  }
  for (const n of list) {
    claimCurrent(nameKey(n.title), idOf(n))
  }
  // Pass 1.5 — CUSTOM slugs. A user-set `slug:` is a current resolve
  // name, so [[my-slug]] reaches its note. It fills only FREE keys (never shadows
  // another live note's path/filename/title) and ranks ABOVE aliases — a live
  // custom slug beats any note's stale past name. Absent on a note whose slug is
  // the implicit title default (that key is already pass-1's slugify(title)).
  for (const n of list) {
    if (!n.slug) {
      continue
    }
    const key = nameKey(n.slug)

    if (key && !index.has(key)) {
      index.set(key, idOf(n))
      provenance?.set(key, RESOLVED_VIA.slug)
    }
  }
  // Pass 2 — ALIAS names, registered only on keys no current name (incl. a
  // custom slug) claimed (collision rule: current > slug > alias). An [[Old Name]]
  // then resolves to the note it was renamed from, unless a different live note
  // now bears that name.
  // canon: docs/note-model.md#note-ontology
  for (const n of list) {
    const id = idOf(n)

    for (const alias of n.aliases ?? []) {
      const key = nameKey(alias)

      if (key && !index.has(key)) {
        index.set(key, id)
        provenance?.set(key, RESOLVED_VIA.noteAlias)
      }
    }
  }
  // Pass 3 — FOLDER PATH aliases. A folder rename/move retires its old
  // path; for a note now under the folder's CURRENT path, register the key it
  // would have had under each OLD path, so [[oldpath/note]] still resolves to the
  // (unmoved-identity) note. LOWEST priority (current > slug > note-alias >
  // folder-alias) — fills only FREE keys, never shadowing a live note. A single
  // prefix-swap per (folder-alias, note); folder aliases are few (only renamed
  // folders), so the extra passes are cheap.
  const rawFolderAliasClaims = new Map<string, Set<string>>()
  const folderAliasClaims = new Map<string, Set<string>>()

  for (const fa of folderAliases ?? []) {
    const aliasKey = namePathKey(fa.alias)

    if (!aliasKey || aliasKey === namePathKey(fa.current)) {
      continue
    }

    for (const n of list) {
      const notePath = n.filePath.replace(/\.md$/i, '')

      // Folder membership is RAW. `Inbox` and `inbox` can be two real directories
      // on a case-sensitive medium; key-space membership made one history steal the
      // other's notes.
      if (notePath !== fa.current && !notePath.startsWith(fa.current + '/')) {
        continue
      }
      const candidate = fa.alias + notePath.slice(fa.current.length)
      const candidateParts = candidate.split('/')
      const candidateDir = candidateParts.slice(0, -1).join('/')
      const actualDir = notePath.split('/').slice(0, -1).join('/')
      const resolvedDir = resolveFolderReference(
        candidateDir,
        folderContext.aliases,
        folderContext.currentPaths,
      )

      // Re-run the shared longest-prefix/live-first rule before claiming the key.
      // A broad `old→new` must not claim `old/sub/note` when the more specific
      // `old/sub→other` history says that authored path belongs under `other`.
      if (resolvedDir !== actualDir) {
        continue
      }
      const key = namePathKey(candidate)
      const id = idOf(n)

      if (key) {
        const rawTargets = rawFolderAliasClaims.get(candidate) ?? new Set<string>()
        rawTargets.add(id)
        rawFolderAliasClaims.set(candidate, rawTargets)
        const targets = folderAliasClaims.get(key) ?? new Set<string>()
        targets.add(id)
        folderAliasClaims.set(key, targets)
      }
    }
  }

  // Exact RAW history has the same priority rung as exact RAW current paths and
  // distinguishes `Old` from `old`. Aggregate before publishing so two folder
  // identities claiming the SAME retired spelling fail closed instead of making
  // the first alias-array entry win.
  for (const [candidate, targets] of rawFolderAliasClaims) {
    const key = rawPathIndexKey(candidate)

    if (targets.size === 1 && !index.has(key)) {
      index.set(key, [...targets][0]!)
      provenance?.set(key, RESOLVED_VIA.folderAlias)
    }
  }
  for (const [key, targets] of folderAliasClaims) {
    if (targets.size === 1 && !index.has(key)) {
      index.set(key, [...targets][0]!)
      provenance?.set(key, RESOLVED_VIA.folderAlias)
    }
  }

  return index
}

/** Canonical unresolved-link payload shared by graph shaping and the reader's
 *  server-miss create flow. A create intent is offered only when its prefill can
 *  actually claim the missing last-segment key. */
export const ghostForWikilinkTarget = (
  label: string,
  folderContext?: Partial<FolderResolveContext>,
): GhostStub => {
  const normalized = normalizeWikilinkTarget(label)
  const identityEnvelope = isWikilinkIdentityTarget(normalized)
  const envelopedId = decodeWikilinkIdentity(normalized)

  if (identityEnvelope) {
    return {
      id: `ghost:${normalized}`,
      title: envelopedId ?? normalized,
      target: normalized,
      prefillTitle: envelopedId ?? normalized,
      creatable: false,
    }
  }
  const path = namePathKey(normalized)
  const last = path.split('/').pop() || ''
  const target = linkKey(normalized)
  const rawParts = normalized.replaceAll('\\', '/').split('/')
  const rawDirectoryParts = rawParts.slice(0, -1)
  let safeDirectory: string | null = ''

  if (normalized.includes('\0') || normalized.replaceAll('\\', '/').startsWith('/')) {
    safeDirectory = null
  } else {
    const clean: string[] = []

    for (const segment of rawDirectoryParts) {
      if (!segment || segment === '.') {
        continue
      }
      if (segment === '..' || segment.startsWith('.')) {
        safeDirectory = null
        break
      }
      clean.push(segment)
    }
    if (safeDirectory !== null) {
      safeDirectory = clean.join('/')
    }
  }
  const prefillDirectory =
    safeDirectory == null
      ? null
      : resolveFolderReference(safeDirectory, folderContext?.aliases, folderContext?.currentPaths)

  if (!last || prefillDirectory == null) {
    return {
      id: `ghost:${target}`,
      title: normalized || label.trim(),
      target,
      prefillTitle: '',
      creatable: false,
    }
  }
  const candidate = nameKey(normalized) === last ? normalized : deKebab(last)
  const prefillTitle =
    nameKey(candidate) === last ? candidate : (normalized.split('/').pop() ?? '').trim()

  return {
    id: `ghost:${target}`,
    title: prefillTitle,
    target,
    prefillTitle,
    ...(prefillDirectory ? { prefillDirectory } : {}),
    creatable: nameKey(prefillTitle) === last,
  }
}

/** Resolve one [[wikilink]] label against the index: the slugged full form
 *  first ("dir/note"), then the bare last segment. A miss yields a ghost stub
 *  whose prefill title is guaranteed to slug back to the ghost's target — so a
 *  note created from it resolves the link that produced it. */
export const resolveLink = (
  label: string,
  index: LinkIndex,
  /** The provenance map from `buildLinkIndex`. When present, a hit reports
   *  `resolvedVia` — the axis that claimed the matched key. Omit it on the hot path. */
  provenance?: Map<string, ResolvedVia>,
): { targetId: string; ghost?: GhostStub; resolvedVia?: ResolvedVia } => {
  const normalized = normalizeWikilinkTarget(label)
  const identityEnvelope = isWikilinkIdentityTarget(normalized)
  const envelopedId = decodeWikilinkIdentity(normalized)
  // Canonical resolver order is id-first. Plain ids remain supported when they
  // contain no wikilink syntax; the reserved envelope makes this axis total.
  const exactId = identityEnvelope ? envelopedId : normalized
  const byId = exactId == null ? undefined : index.get(idIndexKey(exactId))

  if (byId !== undefined) {
    return { targetId: byId, resolvedVia: RESOLVED_VIA.current }
  }
  if (identityEnvelope) {
    // The reserved namespace is identity-only. Never reinterpret a stale/deleted id
    // as a human title or path: a decoy note whose name resembles the envelope must
    // not capture the edge. Keep it as a distinct ghost for graph-health reporting.
    const ghost = ghostForWikilinkTarget(normalized, folderContextByIndex.get(index))
    return { targetId: ghost.id, ghost }
  }
  const exactPathKey = rawPathIndexKey(normalized)
  const byExactPath = index.get(exactPathKey)

  if (byExactPath !== undefined) {
    return { targetId: byExactPath, resolvedVia: provenance?.get(exactPathKey) }
  }
  // `namePathKey` is total where `slugifyPath` is not: a label with nothing sluggable
  // keys on its raw form (so `[[🎉🎉]]` reaches the note `buildLinkIndex` registered
  // under the same form), and one whose LAST segment names nothing keys on '' rather
  // than on the folder-shaped junk `docs/` that merged every such link into one ghost.
  const path = namePathKey(normalized)
  const last = path.split('/').pop() || ''
  // Track WHICH key hit so provenance reads the right entry.
  let matchedKey = path
  let hit = path ? index.get(path) : undefined

  if (hit === undefined && path.includes('/')) {
    hit = index.get(last)
    matchedKey = last
  }
  if (hit !== undefined) {
    return { targetId: hit, resolvedVia: provenance?.get(matchedKey) }
  }
  // The #25 invariant, ASSERTED rather than approximated: the prefill must key back to
  // this ghost's `last`, or a note created from the ghost does not resolve the link that
  // made it. De-kebabbing is the pretty form (`dir/missing-note` → "Missing Note") and
  // the raw label is the exact one; the old test picked between them by comparing the
  // WHOLE label's key against `last`, which is a proxy that lies on a path form: for
  // `[[dir/🎉-🚀]]` it flattened to `dir`, took the de-kebab branch, and prefilled
  // `🎉 🚀` — a title keyed `🎉 🚀`, so the ghost survived its own creation and offered
  // to create the note again. Check the invariant itself and fall back to the label's
  // last segment, which satisfies it by construction (`last` IS its `nameKey`).
  const ghost = ghostForWikilinkTarget(normalized, folderContextByIndex.get(index))
  return { targetId: ghost.id, ghost }
}
