// The slug algebra: a name/title → a handle, also the key the read-model resolves
// [[wikilinks]] against note identities with.
// canon: docs/note-model.md#note-ontology
// The ONLY hard requirement is internal consistency — index keys and lookups go
// through THIS function, so the exact byte form never leaks. Beyond that we aim for
// readable handles across scripts: Latin (incl. accents), the full Cyrillic block and
// Greek ROMANISE; a script we have no romaniser for (CJK, Arabic, Hebrew, Thai) keeps
// its own letters rather than being dropped.
//
// TWO axes, deliberately two functions (#296):
//   • `slugify` — the NAME axis: a note's file name, its resolve key, its URL tail.
//     Total by construction: every title with a letter or a digit in any script gets a
//     distinct, non-empty handle. Dropping the unromanisable here is what used to send
//     a CJK title to the path `.md` — a dot-file the scan hides — and collapse every
//     non-Latin note onto one empty resolve key.
//   • `asciiSlug` — the HANDLE axis: a space/project handle, which lives in a URL
//     segment and is pinned to `[a-z0-9_-]` by `SpaceSlugSchema`. It romanises and
//     returns '' when it cannot, and the caller falls back to `idToSlug` (#123).
// The dangerous default is the one that silently loses a name, so the plain name is
// the SAFE function: reaching for ASCII is explicit, and a slip there is caught by
// the schema rather than by a user losing a note.
//
// Underscore is a legal handle character (it survives, never folded to a dash).

// Letters NFKD does NOT decompose, romanised explicitly. Keys are LOWERCASE (applied
// after toLowerCase). Three blocks:
//   • Latin specials — atomic letters with no canonical decomposition (ß, ł, ø, æ…).
//   • Cyrillic — Russian + Ukrainian/Belarusian/Serbian/Macedonian. ё/й are mapped
//     HERE, before NFKD, on purpose: NFKD would decompose ё→е (losing the "io") and
//     й→и, so the map must win first.
//   • Greek — base letters; accented Greek (ά, ή…) is decomposed by NFKD to its base
//     first, then mapped here.
const CHAR_MAP: Record<string, string> = {
  // ── Latin specials ──
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
  ħ: 'h',
  ŧ: 't',
  ŋ: 'ng',
  ĸ: 'k',
  ŉ: 'n',
  ſ: 's',
  ƀ: 'b',
  // ── Cyrillic: Russian ──
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'io',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'iu',
  я: 'ia',
  // ── Cyrillic: Ukrainian / Belarusian ──
  і: 'i',
  ї: 'i',
  є: 'ie',
  ґ: 'g',
  ў: 'u',
  // ── Cyrillic: Serbian / Macedonian ──
  ђ: 'dj',
  ј: 'j',
  љ: 'lj',
  њ: 'nj',
  ћ: 'c',
  џ: 'dz',
  ѕ: 'dz',
  ѓ: 'gj',
  ќ: 'kj',
  ѐ: 'e',
  ѝ: 'i',
  // ── Greek (base letters; ς = final sigma) ──
  α: 'a',
  β: 'v',
  γ: 'g',
  δ: 'd',
  ε: 'e',
  ζ: 'z',
  η: 'i',
  θ: 'th',
  ι: 'i',
  κ: 'k',
  λ: 'l',
  μ: 'm',
  ν: 'n',
  ξ: 'x',
  ο: 'o',
  π: 'p',
  ρ: 'r',
  σ: 's',
  ς: 's',
  τ: 't',
  υ: 'y',
  φ: 'f',
  χ: 'ch',
  ψ: 'ps',
  ω: 'o',
}

const mapChars = (s: string): string => s.replace(/./gu, (ch) => CHAR_MAP[ch] ?? ch)

/** NFKD-decompose, then drop the combining marks — turns decomposable accented Latin
 *  (café→cafe, Schön→schon, naïve→naive) and accented Greek into their base letters. */
const stripDiacritics = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '')

/** camelCase split → lowercase → romanise what we have tables for. The shared
 *  first half of both slug functions; they differ only in what survives after it.
 *
 *  The map is applied TWICE around NFKD on purpose. Pass 1 (before NFKD) lets the
 *  Cyrillic rules win where NFKD would otherwise strip meaning — ё→io (NFKD would
 *  decompose ё→е), й→i. Pass 2 (after NFKD) catches base letters NFKD freshly exposes
 *  — accented Greek (ά→NFKD→α→a) only reaches the Greek rules once its tonos is gone.
 *  Latin accents (café→cafe) are handled by NFKD itself either way. */
