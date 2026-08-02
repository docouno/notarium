// The slug algebra: a name/title → a URL-safe handle `[a-z0-9_-]`, also the key the
// read-model resolves [[wikilinks]] against note identities with.
// canon: docs/note-model.md#note-ontology
// The ONLY hard requirement is internal consistency — index keys and lookups go
// through THIS function, so the exact byte form never leaks. Beyond that we aim for
// readable handles across scripts: Latin (incl. accents), the full Cyrillic block and
// Greek transliterate; everything else (CJK, Arabic, Hebrew, Thai, emoji) has no
// romaniser here and slugs to '' — the caller falls back to an id-derived handle.
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

/** Slug of a single label: camelCase split, lowercase, transliterate, then collapse
 *  anything outside `[a-z0-9_]` to a dash and trim separator edges. May return ''
 *  when the input has no romanisable characters (the caller falls back to an
 *  id-derived handle).
 *
 *  The map is applied TWICE around NFKD on purpose. Pass 1 (before NFKD) lets the
 *  Cyrillic rules win where NFKD would otherwise strip meaning — ё→io (NFKD would
 *  decompose ё→е), й→i. Pass 2 (after NFKD) catches base letters NFKD freshly exposes
 *  — accented Greek (ά→NFKD→α→a) only reaches the Greek rules once its tonos is gone.
 *  Latin accents (café→cafe) are handled by NFKD itself either way. */
export const slugify = (s: string): string => {
  const lowered = String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
  // Fast path for pure-ASCII input (the common case): the maps and NFKD are no-ops on
  // ASCII, so skip them — slugify is hot (every title + every wikilink resolution pass).
  const romanised = PRINTABLE_ASCII.test(lowered)
    ? lowered
    : mapChars(stripDiacritics(mapChars(lowered)))
  return romanised.replace(/[^a-z0-9_]+/g, '-').replace(/^[-_]+|[-_]+$/g, '')
}

// Printable ASCII (space … ~). A title outside it (any letter ≥ U+0080, an emoji, a
// stray control char) takes the transliteration path; everything common stays fast.
const PRINTABLE_ASCII = /^[ -~]*$/

/** Slugify a path per segment ("Dir Name/Note" → "dir-name/note"). */
export const slugifyPath = (p: string): string => p.split('/').map(slugify).join('/')

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
