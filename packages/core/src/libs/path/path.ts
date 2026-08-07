import { pathHash } from '../hash'
import { isDurableScalar } from '../id'
import { idToSlug, slugify } from '../slug'
import { CLIPPED_NAME_TAG_BYTES, FOLDER_PAGE_FILENAME, NOTE_BASENAME_MAX_BYTES } from './consts'

/** Directory part of a slash-separated path ('' for a root-level file). */
export const directoryOf = (filePath: string): string => {
  if (!filePath) {
    return ''
  }
  const i = filePath.lastIndexOf('/')
  return i === -1 ? '' : filePath.slice(0, i)
}

/** Filename part of a slash-separated path (the whole string for a root-level file). */
export const basenameOf = (filePath: string): string => {
  const i = filePath.lastIndexOf('/')
  return i === -1 ? filePath : filePath.slice(i + 1)
}

/** Is this note the PAGE of its folder? True for a `<folder>/index.md` (or a
 *  root-level `index.md`). The folder a page belongs to is just `directoryOf` it. */
export const isFolderPageNote = (filePath: string): boolean =>
  basenameOf(filePath) === FOLDER_PAGE_FILENAME

/** Space-relative file path of a folder's page note: `<folderPath>/index.md`
 *  (or `index.md` at the space root). */
export const folderPageFilePath = (folderPath: string): string =>
  folderPath ? `${folderPath}/${FOLDER_PAGE_FILENAME}` : FOLDER_PAGE_FILENAME

/** Exact operation-owned staging directory name used while publishing a package. */
export const isAtomicInstallTempName = (name: string): boolean =>
  /^\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.install-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(
    name,
  )

/** A staging path is reserved only at a Personal/Space library root or at the
 * exact `_projects/<encoded-id>` root. Same-looking package resources are data. */
export const isAtomicInstallTempPath = (path: string): boolean => {
  const parts = path.split('/')
  const name = parts.at(-1) ?? ''

  return (
    isAtomicInstallTempName(name) &&
    (parts.length === 1 || (parts.length === 3 && parts[0] === '_projects' && Boolean(parts[1])))
  )
}

/** UTF-8 size of one code point — counted, not encoded: this runs per character of
 *  every title and core is bundled for the browser too, so no Buffer and no
 *  TextEncoder allocation per name. */
const utf8Size = (codePoint: number): number =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4

export const utf8ByteLength = (value: string): number => {
  let bytes = 0

  for (const char of value) {
    bytes += utf8Size(char.codePointAt(0)!)
  }

  return bytes
}

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu

export const isPortablePathComponent = (component: string, maxBytes = 255): boolean =>
  component.length > 0 &&
  utf8ByteLength(component) <= maxBytes &&
  !/[\\/<>:"|?*]/u.test(component) &&
  !/[. ]$/u.test(component) &&
  !WINDOWS_DEVICE_NAME.test(component)

/** Filesystem-portable component fence (ext4/APFS/NTFS: 255 UTF-8 bytes).
 *  Structural safety (`..`, absolute, controls) remains the caller's concern. */
export const hasPortablePathComponents = (path: string, maxBytes = 255): boolean =>
  path
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .every((segment) => isPortablePathComponent(segment, maxBytes))

/** Structural normalization for an existing public entry. Unlike a destination
 * fence it deliberately accepts legacy POSIX-only components (`foo:bar`): data
 * already returned by list/tree must remain addressable for read/move/delete. */
export const normalizeSafeRelativeAddress = (input: string): string | null => {
  if (!isDurableScalar(input)) {
    return null
  }
  const raw = input

  if (raw.startsWith('/')) {
    return null
  }
  const parts: string[] = []

  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..' || segment.startsWith('.')) {
      return null
    }
    parts.push(segment)
  }

  return parts.join('/')
}

/** Normalize one untrusted, mount-relative path without ever letting it address a
 * hidden/internal namespace. This is deliberately stricter than `path.normalize`:
 * `..` is rejected (not resolved), absolute paths are rejected, and dot-prefixed
 * components belong to the engine rather than callers. Backslashes are accepted at
 * the transport boundary and canonicalized to `/`; engine ports use the exact-form
 * predicate below so path prediction cannot disagree with persistence. */
