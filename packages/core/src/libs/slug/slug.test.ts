import { describe, expect, it } from 'vitest'

import { effectiveSlug, idToSlug, slugify, slugifyPath, storedSlug, uniqueSlug } from './slug'

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

    it('scripts with no romaniser here → empty (the caller falls back to an id)', () => {
      for (const s of [
        '你好世界',
        'こんにちは',
        '안녕하세요',
        'مرحبا بالعالم',
        'שלום עולם',
        'สวัสดี',
      ]) {
        expect(slugify(s)).toBe('')
      }
    })

    it('mixed scripts keep the romanisable part, drop the rest', () => {
      expect(slugify('Café 你好 Test')).toBe('cafe-test')
      expect(slugify('🚀 Rocket')).toBe('rocket')
    })

    it('underscore is a legal handle character — preserved, never folded to a dash', () => {
      expect(slugify('my_cool_space')).toBe('my_cool_space')
      expect(slugify('A_b C')).toBe('a_b-c')
    })

    it('only-punctuation / whitespace / empty → empty', () => {
      expect(slugify('!!! ??? ...')).toBe('')
      expect(slugify('   ')).toBe('')
      expect(slugify('')).toBe('')
    })

    it('never collapses a non-latin title onto the empty key when WE can romanise it', () => {
      expect(slugify('Эх')).not.toBe('') // the corpus-diff bug
      expect(slugify('Ω')).not.toBe('')
    })
  })

  it('slugs paths per segment', () => {
    expect(slugifyPath('archive/notes/Ёлочные-Игрушки')).toBe('archive/notes/iolochnye-igrushki')
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

describe('storedSlug (#100, lazy)', () => {
  it('keeps a custom slug, drops one equal to slug(title), leaves undefined untouched', () => {
    expect(storedSlug(undefined, 'T')).toBeUndefined() // not addressed → leave the file's slug
    expect(storedSlug('', 'T')).toBe('') // explicit clear → drop
    expect(storedSlug('My Slug', 'T')).toBe('my-slug') // custom → cleaned to URL form + kept
    expect(storedSlug('My Title', 'My Title')).toBe('') // equals slug(title) → implicit, drop
    expect(storedSlug('my-title', 'My Title')).toBe('') // already the title's slug-form → drop
  })
})
