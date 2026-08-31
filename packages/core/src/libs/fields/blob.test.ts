import { describe, expect, it, vi } from 'vitest'

import { type FrontmatterEntry, parseFrontmatterLines, utf8Bytes } from '../markdown'
import {
  buildNoteDetailFields,
  buildNoteFields,
  buildNoteFieldsBlob,
  measureCappedNoteFields,
  parseNoteFields,
  patchNoteFields,
  serializeNoteFields,
} from './blob'
import { FIELDS_BLOB_BYTE_CAP } from './consts'
import type { NoteFields } from './types'

const fields = (yaml: string) => buildNoteFields(parseFrontmatterLines(yaml))
const blob = (yaml: string) => buildNoteFieldsBlob(parseFrontmatterLines(yaml))

// A seeded PRNG (mulberry32). `Math.random` would make a red unreproducible, and a
// generated corpus nobody can replay is not evidence of anything.
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)

  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

describe('the fields blob encodes every key state explicitly', () => {
  it('builds a complete detail projection while retaining the index cap outcome', () => {
    const wide = 'x'.repeat(FIELDS_BLOB_BYTE_CAP + 1)
    const detail = buildNoteDetailFields(
      parseFrontmatterLines(`title: Detail\nalpha: one\nbroken:\n  nested: value\nwide: ${wide}`),
    )

    expect(detail.keys.alpha).toBe('one')
    expect(detail.keys.wide).toBe(wide)
    expect(detail.unreadable).toEqual(['broken'])
    expect(detail.truncated).toEqual(['wide'])
    expect(detail.order).toEqual(['title', 'alpha', 'broken', 'wide'])
  })

  it('reads a scalar and a block list', () => {
    expect(fields('status: in progress\nreviewers:\n- ann\n- bo').keys).toEqual({
      status: 'in progress',
      reviewers: ['ann', 'bo'],
    })
  })

  it('keeps an empty value distinct from an absent key', () => {
    const built = fields("note: ''")

    expect(built.keys.note).toBe('')
    expect(built.unreadable).toBeUndefined()
    expect(fields('other: x').keys.note).toBeUndefined()
  })

  it('reports a nested map, a bare key and a wrapped scalar as unreadable', () => {
    for (const yaml of ['k:\n  a: 1', 'k:', 'k: one\n  two', 'k: [a,']) {
      const built = fields(yaml)

      expect(built.keys.k, yaml).toBeUndefined()
      expect(built.unreadable, yaml).toEqual(['k'])
    }
  })

  it('reads a block scalar — the parser models it, so it costs budget', () => {
    const built = fields('k: |\n  line one\n  line two')

    expect(built.keys.k).toBe('line one line two')
    expect(built.unreadable).toBeUndefined()
  })

  // The pair above and below is the whole rule: a block scalar is unreadable only
  // when it is EMPTY. Read as one case it looks like "block scalars are unreadable",
  // which is what the design said before a run corrected it.
  it('reports only an EMPTY block scalar as unreadable', () => {
    const built = fields('k: |\nother: kept')

    expect(built.keys.k).toBeUndefined()
    expect(built.unreadable).toEqual(['k'])
    expect(built.keys.other).toBe('kept')
  })

  it('is last-wins when the final duplicate is unreadable', () => {
    const built = fields('k: readable\nk:\n  a: 1')

    expect(built.keys.k).toBeUndefined()
    expect(built.unreadable).toEqual(['k'])
  })

  it('is last-wins at the FIRST authored position of the key', () => {
    // The position is load-bearing, not cosmetic: the cap sacrifices from the tail of
    // the authored order, so moving a restated key to where it was restated would
    // change which key survives a tight blob — hence the second corpus.
    expect(blob('a: 1\nk: first\nb: 2\nk: second')).toBe('{"keys":{"a":"1","k":"second","b":"2"}}')

    const wide = 'v'.repeat(2040)
    const built = fields(`k: ${wide}\nfiller: ${wide}\nk: ${wide}`)

    expect(Object.keys(built.keys)).toEqual(['k'])
    expect(built.truncated).toEqual(['filler'])
  })

  it('does not fold case — two keys, not one', () => {
    expect(Object.keys(fields('Priority: high\npriority: low').keys).sort()).toEqual([
      'Priority',
      'priority',
    ])
  })

  it('cannot tell a quoted number from a bare one', () => {
    expect(fields('priority: 3').keys.priority).toBe('3')
    expect(fields('priority: "3"').keys.priority).toBe('3')
  })
})

