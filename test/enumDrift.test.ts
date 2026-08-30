/**
 * Enum drift gate (P8).
 *
 * WHY: architecture P8 keeps `@notarium/core` and `@notarium/contract`
 * DECOUPLED — neither package takes a RUNTIME dependency on the other (the one
 * sanctioned edge is type-only, fenced in eslint.config.js: types erase, so core
 * still ships without contract). A domain enum that both layers
 * need (a scan phase, a revision kind, a note class, ...) therefore lives as TWO
 * independent const-object copies, one per package, each its own single source
 * of truth for its side. Nothing at compile time forces those two copies to stay
 * identical, so they can silently DRIFT (a value added to core's write path but
 * not to the wire schema, a renamed key, a dropped member) and only blow up far
 * downstream where a raw string crosses the seam. These tests are that missing
 * link: for every enum present in BOTH packages as the "same enum", they assert
 * the two decoupled copies are structurally equal (identical key set + identical
 * values), turning drift into a red test in this repo instead of a runtime bug.
 *
 * Exceptions (documented, not drift):
 *  - RESOLVED_VIA: core carries an extra `current` axis; contract deliberately
 *    omits it because `current` never crosses the graph-health wire. Not an
 *    identical copy — guarded as a subset relationship below, not by toEqual.
 *  - IF_EXISTS: contract omits core's `overwrite` on purpose — see the subset
 *    gate below; that omission is the poka-yoke, not drift.
 *  - STORE_ERROR_REASON: exists only in core; contract has no matching const
 *    source (only an inline `z.literal('version_conflict')`), so there is no
 *    cross-package pair to gate. Skipped here.
 */
import { describe, expect, it } from 'vitest'

import {
  AbilityLocatorSchema,
  AuthoredAttachmentSchema,
  FieldSchemaResponseSchema,
  FieldSchemaUpdateSchema,
  NoteFieldsWireSchema,
  parseFieldFilter,
} from '@notarium/contract'
import {
  AGENT_SESSION_ATTACH as ContractAgentSessionAttach,
  BUCKET_GRAN as ContractBucketGran,
  DATE_FIELD as ContractDateField,
  DEPTH as ContractDepth,
  FIELD_COLOR as ContractFieldColor,
  FIELD_FACET_MAX_VALUES as ContractFieldFacetMaxValues,
  FIELD_SCHEMA_MAX_BYTES as ContractFieldSchemaMaxBytes,
  FIELD_SCHEMA_MAX_FIELDS as ContractFieldSchemaMaxFields,
  FIELD_SCHEMA_MAX_VALUES as ContractFieldSchemaMaxValues,
  FIELD_SCHEMA_VERSION as ContractFieldSchemaVersion,
  FIELD_TYPE as ContractFieldType,
  IF_EXISTS as ContractIfExists,
  INDEXED_PROTECTED_FIELD_KEYS as ContractIndexedProtectedFieldKeys,
  NOTE_CLASS as ContractNoteClass,
  NOTE_SORT as ContractNoteSort,
  PROJECTED_FIELD_KEYS as ContractProjectedFieldKeys,
  PROTECTED_FIELD_KEYS as ContractProtectedFieldKeys,
  RESOLVED_VIA as ContractResolvedVia,
  REVISION_KIND as ContractRevisionKind,
  REVISION_UNAVAILABLE_REASON as ContractRevisionUnavailableReason,
  SCAN_PHASE as ContractScanPhase,
  SORT_DIR as ContractSortDir,
} from '@notarium/contract'
// EDIT_OPERATION lives on contract's `./tools` subpath (the MCP tool surface),
// not the `/api/*` wire barrel, so it resolves from a different entry point.
import { EDIT_OPERATION as ContractEditOperation } from '@notarium/contract/tools'
import {
  buildNoteFields,
  buildNoteFieldsBlob,
  type FieldFilter,
  FIELDS_BLOB_BYTE_CAP,
  FRONTMATTER_BYTE_CAP,
  isAbilityLocator,
  isSkillName,
  MAX_SKILL_TOKEN,
  type NoteFields,
  parseFrontmatterLines,
  parseNoteFields,
  parseSkillLinks,
  serializeNoteFields,
  utf8Bytes,
} from '@notarium/core'
import {
  AGENT_SESSION_ATTACH as CoreAgentSessionAttach,
  BUCKET_GRAN as CoreBucketGran,
  DATE_FIELD as CoreDateField,
  DEPTH as CoreDepth,
  EDIT_OPERATION as CoreEditOperation,
  FIELD_COLOR as CoreFieldColor,
  FIELD_FACET_MAX_VALUES as CoreFieldFacetMaxValues,
  FIELD_SCHEMA_MAX_BYTES as CoreFieldSchemaMaxBytes,
  FIELD_SCHEMA_MAX_FIELDS as CoreFieldSchemaMaxFields,
  FIELD_SCHEMA_MAX_VALUES as CoreFieldSchemaMaxValues,
  FIELD_SCHEMA_VERSION as CoreFieldSchemaVersion,
  FIELD_TYPE as CoreFieldType,
  IF_EXISTS as CoreIfExists,
  INDEXED_PROTECTED_FIELD_KEYS as CoreIndexedProtectedFieldKeys,
  NOTE_CLASS as CoreNoteClass,
  NOTE_SORT as CoreNoteSort,
  PROJECTED_FIELD_KEYS as CoreProjectedFieldKeys,
  PROTECTED_FIELD_KEYS as CoreProtectedFieldKeys,
  RESOLVED_VIA as CoreResolvedVia,
  REVISION_KIND as CoreRevisionKind,
  REVISION_UNAVAILABLE_REASON as CoreRevisionUnavailableReason,
  SCAN_PHASE as CoreScanPhase,
  SORT_DIR as CoreSortDir,
} from '@notarium/core'