export const normalizeSafeRelativePath = (input: string): string | null => {
  const normalized = normalizeSafeRelativeAddress(input.replaceAll('\\', '/'))

  if (normalized === null || !hasPortablePathComponents(normalized)) {
    return null
  }

  return normalized
}

/** A canonical destination path at an engine boundary: already normalized,
 * relative, public, and portable. Empty is the mount root. */
export const isCanonicalSafeRelativePath = (input: string): boolean =>
  normalizeSafeRelativePath(input) === input

/** Existing POSIX entries may predate the portability fence (for example
 * `foo:bar`). They must remain addressable for move/delete, while retaining the
 * structural and hidden-namespace fence. */
export const isCanonicalSafeRelativeAddress = (input: string): boolean => {
  return normalizeSafeRelativeAddress(input) === input
}

/** A new destination may pass through legacy non-portable directories that
 * already exist, but every newly-created component must be portable. `hasDir`
 * is exact/raw: an equivalent case-folded spelling is not proof of ownership. */
export const isPortableRelativeDestination = (
  input: string,
  hasDir: (prefix: string) => boolean,
): boolean => {
  if (!isCanonicalSafeRelativeAddress(input)) {
    return false
  }
  if (input === '') {
    return true
  }
  let prefix = ''

  for (const component of input.split('/')) {
    prefix = prefix ? `${prefix}/${component}` : component
    if (!isPortablePathComponent(component) && !hasDir(prefix)) {
      return false
    }
  }

  return true
}

/** Compatibility fence for importer-owned deterministic paths. `root` is the
 * caller-selected destination and therefore obeys the ordinary stateful rule:
 * a non-portable component is accepted only when that exact folder already
 * exists. The suffix below it is parser-owned provenance, frozen by the import
 * contract, so legacy POSIX components such as `con` may be reproduced exactly
 * instead of moving on re-import. This channel is host-internal; public writes
 * never receive it. */
export const isLegacyImportDestination = (
  input: string,
  root: string,
  hasDir: (prefix: string) => boolean,
): boolean => {
  if (
    !isCanonicalSafeRelativeAddress(input) ||
    !isCanonicalSafeRelativeAddress(root) ||
    !isPortableRelativeDestination(root, hasDir)
  ) {
    return false
  }

  return input === root || (root ? input.startsWith(`${root}/`) : true)
}

/** Destination fence for a move. Moving an existing entry may carry its legacy
 * POSIX-only leaf verbatim into a new parent; that does not mint a new spelling.
 * Every parent component still has to be portable or already present, and a
 * rename to a different non-portable leaf remains forbidden. */
export const isPortableMoveDestination = (
  input: string,
  source: string,
  hasDir: (prefix: string) => boolean,
): boolean => {
  if (!isCanonicalSafeRelativeAddress(input)) {
    return false
  }
  const components = input.split('/')
  const sourceLeaf = basenameOf(source)
  let prefix = ''

  for (const [index, component] of components.entries()) {
    prefix = prefix ? `${prefix}/${component}` : component
    const leaf = index === components.length - 1
    const preservesLegacyLeaf = leaf && component === sourceLeaf

    if (!isPortablePathComponent(component)) {
      if (leaf ? !preservesLegacyLeaf : !hasDir(prefix)) {
        return false
      }
    }
  }

  return true
}

/** Clip a name to at most `max` UTF-8 bytes, cutting on a code POINT boundary (never
 *  mid-character, never stranding half a surrogate pair), then trimming a separator
 *  the cut exposed. Exported because every name that reaches a path component has to
 *  be measured the same way — a cap counted in CHARACTERS passes a CJK name that the
 *  filesystem then refuses. */
export const clipToBytes = (s: string, max: number): string => {
  let bytes = 0
  let out = ''

  for (const ch of s) {
    bytes += utf8Size(ch.codePointAt(0)!)

    if (bytes > max) {
      return out.replace(/[-_]+$/, '')
    }
    out += ch
  }

  return s
}

/** Keep a path-safe name byte-for-byte while it fits; only a real overflow gets a
 *  whole-value hash tail. This is the compatibility-preserving boundary used by
 *  note basenames and importer-owned directory components alike. */