const romanise = (s: string): string => {
  const lowered = String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
  // Fast path for pure-ASCII input (the common case): the maps and NFKD are no-ops on
  // ASCII, so skip them — slugify is hot (every title + every wikilink resolution pass).
  //
  // The fold runs AGAIN between NFKD and the second map pass, and that placement is the
  // point: NFKD expands the compatibility block into UPPERCASE letters (ϒ→Υ, ℾ→Γ, ㏀→kΩ),
  // and CHAR_MAP is keyed lowercase — so without it those letters miss the romaniser and
  // survive as Greek/Cyrillic. Folding only at the very end would hide that (the output
  // merely looks lowercase) while `slugify(slugify(x)) !== slugify(x)`, which
  // `parseNoteFile` relies on every time it re-canonicalises a stored `slug:`.
  return PRINTABLE_ASCII.test(lowered)
    ? lowered
    : mapChars(stripDiacritics(mapChars(lowered)).toLowerCase())
}

/** The pre-#296 ASCII storage algebra, frozen for deterministic importer paths.
 *  Compatibility expansions exposed by NFKD used to keep only the lowercase ASCII
 *  bytes already present before decomposition; the runtime romaniser intentionally
 *  fixed that, but reusing it here would move old imports on the next run. */
const legacyRomanise = (s: string): string => {
  const lowered = String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
  return PRINTABLE_ASCII.test(lowered) ? lowered : mapChars(stripDiacritics(mapChars(lowered)))
}

// Printable ASCII (space … ~). A title outside it (any letter ≥ U+0080, an emoji, a
// stray control char) takes the transliteration path; everything common stays fast.
const PRINTABLE_ASCII = /^[ -~]*$/

/** Everything that is NOT a letter, a digit, a combining mark or an underscore —
 *  collapsed to a dash. Marks are kept because in Thai/Hebrew/Devanagari they carry
 *  the vowels; dropping them would mangle the word rather than transliterate it.
 *  Filesystem portability falls out of this class rather than a separate ban-list:
 *  `< > : " / \ | ? *`, control characters, the dot and the space are none of the
 *  four, so a name can neither escape its directory nor grow a second extension. */
const NOT_NAME_CHAR = /[^\p{L}\p{N}\p{M}_]+/gu

/** Variation selectors, dropped BEFORE the class above sees them. They are marks by
 *  category but they name nothing: VS16 is what makes `❤` render as an emoji, so
 *  `❤️` would otherwise survive as the single INVISIBLE character U+FE0F — a file whose
 *  whole name is zero-width, and one shared key for every emoji in that family (❤️ ⚠️
 *  ✔️ ☀️ …), which is the very defect this module exists to remove. VS17+ selects a
 *  CJK glyph variant, where dropping it leaves the base ideograph — also what a name
 *  key wants, since two visually identical ideographs should not take two keys. */
const VARIATION_SELECTOR = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu
/** A mark names nothing without a kept letter/number before it. Emoji keycaps are
 *  punctuation/emoji plus U+20E3; once the base is discarded, retaining the mark
 *  alone creates one invisible filename shared by `#️⃣`, `*️⃣`, and friends. */
const ORPHAN_MARKS = /(^|[^\p{L}\p{N}\p{M}])\p{M}+/gu
/** The ASCII half of the same class — the handle axis, `SpaceSlugSchema`'s alphabet. */
const NOT_ASCII_HANDLE_CHAR = /[^a-z0-9_]+/g

const trimEdges = (s: string): string => s.replace(/^[-_]+|[-_]+$/g, '')

