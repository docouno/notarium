import { describe, expect, it } from 'vitest'

import {
  buildNoteFields,
  buildNoteFieldsBlob,
  fieldFacet,
  FIELDS_BLOB_BYTE_CAP,
  parseFrontmatterLines,
} from '@notarium/core'
import { FIELD_SCHEMA_STATUS, parseFieldSchemaFile } from '@notarium/server'

import { buildCaseWorld } from './build'
import {
  EXACT_REVIEWER,
  PALETTE_OPTIONS,
  REVIEWERS,
  STATUS_OPTIONS,
  STATUSES,
} from './cases/fields'
import type { CaseEvent } from './types'

// The `fields` seed case (#384) exists to put every key state the index encodes on a
// stand, and THREE of them — a value the cap drops, a truncated name it drops, an
// unreadable name it drops — only exist while the note is bigger than
// `FIELDS_BLOB_BYTE_CAP`. Nothing used to hold that: the case sat on a 1.19–1.28×
// margin, so raising the cap to 6144 (the round number a memory pass reaches for)
// switched all three states off in silence, left the seeded stand a state poorer, and
// left the counts in the case comments and in docs/seeds.md asserting a split that no
// longer happened. This is the gate for that, and it deliberately catches BOTH
// authors: a case edited down under the cap, and a cap raised past the case.
//
// It derives the blob with the product's own builder from the frontmatter the case
// declares, which is the level the case owns; that the appliers then lay those bytes
// down is `seedRealProjection`/the fake-server catalog's job, not this file's.
// canon: docs/seeds.md

const world = buildCaseWorld('fields')
const seeded = world.events.filter(
  (e): e is Extract<CaseEvent, { op: 'create' }> => e.op === 'create',
)

const created = (path: string): Extract<CaseEvent, { op: 'create' }> => {
  const event = seeded.find((e) => e.path === path)

  if (!event) {
    throw new Error(`the fields case no longer seeds ${path}`)
  }

  return event
}

const fieldsOf = (event: Extract<CaseEvent, { op: 'create' }>) =>
  buildNoteFields(parseFrontmatterLines(event.frontmatter ?? ''))

const blobOf = (path: string) => fieldsOf(created(path))

/** What the index will make of one authored key ACROSS the case: the notes that carry
 *  it with a value, the (note, value) entries those notes contribute — the denominator
 *  design/00 gives the facet's selection rule — how many distinct values that is, and
 *  how many notes the least-carried of those values reaches. Every number is read off
 *  the seeded corpus through the product's own builder; none is restated. That is the
 *  point of the shape below: `reviewers`' distinct count is what `i % REVIEWERS.length`
 *  happens to produce on 20 notes, so a gate that pinned it would pin the arithmetic
 *  and say nothing about the population. */
type Population = {
  notes: number
  entries: number
  distinct: number
  /** Fewest notes any one of its values appears on. */
  rarestValue: number
  /** Fewest / most values on any one note carrying the key. */
  perNoteMin: number
  perNoteMax: number
}

const populationOf = (key: string): Population => {
  const carried = seeded
    .map((event) => fieldsOf(event).keys[key])
    .filter((value): value is string | string[] => value !== undefined)
    .map((value) => (Array.isArray(value) ? value : [value]))
  const notesPerValue = new Map<string, number>()

  for (const values of carried) {
    for (const value of new Set(values)) {
      notesPerValue.set(value, (notesPerValue.get(value) ?? 0) + 1)
    }
  }
  const sizes = carried.map((values) => values.length)

  return {
    notes: carried.length,
    entries: sizes.reduce((total, size) => total + size, 0),
    distinct: notesPerValue.size,
    rarestValue: Math.min(...notesPerValue.values()),
    perNoteMin: Math.min(...sizes),
    perNoteMax: Math.max(...sizes),
  }
}