describe('the column carries exactly the keys the note has no field of its own for', () => {
  it('drops the keys projected onto note metadata', () => {
    const built = fields(
      'title: T\ntags:\n- a\naliases:\n- old\nslug: s\ncreated: 2026-08-20\nnotarium-id: AbCdefGhij_1\nnotarium-created: 2026-08-20',
    )

    expect(serializeNoteFields(built)).toBe('{"keys":{}}')
  })

  it('keeps protected keys without a dedicated metadata projection', () => {
    expect(fields('type: task\nsummary: s\nmuted: "true"\nview: board').keys).toEqual({
      type: 'task',
      summary: 's',
      muted: 'true',
    })
  })

  it('does not report a projected key as unreadable either', () => {
    expect(fields('tags:\n  nested: 1').unreadable).toBeUndefined()
  })
})

describe('author keys stay first-class', () => {
  it('survives __proto__ as an own key, through a round trip', () => {
    const json = blob('__proto__: x')

    expect(Object.getOwnPropertyNames(JSON.parse(json).keys)).toEqual(['__proto__'])
    expect(parseNoteFields(json).keys.__proto__).toBe('x')
  })

  it('answers no prototype name after a round trip', () => {
    const keys = parseNoteFields(blob('status: done')).keys

    for (const name of ['toString', 'constructor', 'hasOwnProperty']) {
      expect(Object.getOwnPropertyNames(keys)).not.toContain(name)
      expect(keys[name]).toBeUndefined()
    }
  })

  it('spells the blob byte for byte when the author mixes integer-like keys in', () => {
    // A constant, not a re-derivation compared to itself: this function is pure, so
    // `blob(y) === blob(y)` holds for every implementation, right or wrong. Adoption
    // compares this string to a column an OLDER build wrote, which is what makes the
    // expected bytes — including the integer-like keys jumping to the front — canon.
    expect(blob('2026: budget\nstatus: done\n7: seven')).toBe(
      '{"keys":{"7":"seven","2026":"budget","status":"done"}}',
    )
  })
})

describe('the byte cap is an invariant over the whole serialized object', () => {
  it('drops one oversized value entirely and keeps its name findable', () => {
    const built = fields(`small: ok\nbig: ${'x'.repeat(5000)}`)

    expect(built.keys.big).toBeUndefined()
    expect(built.keys.small).toBe('ok')
    expect(built.truncated).toEqual(['big'])
  })

  it('sacrifices from the tail of the authored order, not by weight', () => {
    const built = fields(`big: ${'x'.repeat(5000)}\nsmall: ok`)

    expect(built.keys).toEqual({})
    expect(built.truncated).toEqual(['big', 'small'])
  })

  it('holds on a 6 KiB author block, and its split point is a constant', () => {
    const value = 'v'.repeat(40)
    const yaml = Array.from({ length: 120 }, (_, i) => `key${i}: ${value}`).join('\n')
    const kept = Array.from({ length: 72 }, (_, i) => `"key${i}":"${value}"`).join(',')
    const dropped = Array.from({ length: 48 }, (_, i) => `"key${i + 72}"`).join(',')
    const expected = `{"keys":{${kept}},"truncated":[${dropped}]}`

    expect(blob(yaml)).toBe(expected)
    // Six bytes under: the split point is the last one that fits, so a weight that
    // drifts by a byte moves it and this expectation goes red.
    expect(utf8Bytes(expected)).toBe(4090)
  })

  // The two worst inputs there are — a frontmatter block at the parser's own 64 KiB
  // ceiling, and a note whose UNREADABLE names alone overflow the blob — and both get
  // a byte constant rather than a shape check. `blob(y) === blob(y)` would be no
  // evidence: this function is pure, so it holds for every implementation. What has to
  // survive is a re-derivation by a LATER build against a column an older one wrote,
  // and only a literal expectation crosses that gap. Both keep exactly 594 names and
  // count the rest — that split is what a drifting weight moves.
  const NAMES_THAT_FIT = Array.from({ length: 594 }, (_, i) => `"k${i}"`).join(',')

  it('spells a maximal frontmatter block byte for byte, values degraded to a counter', () => {
    const expected = `{"keys":{},"truncated":[${NAMES_THAT_FIT}],"truncatedMore":5955}`

    expect(blob(Array.from({ length: 6549 }, (_, i) => `k${i}:  v`).join('\n'))).toBe(expected)
    expect(utf8Bytes(expected)).toBe(4094)
  })

  it('spells a block of unreadable names byte for byte, the rest degraded to a counter', () => {
    const expected = `{"keys":{},"unreadable":[${NAMES_THAT_FIT}],"unreadableMore":6406}`

    expect(blob(Array.from({ length: 7000 }, (_, i) => `k${i}:`).join('\n'))).toBe(expected)
    // Exactly ON the cap, not near it: one byte of weight drift either way moves the
    // split, and nothing else in the suite stands on the boundary itself.
    expect(utf8Bytes(expected)).toBe(FIELDS_BLOB_BYTE_CAP)
  })

  it('sacrifices by weight, not by re-serializing per dropped element', () => {
    // Structural on purpose, though the budget it protects is wall-clock (one blob
    // build sits inside one upsertRow, twice per note): a clock bound is a threshold
    // pinned to one machine. What separates the walk `applyCap` describes from the
    // loop it exists instead of is the COUNT of whole-object serializations — on this
    // input, 12592 of them.
    const entries = parseFrontmatterLines(
      Array.from({ length: 6549 }, (_, i) => `k${i}:  v`).join('\n'),
    )
    const stringify = vi.spyOn(JSON, 'stringify')

    try {
      buildNoteFieldsBlob(entries)
      const whole = stringify.mock.calls.filter(
        ([value]) => typeof value === 'object' && value !== null && 'keys' in value,
      ).length

      expect(whole).toBeLessThanOrEqual(3)
      // And the weights themselves are linear: one pass over the entries, not a sum
      // recomputed per sacrifice step.
      expect(stringify.mock.calls.length).toBeLessThan(entries.length * 4)
    } finally {
      stringify.mockRestore()
    }
  })
})