/** Slug of a single NAME (title, wikilink label, path segment): camelCase split,
 *  lowercase, romanise where we can, then collapse everything that is not a letter,
 *  digit, mark or underscore to a dash and trim separator edges.
 *
 *  TOTAL for any name carrying a letter or a digit, in any script — that is the whole
 *  point (#296). It still returns '' for a name made only of emoji, punctuation or
 *  whitespace, which is where the caller falls back to an id-derived handle.
 *
 *  NFC on the way out: `romanise` runs NFKD to strip Latin diacritics, and NFKD also
 *  decomposes Hangul syllables into jamo — without recomposing, the decomposed form
 *  would be what lands on disk and in the index.
 *
 *  The case fold lives inside `romanise`, between NFKD and the second map pass — NOT
 *  as a final pass here. NFKD expands the compatibility block into UPPERCASE letters
 *  (™→TM, ㎒→MHz, ϒ→Υ) which the old `[^a-z0-9_]` class scrubbed and this wider one
 *  keeps; folding there is what lets the romaniser see them AND what keeps a slug a
 *  case-insensitive key, so `㎒` and `MHz` cannot take two resolve keys and two file
 *  names a case-insensitive filesystem treats as one. */
export const slugify = (s: string): string => {
  const romanised = romanise(s).replace(VARIATION_SELECTOR, '').replace(ORPHAN_MARKS, '$1')
  const collapsed = trimEdges(romanised.replace(NOT_NAME_CHAR, '-'))
  return PRINTABLE_ASCII.test(collapsed) ? collapsed : collapsed.normalize('NFC')
}

/** Slug of a name restricted to the ASCII handle alphabet `[a-z0-9_-]` — the space /
 *  project handle axis, where the value is a URL segment under `SpaceSlugSchema`.
 *  Returns '' when the name has no romanisable characters at all; the caller falls
 *  back to `idToSlug` and soft-suffixes with `uniqueSlug` (#123). Prefer `slugify`
 *  unless the value really is a schema-pinned handle. */
export const asciiSlug = (s: string): string =>
  trimEdges(romanise(s).replace(NOT_ASCII_HANDLE_CHAR, '-'))

/** Frozen pre-Unicode name key. It is exposed only for recognising storage names
 * minted by the old note-path algebra; new names always use `nameKey`/`slugify`. */
export const legacyNameKey = (s: string): string =>
  trimEdges(legacyRomanise(s).replace(NOT_ASCII_HANDLE_CHAR, '-'))

/** Frozen legacy slug for persisted importer-owned paths only. New handles must use
 *  `asciiSlug`; note names must use `slugify`. */
export const legacyImportSlug = (s: string): string => legacyNameKey(s)

/** Slugify a path per segment ("Dir Name/Note" → "dir-name/note"). */
export const slugifyPath = (p: string): string => p.split('/').map(slugify).join('/')

/** Total comparison key for human note names: the slug, or the raw NFC case-folded
 *  form when no sluggable characters survive. Name matchers use this; values that
 *  must themselves be slugs (URL tails, file names, anchors) use `slugify`.
 *
 *  The raw rung strips variation selectors for the same reason `slugify` does, and it
 *  is the rung those names actually take: `❤️` and `❤` are one glyph in two legal
 *  spellings, so keying them apart would file one category's observations under two
 *  labels a human reads as one, and let a second typed link to the "same" target
 *  through. */
const foldNameForMatch = (name: string): string =>
  name
    .normalize('NFC')
    // Preserve the historical ASCII camel boundary before full-ish Unicode folding.
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    // JS has no caseFold primitive; upper→lower performs the multi-code-point folds
    // plain lower misses (e.g. Greek prosgegrammeni) while remaining deterministic.
    .toUpperCase()
    .toLowerCase()
    .normalize('NFC')

export const nameKey = (name: string): string => {
  const folded = foldNameForMatch(name)
  return slugify(folded) || folded.replace(VARIATION_SELECTOR, '').trim()
}

/** `nameKey` per path segment. Empty when the LAST segment names nothing: `journal/`
 *  (what a legacy `<dir>/.md` file slugs to) is not a name — registering it would hand
 *  that note the key of its own FOLDER, and resolving it would merge every such broken
 *  link onto one ghost titled after whichever came last. */
export const namePathKey = (p: string): string => {
  const keys = p.split('/').map(nameKey)
  return keys[keys.length - 1] ? keys.join('/') : ''
}