describe('the fields seed case keeps every key state the index encodes (#384)', () => {
  it('declares the space schema that both seed appliers materialize', () => {
    const declaration = world.spaces.find((space) => space.slug === 'fields-lab')?.fieldSchema

    expect(declaration?.version).toBe(1)
    expect(declaration?.fields[0]).toMatchObject({
      key: 'status',
      type: 'enum',
      card: true,
      values: STATUS_OPTIONS,
    })
    expect(declaration?.fields.filter((field) => field.card)).toHaveLength(5)
    expect(declaration?.fields.find((field) => field.key === 'palette')?.values).toEqual(
      PALETTE_OPTIONS,
    )
    expect(declaration?.fields.find((field) => field.key === 'palette')?.card).toBe(true)
  })

  it('materializes the writer/read-only Meta seam on one shared field schema', () => {
    expect(world.auth?.members).toEqual(
      expect.arrayContaining([
        { space: 'fields-lab', username: 'sergey', role: 'owner' },
        { space: 'fields-lab', username: 'field-reader', role: 'reader' },
      ]),
    )
  })

  it('catalogizes future, recoverable-form and structural schema read modes', () => {
    const statusOf = (space: string) => {
      const raw = world.spaces.find((candidate) => candidate.slug === space)?.fieldSchemaRaw

      expect(raw).toBeTruthy()
      return parseFieldSchemaFile(raw!).status
    }

    expect(statusOf('fields-future')).toBe(FIELD_SCHEMA_STATUS.futureVersion)
    expect(statusOf('fields-form-error')).toBe(FIELD_SCHEMA_STATUS.formError)
    expect(statusOf('fields-structural-error')).toBe(FIELD_SCHEMA_STATUS.structuralError)
  })

  it('seeds a value the cap drops, keeping the name findable', () => {
    const blob = blobOf('states/oversized.md')

    expect(blob.truncated ?? []).toContain('blob')
    // The name is kept, so this note is the "value gone, name indexed" state and not
    // the harder one below it.
    expect(blob.truncatedMore ?? 0).toBe(0)
    expect(Object.keys(blob.keys)).toEqual(['keeper'])
  })

  it('seeds a note whose truncated NAMES outgrow the cap', () => {
    const event = created('states/names-lost.md')
    const blob = buildNoteFields(
      parseFrontmatterLines(`${event.frontmatter ?? ''}\ntype: ${event.noteType}`),
    )

    // Both halves, because either alone is a different state: some names are kept
    // (still answered by `fieldAny`) and the rest are only a number (answered by
    // nothing, shown by the sidebar off the file).
    expect(blob.truncated?.length ?? 0).toBeGreaterThan(0)
    expect(blob.truncatedMore ?? 0).toBeGreaterThan(0)
    expect(event.noteType).toBe('task')
    expect(blob.keys.type).toBeUndefined()
  })

  it('seeds a note whose unreadable NAMES outgrow the cap', () => {
    const blob = blobOf('states/unreadable-names-lost.md')

    expect(blob.unreadable?.length ?? 0).toBeGreaterThan(0)
    expect(blob.unreadableMore ?? 0).toBeGreaterThan(0)
  })

  // The three notes above are sized from the cap, so the case follows a retune instead
  // of dying to it. Pinning the RATIO rather than a key count is what makes that
  // checkable without re-stating a literal the next tuning pass would have to find.
  it.each([
    ['states/names-lost.md', 'truncated'],
    ['states/unreadable-names-lost.md', 'unreadable'],
  ])('sizes %s from the cap, not against it', (path, list) => {
    const frontmatter = created(path).frontmatter ?? ''
    const names = frontmatter
      .split('\n')
      .map((line) => line.slice(0, line.indexOf(':')))
      .filter(Boolean)
    const bytes = names.reduce((total, name) => total + name.length + 3, 0)

    // Twice the cap's worth of names — the margin the case declares. A count edited to
    // a literal, or a cap raised out from under one, lands here.
    //
    // At LEAST twice, not strictly more: the case buys whole keys, `ceil(2·cap / w)` of
    // them, so the bytes it ends up with are `2·cap` exactly whenever the key width `w`
    // divides it. `intake-question-001` is 22 bytes wide, so a strict `>` here reddened
    // on every cap that is a multiple of 11 — 4400 and 5500 among them — while the case
    // went on producing the state correctly. A gate that fails on a correct corpus sends
    // the next engineer to fix the corpus.
    expect(bytes, `${list} names in ${path}`).toBeGreaterThanOrEqual(2 * FIELDS_BLOB_BYTE_CAP)
  })

  // The remaining states carry no cap arithmetic, but they are the rest of the table
  // the case advertises, and a case is only a stand for what it still seeds.
  it('seeds the states that do not depend on the cap', () => {
    expect(blobOf('states/unreadable.md').unreadable).toEqual(['shape'])
    expect(blobOf('states/empty.md').keys.note).toBe('')
    // `view` is protected and indexed through dedicated NoteMeta.viewType; it must
    // not consume the capped authored-field column.
    expect(blobOf('states/reader-marker.md').keys.view).toBeUndefined()
    expect(blobOf('states/display-mismatch.md').keys).toMatchObject({
      'card-state': 'Unknown',
      priority: 'high',
      due: '2026-09-01T10:00:00Z',
      approved: 'true',
      client: '',
    })
    expect(created('states/display-mismatch.md').frontmatter).toContain('aliases:')
    expect(Object.keys(blobOf('states/colon-key.md').keys)).toContain('https://example')
    expect(blobOf('reviews/review-01.md').keys.reviewers).toContain(EXACT_REVIEWER)

    const typed = created('states/typed-protected.md')

    // The three protected keys the product writes through its TYPED arguments — the
    // case declares them that way on purpose (see the comment there), so they are not
    // in the frontmatter string and have to be read off the declaration.
    expect(typed.noteType).toBe('task')
    expect(typed.summary).toBeTruthy()
    expect(typed.muted).toBe(true)
  })
})