describe('the sacrifice order is normative, not incidental', () => {
  it('spends values before it spends unreadable names', () => {
    // A value is re-readable from the file, so it goes first; an unreadable NAME is
    // the only carrier of `fieldBad` anywhere in the system, so it goes last. Swap
    // the two rungs and this note reports no unreadable keys at all — a counter of
    // 60 instead — while `fieldBad` stops finding it.
    const bare = Array.from({ length: 60 }, (_, i) => `bad${i}:`)
    const fat = Array.from({ length: 60 }, (_, i) => `key${i}: ${'v'.repeat(200)}`)
    const built = fields([...bare, ...fat].join('\n'))

    expect(built.unreadable?.length).toBe(60)
    expect(built.unreadableMore).toBeUndefined()
    expect(Object.keys(built.keys)).toHaveLength(15)
    expect(built.truncated?.length).toBe(45)
  })

  it('spends truncated names before unreadable names', () => {
    // The middle rung: with every value already gone, the next thing to go is a name
    // out of `truncated`, and `unreadable` still comes out whole.
    const bare = Array.from({ length: 20 }, (_, i) => `bad${i}:`)
    const fat = Array.from({ length: 500 }, (_, i) => `key${i}: ${'v'.repeat(100)}`)
    const built = fields([...bare, ...fat].join('\n'))

    expect(Object.keys(built.keys)).toEqual([])
    expect(built.truncatedMore).toBe(56)
    expect(built.unreadable?.length).toBe(20)
    expect(built.unreadableMore).toBeUndefined()
  })
})

