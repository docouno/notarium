import { describe, expect, it } from 'vitest'

import { noteFileBase } from '../path'
import {
  asciiSlug,
  effectiveSlug,
  idToSlug,
  legacyImportSlug,
  legacyNameKey,
  linkKey,
  nameKey,
  namePathKey,
  slugify,
  slugifyPath,
  storedSlug,
  uniqueSlug,
} from './slug'

describe('slugify', () => {
  it('handles plain latin + camelCase', () => {
    expect(slugify('BookStack')).toBe('book-stack')
    expect(slugify('KB Experiment')).toBe('kb-experiment')
    expect(slugify('My Space')).toBe('my-space')
  })

  it('transliterates Russian cyrillic (ё→io, й→i, щ→shch)', () => {
    expect(slugify('Ёлка и Йогурт')).toBe('iolka-i-iogurt')
    expect(slugify('Щавель и Ящик')).toBe('shchavel-i-iashchik')
    expect(slugify('Южный Ветер')).toBe('iuzhnyi-veter')
    expect(slugify('Цветущий Чай')).toBe('tsvetushchii-chai')
    expect(slugify('Несуществующая нота')).toBe('nesushchestvuiushchaia-nota')
  })

  // the create surfaces take names in any language; the matrix pins exactly
  // what each script yields (a non-empty handle, or '' → the caller's id fallback).
  describe('multi-language matrix (#123)', () => {
    it('accented Latin → clean ASCII (NFKD strips the diacritics)', () => {
      expect(slugify('Schöne Bücher')).toBe('schone-bucher') // German umlaut
      expect(slugify('Café Crème')).toBe('cafe-creme') // French accents
      expect(slugify('Niños España')).toBe('ninos-espana') // Spanish tilde
      expect(slugify('São Paulo Ação')).toBe('sao-paulo-acao') // Portuguese
      expect(slugify('Příliš Žluťoučký')).toBe('prilis-zlutoucky') // Czech háček
      expect(slugify('Tiếng Việt')).toBe('tieng-viet') // Vietnamese
      expect(slugify('İstanbul Şehir')).toBe('istanbul-sehir') // Turkish dotted-I + ş
    })

    it('non-decomposable Latin letters → explicit map (ł, ø, å, ß, þ, ð, æ, œ)', () => {
      expect(slugify('Łódź')).toBe('lodz') // Polish ł + ó + ź
      expect(slugify('Smørrebrød Åland')).toBe('smorrebrod-aland') // Nordic ø, å
      expect(slugify('Straße')).toBe('strasse') // German ß → ss
      expect(slugify('Þórður')).toBe('thordur') // Icelandic þ → th, ð → d
      expect(slugify('Æther Œuvre')).toBe('aether-oeuvre') // ligatures
    })

    it('extended Cyrillic — Ukrainian / Belarusian / Serbian / Macedonian', () => {
      expect(slugify('Привіт Їжак Ґанок')).toBe('privit-izhak-ganok') // Ukrainian і, ї, ґ
      expect(slugify('Беларусь Воўк')).toBe('belarus-vouk') // Belarusian ў
      expect(slugify('Љубав Њега Ђура')).toBe('ljubav-njega-djura') // Serbian љ, њ, ђ
    })

    it('Greek — base + accented (NFKD drops the tonos, then the Greek map)', () => {
      expect(slugify('Ελληνικά')).toBe('ellinika')
      expect(slugify('Αθήνα Μύκονος')).toBe('athina-mykonos')
    })

    // #296 — the axis split. A name is a FILE NAME and a RESOLVE KEY, so a script we
    // have no romaniser for keeps its own letters instead of being dropped: dropping
    // is what wrote the dot-file `.md` and collapsed every non-Latin note onto one
    // empty key. The handle axis (asciiSlug, below) keeps the old ASCII behaviour.
    it('scripts with no romaniser here KEEP their letters — distinct, non-empty', () => {
      const seen = new Set<string>()

      for (const s of [
        '你好世界',
        'こんにちは',
        '안녕하세요',
        'مرحبا بالعالم',
        'שלום עולם',
        'สวัสดี',
      ]) {
        const key = slugify(s)
        expect(key).not.toBe('')
        expect(seen.has(key)).toBe(false) // no two scripts share one key
        seen.add(key)
      }
    })

    it('a name in one unromanisable script slugs to itself (file name = readable)', () => {
      expect(slugify('第三季度规划')).toBe('第三季度规划')
      expect(slugify('会議の議事録')).toBe('会議の議事録')
      expect(slugify('תוכניות לרבעון')).toBe('תוכניות-לרבעון') // the space is a separator
    })

    it('recomposes to NFC — NFKD decomposes Hangul, and the jamo must not reach disk', () => {
      const key = slugify('안녕하세요')
      expect(key).toBe(key.normalize('NFC'))
      expect(key).toBe('안녕하세요')
    })

    it('keeps combining marks — they carry the vowels in Thai/Hebrew', () => {
      // Stripping marks like a Latin diacritic would mangle the word, not romanise it.
      expect(slugify('แผนไตรมาส')).toBe('แผนไตรมาส')
      expect(slugify('שָׁלוֹם')).toBe('שָׁלוֹם')
    })

    it('mixed scripts keep BOTH halves — the romanised and the kept', () => {
      expect(slugify('Café 你好 Test')).toBe('cafe-你好-test')
      expect(slugify('🚀 Rocket')).toBe('rocket') // an emoji is not a letter
    })

    it('collapses what a filesystem would refuse, so portability needs no ban-list', () => {
      // `< > : " / \ | ? *`, control chars, the dot and the space are none of
      // letter/digit/mark/underscore — a name can neither escape its directory nor
      // grow a second extension.
      expect(slugify('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
      expect(slugify('note.md')).toBe('note-md')
      expect(slugify('第三季度/规划')).toBe('第三季度-规划')
      expect(slugify('a\u0000b')).toBe('a-b') // a control char, written as an ESCAPE:
      // a raw NUL in the source makes git treat this whole file as binary.
      expect(slugify('a b')).toBe('a-b')
    })

    it('underscore is a legal handle character — preserved, never folded to a dash', () => {
      expect(slugify('my_cool_space')).toBe('my_cool_space')
      expect(slugify('A_b C')).toBe('a_b-c')
    })

    it('only-punctuation / whitespace / emoji / empty → empty (the id fallback case)', () => {
      expect(slugify('!!! ??? ...')).toBe('')
      expect(slugify('   ')).toBe('')
      expect(slugify('')).toBe('')
      expect(slugify('🎉🎉')).toBe('')
    })

    it('an emoji carrying a variation selector is empty too, not one invisible char', () => {
      // VS16 is a MARK by category, so the letter class would keep it: `❤️` slugged to
      // the single zero-width U+FE0F — a file whose whole name is invisible, and one
      // shared key for the entire family. That is the #296 defect wearing a new hat.
      const family = ['❤️', '⚠️', '✔️', '☀️', '▶️', '☑️', '✏️']

      for (const s of family) {
        expect(slugify(s)).toBe('')
      }
      // …and the id rung names their files, so two of them never collide.
      expect(noteFileBase('❤️', undefined, 'AAAAAAAAAAAA')).toBe('aaaaaaaaaaaa')
      expect(noteFileBase('⚠️', undefined, 'BBBBBBBBBBBB')).toBe('bbbbbbbbbbbb')
    })

    it('drops combining marks whose base character was discarded', () => {
      // U+20E3 is the enclosing keycap mark. Its emoji/punctuation base is not a
      // name character, so the mark must not survive by itself as one invisible
      // filename shared by every keycap spelling.
      expect(slugify('#️⃣')).toBe('')
      expect(slugify('*️⃣')).toBe('')
      expect(slugify('\u0301')).toBe('')
    })

    it('a CJK ideograph keeps its base when a variation selector picks a glyph', () => {
      // VS17+ chooses a glyph variant; two visually identical ideographs must not take
      // two different keys.
      expect(slugify('\u9089\u{E0101}')).toBe(slugify('\u9089'))
    })

    // A slug is a case-INSENSITIVE key (and a file name on a case-insensitive
    // filesystem). NFKD expands the compatibility block into UPPERCASE Latin, which the
    // old ASCII class scrubbed and the wider one keeps — so the fold has to happen after
    // the maps, not only before them.
    it('is lowercase even where NFKD expands into capitals', () => {
      expect(slugify('Notarium™')).toBe('notariumtm')
      expect(slugify('㎒')).toBe('mhz')
      expect(slugify('℡')).toBe('tel')
      expect(slugify('㎒')).toBe(slugify('MHz')) // one name, one key
      for (const s of ['Notarium™', '㎒', '℡', '℃', 'Ⅷ', 'ｱ', '第三季度规划', 'Привет']) {
        expect(slugify(s)).toBe(slugify(s).toLowerCase())
      }
    })

    it('is a FIXED POINT — slugify(slugify(x)) === slugify(x)', () => {
      // `parseNoteFile` re-canonicalises a stored `slug:` on every read, so a second
      // pass that changes the value would leave the read-model and the file disagreeing
      // forever. NFKD expands these into UPPERCASE letters CHAR_MAP only knows in
      // lowercase, so the fold has to happen before the second map pass, not after it.
      for (const s of ['ϒ', 'ϓ', 'ᴭ', 'ℾ', 'ℿ', '㏀', '㎒', '™', 'Ω', 'Ёлка', '第三季度规划']) {
        expect(slugify(slugify(s))).toBe(slugify(s))
      }
      expect(slugify('ϒ')).toBe('y') // romanised, not left as Greek upsilon
      expect(slugify('ℾ')).toBe('g')
      expect(slugify('㏀')).toBe('ko')
    })

    it('never collapses a non-latin title onto the empty key when WE can romanise it', () => {
      expect(slugify('Эх')).not.toBe('') // the corpus-diff bug
      expect(slugify('Ω')).not.toBe('')
    })
  })

  it('slugs paths per segment', () => {
    expect(slugifyPath('archive/notes/Ёлочные-Игрушки')).toBe('archive/notes/iolochnye-igrushki')
    expect(slugifyPath('journal/第三季度规划')).toBe('journal/第三季度规划')
  })
})

describe('legacyImportSlug', () => {
  it('freezes pre-#296 compatibility-expansion paths', () => {
    expect(legacyImportSlug('㏀')).toBe('k')
    expect(legacyImportSlug('㎒')).toBe('z')
    expect(legacyImportSlug('™')).toBe('')
    expect(legacyImportSlug('ϒ')).toBe('')
    // New runtime handles intentionally use the corrected romaniser.
    expect(asciiSlug('㎒')).toBe('mhz')
  })
})

describe('legacyNameKey', () => {
  it('is the named compatibility primitive used by importer paths', () => {
    for (const value of ['Қазақстан жоспары', '㏀', '™', 'BookStack']) {
      expect(legacyNameKey(value)).toBe(legacyImportSlug(value))
    }
  })
})

// The HANDLE axis (#123): a space/project handle is a URL segment under
// SpaceSlugSchema, so it stays ASCII and yields '' for a script it cannot romanise —
// that '' is what the caller's idToSlug fallback is for.
describe('asciiSlug', () => {
  it('romanises exactly as the name axis does, for everything it CAN romanise', () => {
    for (const s of ['BookStack', 'Ёлка и Йогурт', 'Café Crème', 'Ελληνικά', 'my_cool_space']) {
      expect(asciiSlug(s)).toBe(slugify(s))
    }
  })

  it('yields the ASCII alphabet only — an unromanisable script degrades to empty', () => {
    for (const s of ['你好世界', 'こんにちは', '안녕하세요', 'مرحبا', 'שלום', 'สวัสดี', '🎉']) {
      expect(asciiSlug(s)).toBe('')
    }
    expect(asciiSlug('Café 你好 Test')).toBe('cafe-test')
    expect(asciiSlug('第三季度 Plan')).toBe('plan')
  })

  it('every non-empty result is a valid SpaceSlug', () => {
    const shape = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/

    for (const s of ['Łódź', 'Привіт Їжак', 'A_b C', '  Trailing --', 'Ω']) {
      expect(asciiSlug(s)).toMatch(shape)
    }
  })
})

describe('idToSlug (#123 — fallback handle from an opaque id)', () => {
  it('lowercases and keeps the slug alphabet (underscore + dash)', () => {
    expect(idToSlug('Ab3_xK-9pQrs')).toBe('ab3_xk-9pqrs')
    expect(idToSlug('ABCDEF123456')).toBe('abcdef123456')
  })

  it('trims slug-illegal edges so the result is always a valid SpaceSlug', () => {
    expect(idToSlug('_lead-')).toBe('lead')
    expect(idToSlug('-_x_-')).toBe('x')
  })
})

describe('uniqueSlug (#100/#123 — soft suffix for a derived handle)', () => {
  const freeAmong = (taken: string[]) => (s: string) => !taken.includes(s)

  it('returns the base when free', () => {
    expect(uniqueSlug('team', freeAmong([]))).toBe('team')
  })

  it('suffixes -2, -3… past the taken ones', () => {
    expect(uniqueSlug('team', freeAmong(['team']))).toBe('team-2')
    expect(uniqueSlug('team', freeAmong(['team', 'team-2']))).toBe('team-3')
    expect(uniqueSlug('cafe', freeAmong(['cafe', 'cafe-2']))).toBe('cafe-3')
  })

  it('an empty base degrades to "item" rather than a blank handle', () => {
    expect(uniqueSlug('', freeAmong([]))).toBe('item')
  })

  it('protects the id fallback against a hand-picked custom slug of the same value (#123 edge case)', () => {
    // A user happened to set some other space\'s custom slug to exactly the value our
    // id fallback derives — the fallback must suffix, never claim it blind.
    const idHandle = idToSlug('ab3_xk-9pqrs')
    expect(uniqueSlug(idHandle, freeAmong([idHandle]))).toBe(`${idHandle}-2`)
  })

  it('caps the base so the -N suffix fits maxLength', () => {
    const base = 'x'.repeat(40)
    // The capped head (10 x) is taken → the suffix must steal back room: 8 x + "-2".
    expect(uniqueSlug(base, freeAmong(['x'.repeat(10)]), { maxLength: 10 })).toBe('xxxxxxxx-2')
  })
})

describe('effectiveSlug (#100)', () => {
  it('uses the custom slug when present, else derives one from the title', () => {
    expect(effectiveSlug('custom', 'My Title')).toBe('custom')
    expect(effectiveSlug(null, 'My Title')).toBe('my-title')
    expect(effectiveSlug('', 'My Title')).toBe('my-title') // empty = implicit default
    expect(effectiveSlug(undefined, 'BookStack')).toBe('book-stack')
  })
})

describe('nameKey (matching axis)', () => {
  it('matches canonically equivalent spellings without renaming their stored slug', () => {
    expect(nameKey('Ё')).toBe(nameKey('Е\u0308'))
    expect(slugify('Ё')).not.toBe(slugify('Е\u0308')) // storage compatibility stays historical
  })

  it('uses a full case fold for multi-code-point Unicode casing', () => {
    expect(nameKey('ᾠδή')).toBe(nameKey('ὨΙΔΉ'))
  })

  it('preserves the historical camelCase word boundary', () => {
    expect(nameKey('BookStack')).toBe('book-stack')
  })
})

// #296 — `linkKey` exists ONLY because neither other key is total for a link label.
// Its raw rung is the whole difference from `namePathKey`, so pin the inputs that
// reach it: delete `|| label.trim()…` and these are what go red.
describe('linkKey (the label axis)', () => {
  it('keeps two labels apart where namePathKey empties BOTH', () => {
    // A blank last segment names nothing, so `namePathKey` is '' by design — but the
    // two labels are still two distinct broken links, and one empty key would merge
    // every such link in the corpus onto one node.
    expect(namePathKey('journal/')).toBe('')
    expect(namePathKey('archive/')).toBe('')
    expect(linkKey('journal/')).not.toBe(linkKey('archive/'))
    expect(linkKey('journal/')).toBeTruthy()
  })

  it('agrees with namePathKey wherever that names something', () => {
    // The rung is a FALLBACK, not a second opinion: it must not shadow a real key,
    // or a label would key differently here than in the index it is looked up in.
    for (const label of ['journal/🎉', 'journal/notes', 'Journal Notes', '🎉🎉', 'привет']) {
      expect(linkKey(label)).toBe(namePathKey(label))
    }
  })

  it('is empty only for a label that is empty', () => {
    expect(linkKey('   ')).toBe('')
    expect(linkKey('')).toBe('')
  })
})

describe('storedSlug (#100, lazy)', () => {
  it('keeps a custom slug, drops one equal to slug(title), leaves undefined untouched', () => {
    expect(storedSlug(undefined, 'T')).toBeUndefined() // not addressed → leave the file's slug
    expect(storedSlug('', 'T')).toBe('') // explicit clear → drop
    expect(storedSlug('My Slug', 'T')).toBe('my-slug') // custom → cleaned to URL form + kept
    expect(storedSlug('My Title', 'My Title')).toBe('') // equals slug(title) → implicit, drop
    expect(storedSlug('my-title', 'My Title')).toBe('') // already the title's slug-form → drop
  })
})