// The other half of what this case is a stand FOR. Criterion 7 of the brief states the
// facet's selection rule as three OBSERVATIONS rather than as a restatement of it — 3
// notes with 3 statuses put a key in the facet, 40 notes with a per-note unique
// `telegram_id` do not, `reviewers` over 20 notes does — and this case is where all
// three are seeded. Nothing held them: the states above were gated, the populations
// they sit beside were not, and `docs/seeds.md` advertised them by their numbers.
//
// The rule itself arrives with V02, so what can be gated today is the corpus it will be
// read off — and what is gated is the SHAPE of each population, derived from the seeded
// notes. Not the counts: `reviewers` shows as many distinct values as it does because
// of `i % REVIEWERS.length` over a 20-iteration loop, and pinning that number would pin
// an accident while a change to either input moved it in silence.
describe('the fields seed case keeps the populations the facet rule is read off (#384)', () => {
  it('seeds a board too small for any threshold, one value per note', () => {
    const status = populationOf('status')

    // Every declared status is on the board, and no two notes share one — so `distinct
    // < notes`, the rule as #301 first wrote it, throws this key away at ANY corpus
    // size. Only the size floor added in preparation admits it, which is what makes
    // this population and `telegram_id` below a pair rather than two examples.
    expect(status.notes).toBe(STATUSES.length)
    expect(status.perNoteMax).toBe(1)
    expect(status.distinct).toBe(status.notes)
    expect(status.rarestValue).toBe(1)
  })

  it('seeds the same shape an order of magnitude up, where the key identifies', () => {
    const status = populationOf('status')
    const telegram = populationOf('telegram_id')

    // Unique on every note it appears on: it identifies rather than groups, and a facet
    // built on it would be one chip per note.
    expect(telegram.perNoteMax).toBe(1)
    expect(telegram.distinct).toBe(telegram.notes)
    expect(telegram.rarestValue).toBe(1)
    // The two populations differ in NOTHING but size, and that is the whole content of
    // the pair: whatever floor the rule picks, it has to fall between them. An order of
    // magnitude of room says the case is not tuned to one particular threshold.
    expect(telegram.notes).toBeGreaterThan(10 * status.notes)
  })

  it('drives the product facet rule, not just the input population shapes', () => {
    const declarations = world.spaces.find((space) => space.slug === 'fields-lab')?.fieldSchema
      ?.fields
    const result = fieldFacet(seeded.map(fieldsOf), declarations ?? [])
    const keys = result.fields.map((field) => field.key)

    expect(keys).toContain('status')
    expect(keys).toContain('reviewers')
    expect(keys).not.toContain('telegram_id')
    expect(keys).not.toContain('view')
    expect(keys).not.toContain('https://example')
    expect(result.fields.find((field) => field.key === 'status')?.values).toEqual(
      STATUSES.map((value) => ({ value, count: 1 })),
    )

    const openWorld = fieldFacet(seeded.map(fieldsOf), [])
    expect(openWorld.fields.map((field) => field.key)).toContain('status')
  })

  it('seeds a list key with more distinct values than notes, none of them alone', () => {
    const reviewers = populationOf('reviewers')

    // Same number of values on every note carrying the key, and more than one: the key
    // contributes far more (note, value) entries than it has notes.
    expect(reviewers.perNoteMin).toBe(reviewers.perNoteMax)
    expect(reviewers.perNoteMin).toBeGreaterThan(1)
    // The contrast the population exists for. Its distinct values OUTNUMBER its notes,
    // so a rule reading `distinct < notes` drops the key; they are fewer than the
    // entries, and every one of them is on more than one note, so the corrected
    // denominator keeps it. Both halves are asserted, because either alone is a
    // different population: the first without the second is `telegram_id` with three
    // ids per note.
    expect(reviewers.distinct).toBeGreaterThan(reviewers.notes)
    expect(reviewers.distinct).toBeLessThan(reviewers.entries)
    expect(reviewers.rarestValue).toBeGreaterThan(1)
    // ...and the vocabulary the case DECLARES is the vocabulary the stand shows. This
    // is the one place a count appears, and it is a comparison between two derived
    // things — never a literal: a reviewer nobody drew, or a loop no longer long enough
    // to reach one, reddens here instead of quietly making `REVIEWERS.length` a lie.
    expect(reviewers.distinct).toBe(REVIEWERS.length + 1)
  })

  it('seeds notes the backfill adopts instead of re-deriving', () => {
    const columnDefault = buildNoteFieldsBlob([])
    const empty = seeded.filter(
      (event) =>
        buildNoteFieldsBlob(parseFrontmatterLines(event.frontmatter ?? '')) === columnDefault,
    )

    // A corpus where every note carries author keys makes `rowsRederived` equal
    // `filesRead` — and the counters are two numbers precisely because a row whose blob
    // already equals the column default is ADOPTED, without an upsert. Under
    // `FIELDS_BACKFILL_CASE=fields` that path once ran zero times across the corpus.
    // It is also the corpus a note without field plaques is read off, in V06.
    expect(empty.length).toBeGreaterThan(0)
    // Both populations, or the assertion above is satisfied by a case that seeds
    // nothing else.
    expect(empty.length).toBeLessThan(seeded.length)
    // And they are not all one shape: `journal/quarter-plan.md` HAS authored
    // frontmatter — tags, which the note projects onto metadata of its own — so "the
    // column carries nothing" cannot be read off "the file has no frontmatter" either.
    expect(empty.some((event) => (event.tags ?? []).length)).toBe(true)
    expect(empty.some((event) => !(event.tags ?? []).length)).toBe(true)
  })
})