describe('the cap survives adversarial bytes, not just the shapes we thought of', () => {
  // Everything that makes a character cost more than one byte, or makes an analytic
  // weight wrong if it assumes otherwise: multi-byte scripts, surrogate pairs (sliced
  // per code unit, so lone halves occur), the two characters JSON escapes, and the
  // control range it escapes as six characters apiece.
  const ALPHABETS = [
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.',
    'абвгдеёжзийклмнопрстуфхцчшщъыьэюяІЇЄ',
    '中文漢字日本語テストひらがな한국어',
    '😀🙈🚀🇺🇦𝔘𝔫𝔦😊',
    '"\\\t\u0001\u0007\u001f',
  ]

  const text = (rand: () => number, length: number) => {
    const alphabet = ALPHABETS[Math.floor(rand() * ALPHABETS.length)]
    let out = ''

    while (out.length < length) {
      out += alphabet[Math.floor(rand() * alphabet.length)]
    }

    return out
  }

  const corpus = (rand: () => number) => {
    const lines: string[] = []
    const budget = 200 + Math.floor(rand() * 12_000)
    let spent = 0

    const push = (line: string) => {
      lines.push(line)
      spent += line.length + 1
    }

    while (spent < budget && lines.length < 400) {
      const key = `k${lines.length}${text(rand, 1 + Math.floor(rand() * 30))}`.replace(
        /[\n:]/g,
        '_',
      )
      const roll = rand()

      if (roll < 0.12) {
        push(`${key}:`)
      } else if (roll < 0.3) {
        push(`${key}:`)
        for (let i = Math.floor(rand() * 4); i >= 0; i--) {
          push(`- ${text(rand, 1 + Math.floor(rand() * 60))}`)
        }
      } else if (roll < 0.4) {
        push(`${key}:`)
        push(`  nested: ${text(rand, 8)}`)
      } else {
        push(`${key}: ${text(rand, 1 + Math.floor(rand() * (roll < 0.55 ? 1_500 : 80)))}`)
      }
    }

    return lines.join('\n')
  }

  it('never exceeds the cap, on either the build or the patch path', () => {
    let nearCap = 0

    for (let seed = 0; seed < 200; seed++) {
      const rand = seeded(seed)
      const previous = buildNoteFields(parseFrontmatterLines(corpus(rand)))
      const entries = parseFrontmatterLines(corpus(rand))
      const built = utf8Bytes(buildNoteFieldsBlob(entries))
      const patched = utf8Bytes(serializeNoteFields(patchNoteFields(previous, entries)))

      expect(built, `seed ${seed}`).toBeLessThanOrEqual(FIELDS_BLOB_BYTE_CAP)
      expect(patched, `seed ${seed}`).toBeLessThanOrEqual(FIELDS_BLOB_BYTE_CAP)
      if (patched > FIELDS_BLOB_BYTE_CAP - 400) {
        nearCap++
      }
    }
    // The corpus has to actually press against the cap, or the assertion above is
    // vacuous and would stay green through any weight arithmetic at all.
    expect(nearCap).toBeGreaterThan(40)
  })

  it('computes the weights it walks by EXACTLY, on every seed and both paths', () => {
    // The assertion above cannot see a wrong weight and never could: the measuring
    // pass in `applyCap` repairs one silently — an under-count just spends one more
    // element — so a blob under the cap is no evidence the arithmetic that chose it
    // was right. The two numbers are therefore compared to each other. Both paths,
    // because the patch path weighs something the build path never has: the names
    // carried in from the previous projection.
    let carriedNamesShown = 0

    for (let seed = 0; seed < 200; seed++) {
      const rand = seeded(seed)
      const previous = buildNoteFields(parseFrontmatterLines(corpus(rand)))
      const entries = parseFrontmatterLines(corpus(rand))
      const built = measureCappedNoteFields(undefined, entries)
      const patched = measureCappedNoteFields(previous, entries)

      expect(built.analyticBytes, `seed ${seed} built`).toBe(utf8Bytes(built.json))
      expect(patched.analyticBytes, `seed ${seed} patched`).toBe(utf8Bytes(patched.json))
      if (
        (parseNoteFields(patched.json).truncated ?? []).some((key) =>
          (previous.truncated ?? []).includes(key),
        )
      ) {
        carriedNamesShown++
      }
    }
    // …and those carried names have to actually reach a blob, or their weight is
    // never summed and the claim above skips over it.
    expect(carriedNamesShown).toBeGreaterThan(20)

    // The generated corpus never degrades far enough to spend a counter, and the two
    // counter wrappers are weighed analytically like everything else. The inputs that
    // do reach them are the degenerate ones.
    for (const yaml of [
      Array.from({ length: 6549 }, (_, i) => `k${i}:  v`).join('\n'),
      Array.from({ length: 7000 }, (_, i) => `k${i}:`).join('\n'),
    ]) {
      const degenerate = measureCappedNoteFields(undefined, parseFrontmatterLines(yaml))

      expect(degenerate.analyticBytes).toBe(utf8Bytes(degenerate.json))
    }
  })

  it('measures the configuration it settled on, so a lying walk still cannot pass the cap', () => {
    // The other half. Exact weights make the measuring pass unreachable on real
    // input — no data can enter it, so deleting it changes no output anywhere. The
    // seam lies to the walk instead: told to under-count by more than a blob can
    // weigh, it stops before sacrificing anything at all, and the measurement is the
    // only thing left between that and a column over the cap. It lands on the same
    // bytes the honest walk chose, because both stop at the first configuration in
    // the sacrifice sequence that fits.
    for (let seed = 0; seed < 40; seed++) {
      const rand = seeded(seed)
      const previous = buildNoteFields(parseFrontmatterLines(corpus(rand)))
      const entries = parseFrontmatterLines(corpus(rand))
      const lied = measureCappedNoteFields(previous, entries, Number.MAX_SAFE_INTEGER)

      expect(utf8Bytes(lied.json), `seed ${seed}`).toBeLessThanOrEqual(FIELDS_BLOB_BYTE_CAP)
      expect(lied.json, `seed ${seed}`).toBe(measureCappedNoteFields(previous, entries).json)
    }
  })
})