import { INDEX_MIGRATIONS } from '../packages/engine/src/services/notariumStore/schema'

/** Enums that MUST be byte-for-byte identical copies across the P8 seam. */
const identicalPairs: ReadonlyArray<
  [name: string, core: Record<string, string>, contract: Record<string, string>]
> = [
  ['AGENT_SESSION_ATTACH', CoreAgentSessionAttach, ContractAgentSessionAttach],
  ['SCAN_PHASE', CoreScanPhase, ContractScanPhase],
  ['REVISION_KIND', CoreRevisionKind, ContractRevisionKind],
  ['REVISION_UNAVAILABLE_REASON', CoreRevisionUnavailableReason, ContractRevisionUnavailableReason],
  ['NOTE_SORT', CoreNoteSort, ContractNoteSort],
  ['SORT_DIR', CoreSortDir, ContractSortDir],
  ['BUCKET_GRAN', CoreBucketGran, ContractBucketGran],
  ['DATE_FIELD', CoreDateField, ContractDateField],
  ['DEPTH', CoreDepth, ContractDepth],
  ['EDIT_OPERATION', CoreEditOperation, ContractEditOperation],
  ['NOTE_CLASS', CoreNoteClass, ContractNoteClass],
  ['FIELD_TYPE', CoreFieldType, ContractFieldType],
  ['FIELD_COLOR', CoreFieldColor, ContractFieldColor],
]

describe('enum drift across the P8 core/contract seam', () => {
  describe.each(identicalPairs)('%s', (_name, core, contract) => {
    it('has the same key set in both packages', () => {
      expect(Object.keys(core).sort()).toEqual(Object.keys(contract).sort())
    })

    it('maps every key to the same value in both packages', () => {
      expect(core).toEqual(contract)
    })
  })

  // RESOLVED_VIA is NOT an identical copy: contract is a strict subset of core
  // (core adds `current`, which never crosses the graph-health wire). The gate
  // here is the intended relationship — contract ⊂ core, and every shared key
  // agrees on its value — so a drift on the SHARED axes still fails loudly while
  // the deliberate off-wire `current` divergence stays allowed.
  describe('RESOLVED_VIA (contract is a deliberate subset of core)', () => {
    it('exposes only keys that also exist in core', () => {
      for (const key of Object.keys(ContractResolvedVia)) {
        expect(CoreResolvedVia).toHaveProperty(key)
      }
    })

    it('agrees on the value of every shared key', () => {
      for (const [key, value] of Object.entries(ContractResolvedVia)) {
        expect(CoreResolvedVia[key as keyof typeof CoreResolvedVia]).toBe(value)
      }
    })

    it('keeps core-only `current` off the contract wire', () => {
      expect(CoreResolvedVia).toHaveProperty('current')
      expect(ContractResolvedVia).not.toHaveProperty('current')
    })
  })

  // IF_EXISTS is the same shape of deliberate subset, and here the omission is a
  // SECURITY property rather than tidiness: `overwrite` is the one policy that lets a
  // create replace another note's bytes, so it must stay unreachable from any client.
  // canon: docs/note-model.md#create-collisions
  describe('IF_EXISTS (contract is a deliberate subset of core)', () => {
    it('agrees on the value of every key it does expose', () => {
      for (const [key, value] of Object.entries(ContractIfExists)) {
        expect(CoreIfExists[key as keyof typeof CoreIfExists]).toBe(value)
      }
    })

    it('keeps `overwrite` off the wire — host-internal only', () => {
      expect(CoreIfExists).toHaveProperty('overwrite')
      expect(ContractIfExists).not.toHaveProperty('overwrite')
    })
  })
})

/**
 * The same P8 seam for the field axis, where the two copies are LISTS, not dicts. Which
 * copy answers for what is the canon's line, not this one; what belongs here is the
 * consequence a gate can hold — a key that drifted onto only one side would be
 * declarable but unwritable, or writable straight over a typed channel.
 * canon: docs/architecture.md#literals
 */
describe('protected field keys drift (P8)', () => {
  const pairs: ReadonlyArray<[name: string, core: readonly string[], contract: readonly string[]]> =
    [
      ['PROJECTED_FIELD_KEYS', CoreProjectedFieldKeys, ContractProjectedFieldKeys],
      [
        'INDEXED_PROTECTED_FIELD_KEYS',
        CoreIndexedProtectedFieldKeys,
        ContractIndexedProtectedFieldKeys,
      ],
      ['PROTECTED_FIELD_KEYS', CoreProtectedFieldKeys, ContractProtectedFieldKeys],
    ]

  it.each(pairs)('%s holds the same keys in both packages', (_name, core, contract) => {
    expect([...core].sort()).toEqual([...contract].sort())
  })
})