export const boundNameToBytes = (s: string, max: number): string => {
  const clipped = clipToBytes(s, max)

  if (clipped === s) {
    return s
  }

  return `${clipToBytes(s, max - CLIPPED_NAME_TAG_BYTES)}-${pathHash(s)}`
}

/** The BASENAME (sans `.md`) a note's file takes — the single formula every engine,
 *  the read-model's path fence and the boot heal share, so no two of them can predict
 *  a different destination for one write.
 *
 *  An explicit `fileName` (import #11, a folder page's `index`) overrides the title —
 *  slugged anyway, so a hand-passed name can neither escape the mount nor carry path
 *  separators — and falls back to the title's own slug when it slugs to nothing.
 *
 *  The id fallback is the last rung and the reason this is one function (#296): a
 *  title of nothing but emoji or punctuation has no letters to name a file with, and
 *  an empty basename would write the dot-file `.md`, which the scan hides and the
 *  reconcile then reads as an external delete. `idToSlug` is the same fallback the
 *  space handle already uses (#123). With no id either — a bare engine writing
 *  without the read-model's registry — `note` keeps the file addressable and the
 *  ordinary create-collision policy arbitrates.
 *  canon: docs/note-model.md#note-ontology */
export const noteFileBase = (
  title: string,
  fileName?: string,
  id?: string,
  preserveLegacyPinnedName = false,
): string => {
  const pinned = fileName ? slugify(fileName) : ''
  const full = pinned || slugify(title)

  // A clip cuts the TAIL, and the tail is exactly where a distinguishing suffix lives —
  // `uniquify`'s ` 2`, Duplicate's ` copy`. Clipping alone would therefore fold a whole
  // series back onto one name, so a create could never uniquify past an occupant and
  // two genuinely different long titles could not share a folder. A tag derived from
  // the WHOLE slug restores that: it differs whenever the titles differ, which is all
  // the name has to promise.
  const selected = full || (id && idToSlug(id)) || 'note'
  // Importer filenames are a frozen storage identity. Before the portability
  // fence an explicit pin passed through whole, including POSIX-valid Windows
  // device names. Rewriting one now would make the first re-import create a
  // sibling instead of updating its historical file. Only the provenance-gated
  // host channel may request this exact legacy behaviour.

  if (preserveLegacyPinnedName && pinned) {
    return pinned
  }
  const portable = WINDOWS_DEVICE_NAME.test(selected)
    ? `~${selected}-${pathHash(selected)}`
    : selected
  return boundNameToBytes(portable, NOTE_BASENAME_MAX_BYTES)
}

/** The name rungs ABOVE the id fallback, on their own: '' means nothing in the title
 *  (nor in an explicit fileName) can name a file, so the id is what will. A caller
 *  that must settle the id BEFORE predicting the path asks this, rather than
 *  re-deriving the precedence and drifting from it. */
export const sluggedNoteName = (title: string, fileName?: string): string =>
  fileName ? slugify(fileName) || slugify(title) : slugify(title)

/** The storage path a note's file takes inside `directory` — `noteFileBase` + `.md`.
 *  `directory` is taken as given (already mount-relative and normalised); '' and '/'
 *  both mean the root. */
export const noteFilePath = (
  title: string,
  directory?: string,
  fileName?: string,
  id?: string,
  preserveLegacyPinnedName = false,
): string => {
  const dir = !directory || directory === '/' ? '' : directory.replace(/^\/+|\/+$/g, '')
  const file = `${noteFileBase(title, fileName, id, preserveLegacyPinnedName)}.md`
  return dir ? `${dir}/${file}` : file
}

/** Is `filePath` inside the folder `folderPrefix` (the folder itself or a
 *  descendant)? A space-relative folder-prefix test (project-subtree
 *  narrowing). `folderPrefix === ''` = the whole space (a root project owns it),
 *  so it always matches. Otherwise the note's DIRECTORY must equal the prefix or
 *  sit under it — a segment-boundary match, never a raw `startsWith`, so 'bill'
 *  does NOT swallow 'billing/x.md'. */
export const isPathUnder = (filePath: string, folderPrefix: string): boolean => {
  if (folderPrefix === '') {
    return true
  }
  const dir = directoryOf(filePath)
  return dir === folderPrefix || dir.startsWith(`${folderPrefix}/`)
}