describe('a patch mirrors the write channel and ends at the same cap', () => {
  const patch = (previous: NoteFields | undefined, yaml: string) =>
    patchNoteFields(previous, parseFrontmatterLines(yaml))

  it('leaves a key the write never mentions alone', () => {
    expect(patch(fields('a: 1\nb: 2'), 'b: 3\nc: 4').keys).toEqual({ a: '1', b: '3', c: '4' })
    expect(patch(fields('a: 1\nk:'), 'a: 2').unreadable).toEqual(['k'])
  })

  it('lets a restated key stop being reported as dropped', () => {
    expect(patch(fields('a: 1\nk:'), 'k: now readable')).toEqual({
      keys: { a: '1', k: 'now readable' },
    })
    expect(patch(fields(`small: ok\nbig: ${'x'.repeat(5000)}`), 'big: tiny')).toEqual({
      keys: { small: 'ok', big: 'tiny' },
    })
  })

  it('replaces a restated key in the slot it already held, and only appends a new one', () => {
    // The serializer's `put` replaces at the key's first live occurrence, so the file
    // keeps its order. Order is load-bearing exactly once, and that once decides data:
    // the cap sacrifices from the tail, so a restated key appended here would leave a
    // DIFFERENT key truncated in the snapshot than on disk, for a whole poll interval.
    const patched = patch(fields('alpha: 1\nstatus: doing\nbeta: 2'), 'status: done')

    expect(Object.keys(patched.keys)).toEqual(['alpha', 'status', 'beta'])
    expect(Object.keys(patch(fields('alpha: 1'), 'status: done').keys)).toEqual(['alpha', 'status'])
  })

  it('cannot resurrect a value the cap already took — and says so instead of guessing', () => {
    // The honest limit of patching a lossy projection: `previous` never carried the
    // dropped value, so a write about ANOTHER key leaves it dropped. The engine's own
    // derivation, which reads the file, recovers it on the next poll.
    const authored = Array.from({ length: 60 }, (_, i) => `k${i}: ${'v'.repeat(60)}`).join('\n')
    const previous = fields(authored)

    expect(previous.truncated).toEqual(['k59'])
    expect(patch(previous, 'k0: restated').truncated).toEqual(['k59'])
    expect(
      fields(authored.replace(`k0: ${'v'.repeat(60)}`, 'k0: restated')).truncated,
    ).toBeUndefined()
  })

  it('takes the incoming state of a key even when the cap dropped it', () => {
    // The write said what this key now is; the previous value is stale the moment it
    // lands on disk. Keeping it would show a value the file no longer carries.
    const patched = patch(fields('big: small value\nother: keep'), `big: ${'x'.repeat(5000)}`)

    expect(patched.keys).toEqual({ other: 'keep' })
    expect(patched.truncated).toEqual(['big'])
  })

  it('marks a write the cap could not take, instead of losing it silently', () => {
    const values = patch(
      fields('a: 1'),
      Array.from({ length: 6549 }, (_, i) => `k${i}:  v`).join('\n'),
    )
    const bare = patch(fields('a: 1'), Array.from({ length: 7000 }, (_, i) => `k${i}:`).join('\n'))

    expect(values.truncated?.length).toBeGreaterThan(0)
    expect(values.truncatedMore).toBeGreaterThan(0)
    expect(bare.unreadable?.length).toBeGreaterThan(0)
    expect(bare.unreadableMore).toBeGreaterThan(0)
  })

  it('keeps a carried truncated name ahead of one this merge just demoted', () => {
    // `truncated` is authored order, and on this path it is two of them joined: the
    // names the previous projection already carried, then the names this merge had to
    // demote. Which end is which is not cosmetic — the list sheds from its TAIL, and a
    // name that falls off into `truncatedMore` stops answering `fieldAny` at all.
    const big = 'v'.repeat(1200)
    const previous = fields(`keep: ok\nalpha: ${big}\nbeta: ${big}\ngone: ${'x'.repeat(2000)}`)

    expect(previous.truncated, 'the fixture must start out carrying one name').toEqual(['gone'])
    expect(patch(previous, `fresh: ${big}\nlater: ${big}`).truncated).toEqual(['gone', 'later'])

    // And the same order deciding data: with every value already spent, the name this
    // merge demoted is the one the list can no longer afford.
    const pad = (name: string, size: number) => name + 'x'.repeat(size - name.length)
    const [carried, also] = [pad('carried', 3500), pad('also', 500)]
    const wide = fields(`${carried}: ${'v'.repeat(2000)}\n${also}: ${'v'.repeat(2000)}`)
    const patched = patch(wide, `${pad('fresh', 300)}: v`)

    expect(wide.truncated).toEqual([carried, also])
    expect(patched.truncated).toEqual([carried, also])
    expect(patched.truncatedMore).toBe(1)
  })

  it('carries the previous counters forward', () => {
    expect(
      patch(parseNoteFields('{"keys":{},"unreadableMore":2,"truncatedMore":3}'), 'a: 1'),
    ).toEqual({ keys: { a: '1' }, unreadableMore: 2, truncatedMore: 3 })
  })

  it('stays under the cap across a series of writes with no poll between them', () => {
    // The invariant is the snapshot's per-note memory ceiling, so it has to survive
    // repetition: an unmeasured merge grows the blob by every write forever.
    const value = 'v'.repeat(40)
    let patched = fields(Array.from({ length: 120 }, (_, i) => `key${i}: ${value}`).join('\n'))

    for (let round = 0; round < 4; round++) {
      patched = patch(
        patched,
        Array.from({ length: 60 }, (_, i) => `r${round}k${i}: ${value}`).join('\n'),
      )

      expect(utf8Bytes(serializeNoteFields(patched)), `round ${round}`).toBeLessThanOrEqual(
        FIELDS_BLOB_BYTE_CAP,
      )
    }
  })

  it('keeps the null prototype on the merged keys', () => {
    const patched = patch(fields('a: 1'), 'b: 2')

    expect(Object.getPrototypeOf(patched.keys)).toBeNull()
  })
})