describe('field filter shape drift (P8)', () => {
  it('lets core consume the tree built by contract', () => {
    const consume = (value: FieldFilter): FieldFilter => value
    const parsed = parseFieldFilter({
      field: ['note.status:wip'],
      fieldAny: ['note.owner'],
      fieldBad: ['note.shape'],
    })

    expect(consume(parsed!)).toEqual(parsed)
  })
})

describe('field schema scalar limits drift (P8)', () => {
  it.each([
    ['FIELD_SCHEMA_VERSION', CoreFieldSchemaVersion, ContractFieldSchemaVersion],
    ['FIELD_SCHEMA_MAX_BYTES', CoreFieldSchemaMaxBytes, ContractFieldSchemaMaxBytes],
    ['FIELD_SCHEMA_MAX_FIELDS', CoreFieldSchemaMaxFields, ContractFieldSchemaMaxFields],
    ['FIELD_SCHEMA_MAX_VALUES', CoreFieldSchemaMaxValues, ContractFieldSchemaMaxValues],
    ['FIELD_FACET_MAX_VALUES', CoreFieldFacetMaxValues, ContractFieldFacetMaxValues],
  ])('%s has the same value in both packages', (_name, core, contract) => {
    expect(core).toBe(contract)
  })
})

describe('field schema human-name uniqueness', () => {
  it('rejects duplicate field names and same-enum option names, but not cross-enum values', () => {
    const base = {
      version: 1 as const,
      versionToken: 'v1',
      fields: [
        {
          key: 'status',
          type: 'enum' as const,
          label: 'Status',
          values: [
            { key: 'done', label: 'Done' },
            { key: 'closed', label: 'Closed' },
          ],
        },
        {
          key: 'resolution',
          type: 'enum' as const,
          label: 'Resolution',
          values: [{ key: 'done', label: 'Done' }],
        },
      ],
    }

    expect(FieldSchemaUpdateSchema.safeParse(base).success).toBe(true)
    expect(
      FieldSchemaUpdateSchema.safeParse({
        ...base,
        fields: [...base.fields, { key: 'status-2', type: 'text', label: ' status ' }],
      }).success,
    ).toBe(false)
    expect(
      FieldSchemaUpdateSchema.safeParse({
        ...base,
        fields: [...base.fields, { key: 'cafe', type: 'text', label: 'Cafe\u0301' }],
      }).success,
    ).toBe(true)
    expect(
      FieldSchemaUpdateSchema.safeParse({
        ...base,
        fields: [
          { key: 'cafe-one', type: 'text', label: 'Café' },
          { key: 'cafe-two', type: 'text', label: 'Cafe\u0301' },
        ],
      }).success,
    ).toBe(false)
    expect(
      FieldSchemaResponseSchema.safeParse({
        ...base,
        fields: [...base.fields, { key: 'status-2', type: 'text', label: ' status ' }],
      }).success,
    ).toBe(false)
    expect(
      FieldSchemaUpdateSchema.safeParse({
        ...base,
        fields: [
          {
            ...base.fields[0],
            values: [...base.fields[0].values, { key: 'done-2', label: ' done ' }],
          },
        ],
      }).success,
    ).toBe(false)
  })
})

/**
 * The fields blob is the third duplicated SHAPE across the seam: core BUILDS it for
 * the index column, contract READS it on the wire. Neither can import the other, so
 * a member added on one side only would surface as a note whose field is indexed and
 * invisible (or validated away).
 *
 * WHY THIS IS SEARCHED AND NOT LISTED. "The schema accepts exactly what the builder
 * produces" is a function OF THE SCHEMA, not a constant. Four passes wrote it down as
 * a list of axes and four lists came out short — the last one declared six axes and
 * called the list closed while twelve were reachable, six of them past a schema that
 * went green. So the claim is derived instead: a seeded generator walks the FRONTMATTER
 * grammar (a block is entries; an entry is a name and a value; a value is a scalar, a
 * list, or one of the spellings that carries none), every blob core builds from it has
 * to cross the wire unchanged, and a second assertion re-reads the produced blobs to
 * check the search reached the ceiling of every dimension they actually contain. A
 * bound added anywhere inside the schema — on a record key, on a value, on a list, on
 * a counter, on a member nobody has written yet — meets a witness without this file
 * being edited. Owner's decision, 2026-08-20, fork 25.
 */