/** The key a link LABEL is matched under — `namePathKey`, or the raw label when even
 *  that is empty. TOTAL: distinct labels never share a key, which is what the two
 *  callers need and what neither key alone gives. `namePathKey` is deliberately empty
 *  for `journal/` (see above), and `nameKey` deliberately flattens a path — so keying a
 *  label on either one alone merges labels the resolver keeps apart, and a surface that
 *  asks "do we already have this target?" answers yes for a target it has never seen.
 *
 *  Not a fourth axis: it is `namePathKey` plus a raw rung, lifted to the whole label.
 *  The raw rung does NOT strip variation selectors, unlike `nameKey`'s: a label that
 *  reaches this rung at all is one `namePathKey` emptied, so stripping could only empty
 *  it further — and an empty key is the one value that WOULD merge distinct labels.
 *  Callers: `resolveLink`'s ghost target and the typed-link idempotency check, the two
 *  places that key a label rather than a note's own name. */
export const linkKey = (label: string): string => namePathKey(label) || label.trim().toLowerCase()

/** A valid handle derived from an OPAQUE id — the fallback when a name has no
 *  romanisable characters (CJK/Arabic/…), so an entity always gets an addressable
 *  slug. The id alphabet is `[A-Za-z0-9_-]`; lowercasing + trimming the slug-illegal
 *  edges yields a valid slug. NOT claimed blind: the caller passes it through
 *  `uniqueSlug`, so the astronomically-unlikely clash with a hand-picked custom slug
 *  of the same string is suffixed like any other collision. '' only if the id were
 *  all separators (impossible for a real 12-char id) — the caller guards anyway. */
export const idToSlug = (id: string): string =>
  id
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '')
    .replace(/^[-_]+|[-_]+$/g, '')

/** The first FREE slug in the series `base`, `base-2`, `base-3`… — `isFree` decides
 *  against the live handles at the call site (a space registry, a folder's siblings,
 *  the note read-model). This is the "soft suffix" mint rule: a DERIVED
 *  handle (from a name) silently uniquifies, where an EXPLICIT one (a user-typed
 *  rename) is a 409 instead. Reusable across spaces/folders/notes. `maxLength` caps
 *  the base so the `-N` suffix still fits the field; an empty base becomes `item`. */
export const uniqueSlug = (
  base: string,
  isFree: (slug: string) => boolean,
  opts: { maxLength?: number } = {},
): string => {
  const max = opts.maxLength ?? 64
  const trimEnd = (x: string): string => x.replace(/[-_]+$/, '')
  const head = trimEnd(base.slice(0, max)) || 'item'

  if (isFree(head)) {
    return head
  }
  for (let i = 2; i < 10_000; i++) {
    const suffix = `-${i}`
    const cand = `${trimEnd(head.slice(0, max - suffix.length))}${suffix}`

    if (isFree(cand)) {
      return cand
    }
  }

  // 10k live collisions on one base is pathological; hand back a candidate anyway and
  // let the caller's atomic claim (DB UNIQUE / mint race) be the final arbiter.
  return `${trimEnd(head.slice(0, max - 6))}-${10_000}`
}

/** De-kebab a slug into a human title ("kb-experiment" → "Kb Experiment"). */
export const deKebab = (s: string): string =>
  s
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

/** A note's EFFECTIVE slug — the URL/resolve name: the stored custom
 *  `slug:` when the note has one, else derived from the title. The default stays
 *  IMPLICIT (a note without a custom slug carries no `slug:` line), so every note
 *  has a slug for its `/n/<id>/<slug>` URL whether or not one was ever saved. */
export const effectiveSlug = (slug: string | null | undefined, title: string): string =>
  (slug && slug.trim()) || slugify(title)

/** The slug to PERSIST in frontmatter for a save (lazy): the user's raw
 *  slug cleaned to URL form, but kept only when it DIVERGES from the title's own
 *  slug — a slug equal to slug(title) is the default and stays implicit (clean
 *  files, Obsidian-friendly). Returns the value to set, '' to DROP any stored
 *  slug (an explicit clear, or a slug that collapsed onto the default), or
 *  undefined to LEAVE the file's `slug:` untouched (the caller never addressed
 *  it). Mirrors the tags/aliases write channel's three-state semantics. */
export const storedSlug = (rawSlug: string | undefined, title: string): string | undefined => {
  if (rawSlug === undefined) {
    return undefined
  }
  const clean = slugify(rawSlug)
  return clean && clean !== slugify(title) ? clean : ''
}