describe('what the optimistic mirror promises, and where that promise stops', () => {
  // The file the write actually leaves behind, so the comparison is against bytes the
  // next poll will really derive: the serializer replaces a key at its first authored
  // occurrence, collapses the duplicates that follow it, and appends only a genuinely
  // new key. Modelled here rather than imported because the engine that owns it sits
  // on the other side of this package's boundary.
  const afterWrite = (
    before: readonly FrontmatterEntry[],
    write: readonly FrontmatterEntry[],
  ): FrontmatterEntry[] => {
    let out = [...before]

    for (const entry of write) {
      const at = out.findIndex((e) => e.key === entry.key)

      if (at < 0) {
        out.push(entry)
        continue
      }
      out[at] = entry
      out = out.filter((e, i) => i === at || e.key !== entry.key)
    }

    return out
  }

  const mirrored = (file: string, write: string) =>
    serializeNoteFields(patchNoteFields(fields(file), parseFrontmatterLines(write)))
  const derived = (file: string, write: string) =>
    buildNoteFieldsBlob(afterWrite(parseFrontmatterLines(file), parseFrontmatterLines(write)))

  const WIDE = Array.from({ length: 40 }, (_, i) => `k${i}: ${'v'.repeat(60)}`).join('\n')

  it.each([
    {
      shape: 'a key restated in the slot it already held',
      file: 'alpha: 1\nstatus: doing\nbeta: 2',
      write: 'status: done',
    },
    { shape: 'a key the file never had', file: 'alpha: 1', write: 'status: done' },
    {
      shape: 'integer-like keys, which JS hoists on both sides alike',
      file: 'alpha: 1\n2026: budget\n7: seven',
      write: 'status: done\n2026: spent',
    },
    {
      shape: 'a scalar replaced by a list',
      file: 'alpha: 1\nreviewers: ann',
      write: 'reviewers:\n- ann\n- bo',
    },
    {
      shape: 'several keys at once, restated and new',
      file: 'a: 1\nb: 2\nc: 3',
      write: 'c: 30\nd: 4\na: 10',
    },
    { shape: 'a value emptied without the key being removed', file: 'a: 1\nb: 2', write: "b: ''" },
    {
      shape: 'a duplicate the file carried, collapsed by the write',
      file: 'a: 1\nk: first\nb: 2\nk: second',
      write: 'k: third',
    },
    { shape: 'a key in the middle of a wide block', file: WIDE, write: 'k20: restated' },
  ])('spells what the next poll derives, byte for byte — $shape', ({ file, write }) => {
    expect(mirrored(file, write)).toBe(derived(file, write))
  })

  it('cannot place a name the projection carries without a position — the one gap below the cap', () => {
    // `unreadable` is a list of NAMES. The projection knows k is unreadable and knows
    // nothing about where among the other keys it sat, so a write that moves a key out
    // of that list, into it, or restates one already in it puts the name where this
    // merge can — the end — while the file keeps it where the author left it. Nothing
    // fixable is hiding here: the position is not in the projection to be read. The
    // divergence is spelled out on both sides rather than waved at, so a future change
    // of behaviour shows up as a red instead of passing under a rule that permits it.
    expect(mirrored('k:\na: 1', 'k: now readable')).toBe('{"keys":{"a":"1","k":"now readable"}}')
    expect(derived('k:\na: 1', 'k: now readable')).toBe('{"keys":{"k":"now readable","a":"1"}}')

    expect(mirrored('alpha: 1\nbeta: 2\nbad:', 'beta:')).toBe(
      '{"keys":{"alpha":"1"},"unreadable":["bad","beta"]}',
    )
    expect(derived('alpha: 1\nbeta: 2\nbad:', 'beta:')).toBe(
      '{"keys":{"alpha":"1"},"unreadable":["beta","bad"]}',
    )

    expect(mirrored('bad:\nalso:', 'bad:')).toBe('{"keys":{},"unreadable":["also","bad"]}')
    expect(derived('bad:\nalso:', 'bad:')).toBe('{"keys":{},"unreadable":["bad","also"]}')
  })

  it('has no OTHER gap below the cap, over a generated corpus of shapes', () => {
    // The cases above are examples; this is the claim they are examples of. Every
    // shape the generator makes, on the single condition that gap states — the write
    // touches no name that is unreadable before it or after it — must come out
    // byte-identical. A second gap of any kind lands here as a red.
    const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'ключ', '2026', '7']
    const entry = (key: string, roll: number, tag: string) =>
      roll < 0.34 ? `${key}: v${tag}` : roll < 0.67 ? `${key}:\n- a${tag}\n- b${tag}` : `${key}:`

    const draw = (rand: () => number, count: number) => {
      const pool = [...NAMES]

      return Array.from(
        { length: count },
        () => pool.splice(Math.floor(rand() * pool.length), 1)[0],
      )
    }
    const spell = (rand: () => number, count: number, tag: string) =>
      draw(rand, count)
        .map((key) => entry(key, rand(), tag))
        .join('\n')
    let compared = 0
    let gapped = 0

    for (let seed = 0; seed < 1500; seed++) {
      const rand = seeded(seed)
      const file = spell(rand, 1 + Math.floor(rand() * 6), '0')
      const write = spell(rand, 1 + Math.floor(rand() * 3), '1')
      const entries = parseFrontmatterLines(write)
      const written = new Set(entries.map((e) => e.key))
      const previous = fields(file)
      const next = buildNoteFields(afterWrite(parseFrontmatterLines(file), entries))
      const names = [...(previous.unreadable ?? []), ...(next.unreadable ?? [])]

      if (names.some((key) => written.has(key))) {
        gapped++
        continue
      }
      compared++
      expect(mirrored(file, write), `seed ${seed}`).toBe(serializeNoteFields(next))
    }
    // Both counts, or the loop proves whichever half it never reached.
    expect(compared).toBeGreaterThan(400)
    expect(gapped).toBeGreaterThan(400)
  })

  it('promises nothing about composition once the note is AT the cap', () => {
    // Above the gap below the cap sits the one the design draws: at the cap the mirror
    // is not authoritative, by composition or by order, until the next poll. Here is
    // what that costs, exactly. The projection hands the merge its keys in property
    // order, where JS has already hoisted `2026` to the front, so the tail it
    // sacrifices from is not the tail of the file — the mirror drops the key the write
    // just set, and the index drops the one the author put last.
    const big = 'v'.repeat(1300)
    const file = `alpha: ${big}\nstatus: ${big}\n2026: ${big}`
    const write = `status: ${'v'.repeat(1500)}`
    const previous = fields(file)
    const patched = patchNoteFields(previous, parseFrontmatterLines(write))
    const next = buildNoteFields(
      afterWrite(parseFrontmatterLines(file), parseFrontmatterLines(write)),
    )

    expect(previous.truncated, 'the fixture must reach the cap on the WRITE').toBeUndefined()
    expect(Object.keys(patched.keys)).toEqual(['2026', 'alpha'])
    expect(patched.truncated).toEqual(['status'])
    expect(Object.keys(next.keys)).toEqual(['alpha', 'status'])
    expect(next.truncated).toEqual(['2026'])
    // What the cap never stops promising: the ceiling itself holds on both.
    expect(utf8Bytes(serializeNoteFields(patched))).toBeLessThanOrEqual(FIELDS_BLOB_BYTE_CAP)
  })
})