describe('fields blob shape drift (P8)', () => {
  /** The member set as a VALUE. `keyof NoteFields` erases, so this literal is the
   *  only place a member core adds to its type meets a compiler — `satisfies` fails
   *  on a missing one and on a stray one. */
  const members = {
    keys: true,
    unreadable: true,
    unreadableMore: true,
    truncated: true,
    truncatedMore: true,
  } satisfies Record<keyof NoteFields, true>

  const built = (frontmatter: string): NoteFields =>
    buildNoteFields(parseFrontmatterLines(frontmatter))

  /** Every member at once — hand-written, because no build produces all five: the cap
   *  empties `truncated` before it drops a single `unreadable` name, so `truncated`
   *  and `unreadableMore` never ride in one blob. */
  const whole = {
    keys: { status: 'done', reviewers: ['ann', 'bo'], empty: '' },
    unreadable: ['broken'],
    unreadableMore: 1,
    truncated: ['dropped'],
    truncatedMore: 2,
  }

  // ── the generator ─────────────────────────────────────────────────────────

  /** A seeded PRNG (mulberry32). `Math.random` would make a red unreproducible, and
   *  a generated corpus nobody can replay is not evidence of anything. */
  const seeded = (seed: number) => (): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Character families a hand-edited frontmatter really carries, kept apart so one
   *  corpus is drawn from one of them rather than from their blur: ASCII, Cyrillic,
   *  CJK, astral (surrogate pairs), the characters JSON must escape together with the
   *  separators no `split('\n')` ever sees (U+0085, U+2028, U+2029) and the C0/C1
   *  controls, and YAML's own indicators. The escapes family is the load-bearing one:
   *  the durable-scalar family this repo spells `title`/`slug`/`tags` with refuses
   *  every character in it, and the builder emits every one of them — an author's
   *  value is a line of a file, not an identity. The indicators are the other side of
   *  the same coin: they are what makes the reader hand back a key with no value. */
  const ALPHABETS: ReadonlyArray<readonly string[]> = [
    [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_. '],
    [...'абвгдеёжзиклмнопрсту '],
    [...'漢字仮名交じり文한글'],
    [...'\u{1F600}\u{1F648}\u{1F9D1}\u{1F30D}\u{1F1F7}\u{1F1FA}'],
    [...'"\\\t\u0085\u2028\u2029\u0001\u0007\u001f\u007f\u009f'],
    [...`'#:;>|&*!?[]{},%@\`~^$()=+/`],
  ]

  /** How an entry spells its value. Closed by the PARSER, not by us: a top-level YAML
   *  entry this reader models is a scalar or a block list, and the rest are the
   *  spellings that carry no value at all. */
  const FORMS = ['scalar', 'list', 'bare', 'nested', 'flow', 'blank'] as const
  /** The three with an interior a size can grow into. */
  const SIZED_FORMS = ['scalar', 'list', 'bare'] as const

  /** Every place a SIZE appears in that grammar. There is nowhere else a length can
   *  live, which is why this list — unlike a list of schema axes — is closed. */
  const SIZES = ['entries', 'name', 'value', 'list', 'item'] as const

  type Form = (typeof FORMS)[number]
  type Size = (typeof SIZES)[number]
  type Shape = {
    seed: number
    /** Ceiling corpora hold every size exactly; search corpora draw each one afresh. */
    exact: boolean
    names: readonly string[]
    values: readonly string[]
    form: Form | null
  } & Record<Size, number>

  /** The frontmatter this corpus is allowed to spend. The parser refuses a block over
   *  `FRONTMATTER_BYTE_CAP`, so that is the real bound on what the builder can ever
   *  see; a quarter of it already overflows the blob cap four times over, and the three
   *  quarters left buy nothing but seconds. */
  const BLOCK_BUDGET = FRONTMATTER_BYTE_CAP / 4
  /** Every entry a block that size can hold: `a:` plus its newline is three bytes. */
  const MOST_ENTRIES = Math.floor(BLOCK_BUDGET / 3)
  /** How far a ceiling grows before the search gives up. A string cannot outgrow the
   *  blob that has to hold it; a collection cannot outgrow the blob divided by the
   *  four bytes its smallest element costs (`"x",`). */
  const CEILING_LIMIT: Record<Size, number> = {
    entries: FIELDS_BLOB_BYTE_CAP / 4,
    list: FIELDS_BLOB_BYTE_CAP / 4,
    name: FIELDS_BLOB_BYTE_CAP,
    value: FIELDS_BLOB_BYTE_CAP,
    item: FIELDS_BLOB_BYTE_CAP,
  }

  /** Log-uniform over [1, top], and ON top often enough to be worth generating: a
   *  uniform search spends almost no time at the very edge of its range, and the edge
   *  is exactly where a bound would sit. */
  const span = (rand: () => number, top: number): number =>
    rand() < 0.3 ? top : Math.max(1, Math.round(Math.exp(rand() * Math.log(Math.max(1, top)))))

  const token = (rand: () => number, chars: readonly string[], length: number): string => {
    let out = ''

    for (let i = 0; i < length; i++) {
      out += chars[Math.floor(rand() * chars.length)]
    }

    return out
  }

  /** One shape rendered as the bytes between a note's `---` fences. No token ever
   *  carries a line break: that would end the entry rather than widen it, and the
   *  point of a size is to widen. */
  const render = (shape: Shape): string => {
    const rand = seeded(shape.seed ^ 0x5bf03635)
    const size = (of: Size): number => (shape.exact ? shape[of] : span(rand, shape[of]))
    const lines: string[] = []
    let bytes = 0

    for (let n = 0; n < shape.entries; n++) {
      const name = token(rand, shape.names, size('name'))
      const form = shape.form ?? FORMS[Math.floor(rand() * FORMS.length)]
      let entry: string

      if (form === 'list') {
        const items: string[] = []
        const count = size('list')

        for (let i = 0; i < count; i++) {
          items.push(`- ${token(rand, shape.values, size('item'))}`)
        }
        entry = `${name}:\n${items.join('\n')}`
      } else if (form === 'scalar') {
        entry = `${name}: ${token(rand, shape.values, size('value'))}`
      } else if (form === 'bare') {
        entry = `${name}:`
      } else if (form === 'nested') {
        entry = `${name}:\n  nested: 1`
      } else if (form === 'flow') {
        entry = `${name}: []`
      } else {
        entry = `${name}: ''`
      }
      const cost = utf8Bytes(entry) + 1

      if (bytes + cost > BLOCK_BUDGET) {
        break
      }
      lines.push(entry)
      bytes += cost
    }

    return lines.join('\n')
  }

  /** The mixing family: a random alphabet, a random density, every size drawn again
   *  per entry. Entry count and token size are coupled through what is left of the
   *  block, so a corpus is either a few enormous entries or thousands of minimal ones
   *  rather than an unbuildable mixture of both. */
  const searchShape = (seed: number): Shape => {
    const rand = seeded(seed)
    const entries = span(rand, MOST_ENTRIES)
    const room = Math.max(2, Math.floor(BLOCK_BUDGET / entries))

    return {
      seed,
      exact: false,
      names: ALPHABETS[Math.floor(rand() * ALPHABETS.length)],
      values: ALPHABETS[Math.floor(rand() * ALPHABETS.length)],
      form: rand() < 0.4 ? FORMS[Math.floor(rand() * FORMS.length)] : null,
      entries,
      name: span(rand, room),
      value: span(rand, room),
      list: span(rand, room),
      item: span(rand, room),
    }
  }

  const untouched = (fields: NoteFields): boolean =>
    !fields.truncated && !fields.truncatedMore && !fields.unreadableMore

  /** The ceiling family: one size of the grammar grown, by MEASURING the blob, to the
   *  widest the cap still carries whole. Nothing here knows which member of the blob
   *  that size ends up in — it grows a name, a value, a list or a count of entries and
   *  reads back whether the cap bit yet, so a member the shape gains later is reached
   *  by the same five growths. Galloping first keeps every probe within twice the
   *  answer; a plain search over the limit would render corpora nobody needs. */
  const ceilingShapes = (): Shape[] => {
    const out: Shape[] = []
    let seed = 0

    for (const grow of SIZES) {
      for (const alphabet of ALPHABETS) {
        for (const form of SIZED_FORMS) {
          const base: Shape = {
            seed: seed++,
            exact: true,
            form,
            names: alphabet,
            values: alphabet,
            entries: 1,
            // Two characters, so growing the COUNT of entries is not capped by how
            // many distinct one-character names the alphabet happens to have.
            name: grow === 'entries' ? 2 : 1,
            value: 1,
            list: 1,
            item: 1,
          }
          const fits = (to: number): boolean => untouched(built(render({ ...base, [grow]: to })))
          const limit = CEILING_LIMIT[grow]
          let low = 1
          let high = 2

          while (high < limit && fits(high)) {
            low = high
            high = Math.min(limit, high * 2)
          }
          while (low < high) {
            const mid = Math.ceil((low + high) / 2)

            if (fits(mid)) {
              low = mid
            } else {
              high = mid - 1
            }
          }
          out.push({ ...base, [grow]: low })
        }
      }
    }

    return out
  }

  /** The other end of the same axis: as many minimal entries as the block holds, one
   *  corpus per value form. This is where the two counters go, because a counter only
   *  moves once the blob has run out of room to name what it dropped. */
  const floodShapes = (): Shape[] =>
    FORMS.map((form, index) => ({
      seed: 9000 + index,
      exact: true,
      form,
      names: ALPHABETS[0],
      values: ALPHABETS[0],
      entries: MOST_ENTRIES,
      name: 3,
      value: 1,
      list: 1,
      item: 1,
    }))

  /** One entry per character the alphabets can draw, each sitting BETWEEN two ordinary
   *  letters — the position where the reader keeps it rather than trimming or refusing
   *  it. Without this the repertoire assertion below would be a coin flip: a character
   *  reaches a blob only from a value the parser could read whole, and a random draw
   *  puts it at an edge as often as not. */
  const repertoireCorpora = (): string[] => {
    const points = [...new Set(ALPHABETS.flat())]

    return [
      points.map((char, index) => `k${index}: a${char}b`).join('\n'),
      points.map((char) => `a${char}b: v`).join('\n'),
    ]
  }

  /** Hundreds of corpora, not tens of thousands: the ceiling and flood families do the
   *  reaching, the search does the mixing, and the assertion below proves the mixture
   *  got there rather than assuming it. */
  const SEARCH_CORPORA = 140

  // ── what the search found ─────────────────────────────────────────────────

  /** The widest of everything one PLACE in a blob was seen holding. The place is the
   *  path the walk discovered, not a member this file named: a fixed member of the
   *  blob keeps its own name, and everything under it — author keys, list items — is
   *  a wildcard, because author data is what lives one level down. */
  type Reach = {
    kinds: Set<string>
    chars: number
    bytes: number
    items: number
    members: number
    count: number
  }

  type Survey = {
    blobs: NoteFields[]
    reach: Map<string, Reach>
    points: Set<number>
  }

  const walk = (path: string, value: unknown, survey: Survey, root = false): void => {
    const reach = survey.reach.get(path) ?? {
      kinds: new Set<string>(),
      chars: 0,
      bytes: 0,
      items: 0,
      members: 0,
      count: 0,
    }

    survey.reach.set(path, reach)
    if (typeof value === 'string') {
      reach.kinds.add('string')
      reach.chars = Math.max(reach.chars, value.length)
      reach.bytes = Math.max(reach.bytes, utf8Bytes(value))
      for (const char of value) {
        survey.points.add(char.codePointAt(0)!)
      }
    } else if (typeof value === 'number') {
      reach.kinds.add('number')
      reach.count = Math.max(reach.count, value)
    } else if (Array.isArray(value)) {
      reach.kinds.add('array')
      reach.items = Math.max(reach.items, value.length)
      for (const item of value) {
        walk(`${path}/*`, item, survey)
      }
    } else if (value && typeof value === 'object') {
      const names = Object.getOwnPropertyNames(value)

      reach.kinds.add('object')
      reach.members = Math.max(reach.members, names.length)
      for (const name of names) {
        if (!root) {
          walk(`${path}/#`, name, survey)
        }
        walk(root ? name : `${path}/*`, (value as Record<string, unknown>)[name], survey)
      }
    }
  }

  let surveyed: Survey | undefined

  const survey = (): Survey => {
    if (surveyed) {
      return surveyed
    }
    const corpora = [
      ...repertoireCorpora(),
      ...Array.from({ length: SEARCH_CORPORA }, (_, seed) => render(searchShape(seed))),
      ...floodShapes().map(render),
      ...ceilingShapes().map(render),
    ]

    surveyed = { blobs: corpora.map(built), reach: new Map(), points: new Set() }
    for (const blob of surveyed.blobs) {
      walk('', blob, surveyed, true)
    }

    return surveyed
  }

  /** How far the search has to have pushed a dimension before the crossing above counts
   *  as evidence, read off the cap rather than chosen. A blob holds 4096 bytes and the
   *  smallest element any collection in it can hold costs four of them, so: a string, a
   *  list or a record that never came within a SIXTEENTH of the cap was not searched at
   *  the size the cap allows; and a counter, which counts the names that did NOT fit,
   *  has to pass the whole list the blob could have held instead — a quarter of the cap
   *  — or the search never showed it going anywhere a list could not. */
  const REACHED = FIELDS_BLOB_BYTE_CAP / 16
  const REACHED_COUNTER = FIELDS_BLOB_BYTE_CAP / 4

  it("declares exactly the members core's type carries", () => {
    expect(Object.keys(NoteFieldsWireSchema.shape).sort()).toEqual(Object.keys(members).sort())
  })

  it("declares exactly the members core's builder produces", () => {
    const produced = new Set(survey().blobs.flatMap((blob) => Object.keys(blob)))

    expect([...produced].sort()).toEqual(Object.keys(members).sort())
  })

  it('carries every blob the generated corpus produces across, losing nothing', () => {
    for (const [index, blob] of survey().blobs.entries()) {
      const parsed = NoteFieldsWireSchema.safeParse(blob)

      expect(parsed.success, `corpus ${index}: ${parsed.error?.issues[0]?.message}`).toBe(true)
      expect(parsed.success && parsed.data, `corpus ${index}`).toEqual(blob)
    }
  })

  it('searches a corpus that reaches every ceiling those blobs can express', () => {
    const short: string[] = []

    for (const [path, reach] of [...survey().reach].sort()) {
      // The root is the one place whose member set is not author data but the schema's
      // own, and the two tests above hold it to that set exactly.
      if (!path) {
        continue
      }
      if (reach.kinds.has('string') && Math.min(reach.chars, reach.bytes) < REACHED) {
        short.push(`${path} string ${Math.min(reach.chars, reach.bytes)} < ${REACHED}`)
      }
      if (reach.kinds.has('array') && reach.items < REACHED) {
        short.push(`${path} list ${reach.items} < ${REACHED}`)
      }
      if (reach.kinds.has('object') && reach.members < REACHED) {
        short.push(`${path} record ${reach.members} < ${REACHED}`)
      }
      if (reach.kinds.has('number') && reach.count < REACHED_COUNTER) {
        short.push(`${path} counter ${reach.count} < ${REACHED_COUNTER}`)
      }
    }

    expect(short).toEqual([])
  })

  it('puts every character it can draw into a blob that crosses', () => {
    const drawn = new Set([...ALPHABETS.flat()].map((char) => char.codePointAt(0)!))
    const missing = [...drawn].filter((point) => !survey().points.has(point))

    expect(
      missing.map((point) => `U+${point.toString(16).toUpperCase().padStart(4, '0')}`),
    ).toEqual([])
  })

  it('carries the whole shape back to core unchanged', () => {
    expect(NoteFieldsWireSchema.parse(whole)).toEqual(whole)
    expect(parseNoteFields(JSON.stringify(whole))).toEqual(whole)
    expect(serializeNoteFields(parseNoteFields(JSON.stringify(whole)))).toBe(JSON.stringify(whole))
  })

  // The rejected half — without it a schema that lost its shape entirely still passes
  // everything above. Closed world at the top level (author keys live one level down,
  // so an unknown MEMBER is drift, never data), and the empty list / zero counter the
  // builder omits by construction.
  //
  // Every mutation is asked of BOTH name lists and BOTH counters. Probing one member
  // per mutation is what let a bound sit on one side of a symmetric pair unnoticed:
  // the four optional members carry the same constraints, so a table that tests them
  // one each measures the table, not the schema.
  const nameLists = ['unreadable', 'truncated'] as const
  const counters = ['unreadableMore', 'truncatedMore'] as const

  const refused: ReadonlyArray<[what: string, value: unknown]> = [
    ['an unknown member', { ...whole, order: ['status'] }],
    ['no `keys` member at all', { unreadable: ['broken'] }],
    ['a value the projector never produces', { keys: { count: 1 } }],
    ['a list value holding a non-string', { keys: { reviewers: [1] } }],
    ...nameLists.flatMap((member): Array<[what: string, value: unknown]> => [
      [`\`${member}\` flattened to a scalar`, { ...whole, [member]: 'broken' }],
      [`\`${member}\` holding a non-string name`, { ...whole, [member]: [1] }],
      [`an empty \`${member}\``, { ...whole, [member]: [] }],
    ]),
    ...counters.flatMap((member): Array<[what: string, value: unknown]> => [
      [`\`${member}\` carried as a string`, { ...whole, [member]: '2' }],
      [`\`${member}\` carried as a fraction`, { ...whole, [member]: 1.5 }],
      [`a zero \`${member}\``, { ...whole, [member]: 0 }],
      [`a negative \`${member}\``, { ...whole, [member]: -1 }],
    ]),
  ]

  it.each(refused)('refuses %s', (_what, value) => {
    expect(NoteFieldsWireSchema.safeParse(value).success).toBe(false)
  })

  // The closed world has to SURVIVE derivation, because nothing on the wire reads this
  // schema bare: the note detail (V06) serves it plus `order`. `.extend()` keeps the
  // policy, `.merge()` takes it from its argument and quietly goes back to stripping —
  // so this builds the derived shape the way that vertical will and asks it to refuse.
  // `order` borrows the member that already spells "a list of key names" rather than a
  // fresh `z.array(z.string())`: the root has a different zod major hoisted, and a gate
  // that validated against the wrong one would be worse than none.
  it('keeps the closed world in the shape the note detail derives from it', () => {
    const detail = NoteFieldsWireSchema.extend({ order: NoteFieldsWireSchema.shape.unreadable })

    expect(detail.safeParse({ ...whole, order: ['status'] }).success).toBe(true)
    expect(detail.safeParse({ ...whole, order: ['status'], stray: 1 }).success).toBe(false)
  })

  // Open-world read maps must not turn an own `__proto__` into prototype mutation or
  // silently drop it. Write ingress rejects that key explicitly; an existing file is
  // still truth and every read surface must preserve the same own key core indexed.
  it('keeps an authored `__proto__` as an own key across core and wire', () => {
    const authored: unknown = JSON.parse('{"keys":{"__proto__":"secret","k":"v"}}')
    const parsed = NoteFieldsWireSchema.parse(authored).keys

    expect(Object.getOwnPropertyNames(parseNoteFields(JSON.stringify(authored)).keys)).toContain(
      '__proto__',
    )
    expect(Object.getOwnPropertyNames(parsed)).toContain('__proto__')
    expect(Object.getPrototypeOf(parsed)).toBeNull()
    expect(parsed.__proto__).toBe('secret')
  })
})

/**
 * The one blob string that lives in a THIRD package, and the only copy of it no
 * compiler ever sees: the engine's ladder step spells the `fields` column DEFAULT as
 * a SQL literal — a frozen step cannot import — and core's builder spells the same
 * blob for a note with no author keys. Row adoption compares column against builder
 * as a STRING, so a drift as small as one space stops matching every plain note in
 * the corpus and re-derives all of them on every poll, forever. The two sides cannot
 * import each other any more than core and contract can; this file is already where
 * package lines are crossed, so they meet here.
 */
describe('empty fields blob drift (the index DDL vs core)', () => {
  const columnDefault = (): string | undefined =>
    /ADD COLUMN fields TEXT NOT NULL DEFAULT '([^']*)'/.exec(
      INDEX_MIGRATIONS.map((step) => step.sql).join('\n'),
    )?.[1]

  it('spells the column default exactly as core builds a note with no author keys', () => {
    const spelled = columnDefault()

    expect(spelled, 'no ladder step adds the fields column').toBeDefined()
    // Both spellings of "no author keys": an empty block, and the one the real corpus
    // has — a block carrying only keys the note projects onto metadata of its own.
    expect(spelled).toBe(buildNoteFieldsBlob(parseFrontmatterLines('')))
    expect(spelled).toBe(buildNoteFieldsBlob(parseFrontmatterLines('title: Plain\ntags:\n- work')))
  })
})