describe('serialization is deterministic', () => {
  it('omits every empty list and zero counter', () => {
    expect(blob('')).toBe('{"keys":{}}')
    expect(blob('a: 1')).toBe('{"keys":{"a":"1"}}')
  })

  it('spells the column default the engine DDL repeats by hand', () => {
    // `fields TEXT NOT NULL DEFAULT '{"keys":{}}'` is a frozen ladder step in the
    // engine's schema, and a frozen step imports nothing. Adoption of a note with no
    // author key stands on the two strings being equal: diverge, and the whole corpus
    // re-derives forever. This file cannot state that equality — core may not import
    // the engine — so it pins CORE's half in bytes, including the shape the real
    // corpus has: a block of nothing but keys the note projects onto metadata of its
    // own. The two halves meet in test/enumDrift.test.ts (`empty fields blob drift`),
    // which reads the ladder step's SQL and compares it against this builder.
    expect(blob('')).toBe('{"keys":{}}')
    expect(blob('title: T\ntags:\n- a')).toBe('{"keys":{}}')
  })

  it('spells the degenerate shapes byte for byte as well', () => {
    // Nothing else pins the bytes of a blob that carries a list or a counter, and
    // those are exactly the shapes a reader has to recognise to report a key as
    // findable-but-unreadable or as not indexed at all.
    const wide = (name: string) => name + 'x'.repeat(2000)
    const [a, b, c] = ['a', 'b', 'c'].map(wide)

    expect(blob('k:')).toBe('{"keys":{},"unreadable":["k"]}')
    expect(blob(`small: ok\nbig: ${'x'.repeat(5000)}`)).toBe(
      '{"keys":{"small":"ok"},"truncated":["big"]}',
    )
    expect(blob(`${a}: v\n${b}: v\n${c}: v`)).toBe(
      `{"keys":{},"truncated":["${a}","${b}"],"truncatedMore":1}`,
    )
    expect(blob(`${a}:\n${b}:\n${c}:`)).toBe(
      `{"keys":{},"unreadable":["${a}","${b}"],"unreadableMore":1}`,
    )
  })

  it('round-trips a full shape', () => {
    const json =
      '{"keys":{"a":"1","b":["x"]},"unreadable":["u"],"unreadableMore":2,"truncated":["t"],"truncatedMore":3}'

    expect(serializeNoteFields(parseNoteFields(json))).toBe(json)
  })

  it('degrades a corrupt column to an empty projection instead of throwing', () => {
    for (const bad of ['', 'not json', 'null', '[]', '{"keys":7}']) {
      expect(serializeNoteFields(parseNoteFields(bad))).toBe('{"keys":{}}')
    }
  })
})