/**
 * The same P8 seam, one level up from a const object: the ability locator is a
 * SHAPE both layers must agree on. `core` carries a hand-written structural
 * predicate because the SPA imports core at runtime and the wire schema would drag
 * zod into the bundle (the `no-restricted-imports` rule on `@notarium/contract`
 * states that boundary). Two independent readers of one shape is exactly the drift
 * P8 accepts — and exactly what this gate is here to make loud.
 */
describe('ability locator drift (P8)', () => {
  const spaceId = 'AbCdefGhij_1'
  const packageId = 'PkGdefGhij_2'
  const projectId = 'PrJdefGhij_3'

  const candidates: unknown[] = [
    { source: 'system', kind: 'role', packageId },
    { source: 'catalog', kind: 'skill', packageId },
    { source: 'owned', kind: 'role', packageId, location: { scope: 'personal', spaceId } },
    { source: 'owned', kind: 'skill', packageId, location: { scope: 'space', spaceId } },
    {
      source: 'owned',
      kind: 'role',
      packageId,
      location: { scope: 'project', spaceId, projectId },
    },
    // A skill has no project placement — the one asymmetry both readers encode.
    {
      source: 'owned',
      kind: 'skill',
      packageId,
      location: { scope: 'project', spaceId, projectId },
    },
    // Closed world on both levels: an unknown key is not a locator.
    { source: 'system', kind: 'role', packageId, extra: 1 },
    {
      source: 'owned',
      kind: 'role',
      packageId,
      location: { scope: 'personal', spaceId, extra: 1 },
    },
    // A project placement without its project, and a space placement carrying one.
    { source: 'owned', kind: 'role', packageId, location: { scope: 'project', spaceId } },
    { source: 'owned', kind: 'role', packageId, location: { scope: 'space', spaceId, projectId } },
    { source: 'owned', kind: 'role', packageId },
    { source: 'nowhere', kind: 'role', packageId },
    { source: 'system', kind: 'ability', packageId },
    { source: 'system', kind: 'role', packageId: '' },
    { source: 'system', kind: 'role', packageId: 'a'.repeat(129) },
    { source: 'system', kind: 'role', packageId: 'has space' },
    { source: 'owned', kind: 'role', packageId, location: { scope: 'personal', spaceId: '' } },
    { source: 'system', kind: 'role' },
    null,
    'system:role',
    [],
  ]

  it.each(candidates.map((value, index) => [index, value] as const))(
    'answers the same for candidate %i',
    (_index, value) => {
      expect(isAbilityLocator(value)).toBe(AbilityLocatorSchema.safeParse(value).success)
    },
  )
})

/**
 * The same P8 seam, for the two bounds an ATTACHMENT is carried under. Core reads a
 * hand-edited `SKILL.md` and the wire carries what it read, so a value core accepts
 * and the wire refuses is not a validation difference — it is a 500 on the detail door
 * for a package the host called valid. That is exactly what happened: the label inside
 * an attachment token was matched by charset alone, with no length, while the wire caps
 * a skill name at 64; and a token measured at 1024 characters produced a 1028-character
 * `raw`, four over the cap the wire carries an unrecognised token back under.
 */
describe('skill attachment bounds drift (P8)', () => {
  const names: string[] = [
    'research-evidence',
    'a',
    '1',
    'a'.repeat(64),
    'a'.repeat(65),
    'a'.repeat(200),
    '',
    '-leading',
    'trailing-',
    'double--dash',
    'Upper',
    'has space',
    'dot.name',
  ]

  it.each(names.map((value, index) => [index, value] as const))(
    'answers the same for name %i',
    (_index, value) => {
      // Asked of the wire the detail door actually validates against, not of the
      // field schema in isolation: `label` is where a package's name crosses.
      const carried = AuthoredAttachmentSchema.safeParse({
        kind: 'exact',
        locator: { source: 'system', kind: 'skill', packageId: 'PkGdefGhij_2' },
        label: value,
      }).success

      expect(isSkillName(value)).toBe(carried)
    },
  )

  /** Both axes of "what the parser can produce", because the first pass fixed one and
   *  the docblock then claimed both. A token the parser reads and the wire refuses is a
   *  500 on the detail door for a package the host called valid — and narrowing the
   *  parser to match instead deletes the author's token on the next rebuild. */
  const carried = (raw: string): boolean =>
    AuthoredAttachmentSchema.safeParse({ kind: 'invalid', raw, reason: 'invalid-locator' }).success

  it('carries every token core recognises, at the longest core will recognise', () => {
    const longest = `[[${'a'.repeat(MAX_SKILL_TOKEN - 4)}]]`

    expect(longest).toHaveLength(MAX_SKILL_TOKEN)
    expect(carried(longest)).toBe(true)
  })

  it('measures that length in the unit core measures it in', () => {
    // Core's quantifier is a `/u` regex, so it counts CODE POINTS. Counted in UTF-16
    // units instead, this token is 2 052 long and the wire refused it while the parser
    // went on reading it.
    const emoji = `[[${'\u{1F600}'.repeat(MAX_SKILL_TOKEN - 4)}]]`

    expect([...emoji]).toHaveLength(MAX_SKILL_TOKEN)
    expect(emoji.length).toBeGreaterThan(MAX_SKILL_TOKEN)
    expect(parseSkillLinks(emoji)).toHaveLength(1)
    expect(carried(emoji)).toBe(true)
  })

  it('carries the characters the parser does not stop at', () => {
    // The parser stops at `]`, CR and LF and at nothing else; the durable-scalar family
    // bans C0/C1, U+0085, U+2028 and U+2029. Everything in that gap is a token read from
    // a hand-edited file and then refused on the way out.
    for (const gap of ['\u0000', '\u0007', '\u001f', '\u007f', '\u0085', '\u2028', '\u2029']) {
      const raw = `[[notarium-id:system:_55UeQqGnMrH|ev${gap}idence]]`

      expect(parseSkillLinks(raw), `parser reads ${JSON.stringify(gap)}`).toEqual([
        { kind: 'invalid', raw, reason: 'invalid-locator' },
      ])
      expect(carried(raw), `wire carries ${JSON.stringify(gap)}`).toBe(true)
    }
  })

  it('still refuses what the parser cannot produce', () => {
    expect(carried('not a token')).toBe(false)
    expect(carried(`[[${'a'.repeat(MAX_SKILL_TOKEN - 3)}]]`)).toBe(false)
    expect(carried('[[]]')).toBe(false)
  })
})
