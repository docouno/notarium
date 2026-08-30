// The fields column's backfill onto an index that already exists: the ladder's one
// derivation-changing step. What makes it safe is the fingerprint wipe in the same
// transaction, and what makes it CHEAP is that the whole re-derivation happens inside
// ensureReady — before the read-model owns a cursor — so it publishes no delta, and
// therefore no revision, no re-embed and no preview churn.
//
// That last property is asserted on a REAL delta poll, never on the boot seed:
// `changes(null)` answers `upserts: []` as a literal (notariumStore.ts, the
// `Number.isNaN(since)` branch), so a boot-seed assertion holds under ANY backfill
// whatsoever — including one that storms the journal on the very next poll. What is
// being gated is ordering, so the gate states it both ways. With the earliest cursor a
// consumer can own — the boot seed's own, minted after ensureReady — the following poll
// is empty. With a cursor minted BEFORE the upgrade the same engine reports every
// re-derived row, because `seq` is a persisted column and the backfill does stamp it.
// The second half is what keeps the first from being vacuous, and it is unreachable in
// production for one reason worth naming: CachedStore's cursor is an in-memory field,
// so it dies with the process and a restart always re-seeds from `null`.
//
// The corpus is a knob. The shipped default covers all six key states design/00 makes
// the derivation keep apart, and `make checkup` pays milliseconds for it. The three the
// CAP produces are why it is not four notes any more: on a note whose values the cap
// dropped, `keys` is empty and the blob is still nothing like the column default, so
// "the note has author keys" and "the backfill re-derived it" are different populations
// — as are "the note has authored frontmatter" and the same thing, in the other
// direction, on a note whose every key is projected onto metadata of its own. Both
// readings were in this file and both were wrong; neither could be caught by a corpus
// that carried only the states four notes reach.
//
// The PRICE of a one-off re-derivation is measured by running the same gate over a
// seed-catalog case, which design/01 names as `fields-scale`:
//
//   FIELDS_BACKFILL_CASE=fields-scale npx vitest run test/integration/fieldsBackfill.test.ts
//   FIELDS_BACKFILL_CASE=fields-scale FIELDS_BACKFILL_SCALE=0.05 npx vitest run test/integration/fieldsBackfill.test.ts
//
// Those knobs are namespaced, and the bare `CASE`/`SCALE` the seed CLI and the snapshot
// bench (scripts/fieldsSnapshotBench.ts) take are IGNORED here. Not tidiness: those two
// are typed at the command that consumes them, while this file is swept up by
// `npm test`. A shell with `CASE=fields` exported — the ordinary state of a session that
// seeds a stand — silently moved this gate onto another corpus, under a different
// default besides (an empty `CASE` means `fields-scale` to the bench and the literal
// corpus here). Ignoring a bare knob is announced on the console, so the mistake does
// not simply invert into a measurement run that silently reads the default corpus.
//
// canon: docs/search.md#how-it-is-indexed-write-path

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildNoteFieldsBlob,
  CachedStore,
  claudeConversationSourceLocator,
  FIELDS_BLOB_BYTE_CAP,
  InMemoryRevisionPersistence,
  type NoteFields,
  parseFrontmatterLines,
  serializeNoteFields,
} from '@notarium/core'
import { createLocalFsFiles, engineMountOf, NotariumStore } from '@notarium/engine'

import { createNodeSqliteDriver } from '../../packages/engine/src/libs/sql'
import {
  INDEX_MIGRATIONS,
  INDEX_VERSION_KEY,
} from '../../packages/engine/src/services/notariumStore/schema'
import type { EngineMount } from '../../packages/engine/src/services/notariumStore/types'
import { itVector } from '../../packages/engine/src/services/notariumStore/vectorGate.fixture'
import { buildCaseWorld } from '../cases/build'

/** The published main ladder before the fields step, built by the product's own
 * write path rather than hand-seeded rows. The step is found by its DDL instead
 * of a stale version literal, so upstream additions before it join the baseline. */
const FIELDS_STEP = INDEX_MIGRATIONS.findIndex((step) => step.sql.includes('ADD COLUMN fields'))

if (FIELDS_STEP === -1) {
  throw new Error('fields index migration is missing')
}
const LADDER_WITHOUT_FIELDS = INDEX_MIGRATIONS.slice(0, FIELDS_STEP)

type CorpusNote = { title: string; frontmatter: string }

/** The three cap-driven notes are sized OFF the cap, never pinned to a count that
 *  happened to overflow it: this corpus exists to carry those states, and a literal
 *  that quietly slips under a raised ceiling drops them without failing anything.
 *
 *  A value no blob can hold — the cap gives VALUES up first, so this key survives as a
 *  bare name and its note carries nothing at all in `keys`. */
const OVERSIZED_VALUE = 'x'.repeat(FIELDS_BLOB_BYTE_CAP)
const metricKey = (i: number) => `daily-visits-${String(i).padStart(4, '0')}`
const blankKey = (i: number) => `intake-question-${String(i).padStart(4, '0')}`
/** Enough keys that even their NAMES do not fit — the state no smaller shape reaches.
 *  Each kept name costs its own length plus quotes and a separator, so a count past
 *  `cap / nameLength` overflows the list whatever the cap is. Mirrored on the
 *  unreadable list, whose names the cap gives up last of all. */
const DAILY_METRIC_KEYS = Math.ceil(FIELDS_BLOB_BYTE_CAP / metricKey(0).length) + 1
const BLANK_FORM_KEYS = Math.ceil(FIELDS_BLOB_BYTE_CAP / blankKey(0).length) + 1

const LITERAL_CORPUS: CorpusNote[] = [
  { title: 'Alpha', frontmatter: 'status: in progress\nsprint: 42' },
  { title: 'Beta', frontmatter: 'reviewers:\n- ann\n- bo' },
  { title: 'Gamma', frontmatter: 'broken:\n  nested: 1' },
  { title: 'Empty', frontmatter: "note: ''" },
  // No author keys at all: its blob equals the column default, so the backfill must
  // read it and then adopt it WITHOUT an upsert.
  { title: 'Plain', frontmatter: '' },
  // Authored frontmatter that the column deliberately does not carry — the note
  // projects it onto metadata of its own. Adopted without an upsert exactly like
  // `Plain`, which is why the population cannot be read off "has frontmatter" either.
  { title: 'Projected', frontmatter: 'slug: projected-only' },
  // The cap's three states. Each of these rows IS re-derived and each has an empty
  // `keys` — the shapes on which a "has author keys" reading of the snapshot
  // undercounts the backfill.
  { title: 'Capped', frontmatter: `blob: ${OVERSIZED_VALUE}` },
  {
    title: 'NamesLost',
    frontmatter: Array.from(
      { length: DAILY_METRIC_KEYS },
      (_, i) => `${metricKey(i)}: ${100 + i}`,
    ).join('\n'),
  },
  {
    title: 'BlanksLost',
    frontmatter: Array.from({ length: BLANK_FORM_KEYS }, (_, i) => `${blankKey(i)}:`).join('\n'),
  },
]

const CASE = process.env.FIELDS_BACKFILL_CASE
const SCALE = Number(process.env.FIELDS_BACKFILL_SCALE || 1)

if (!CASE && (process.env.CASE || process.env.SCALE)) {
  console.warn(
    '[fields-backfill] ignoring the bare CASE/SCALE in this environment — this gate reads' +
      ' FIELDS_BACKFILL_CASE / FIELDS_BACKFILL_SCALE. Running the literal corpus.',
  )
}

/** A catalog case, projected to the only two things this gate writes. Paths are the
 *  case's own concern; here the product's write path chooses them, exactly as it did
 *  for the index this test upgrades. */
const caseCorpus = (name: string, scale = SCALE): CorpusNote[] =>
  buildCaseWorld(name, { scale }).events.flatMap((event) =>
    event.op === 'create' ? [{ title: event.title, frontmatter: event.frontmatter ?? '' }] : [],
  )

const CORPUS = CASE ? caseCorpus(CASE) : LITERAL_CORPUS
/** Whether the case actually TOOK the scale. Several catalog cases are fixed-size and
 *  ignore it, and a run label reading `scale=0.5` beside a corpus that never moved reads
 *  as a measurement at half size — `case=fields scale=0.5 corpus=71` is the very same 71
 *  notes `scale=1` builds. Derived by building the case both ways and comparing the only
 *  thing this gate takes from one, its list of notes, rather than from a hand-kept list
 *  of which cases scale. Paid for only on a run that asked for a scale at all. */
const SCALE_TAKEN = !CASE || SCALE === 1 || CORPUS.length !== caseCorpus(CASE, 1).length
/** A catalog corpus goes in note by note through the product's write path; ten thousand
 *  of those is minutes, not the default's third of a second. */
const TIMEOUT_MS = CASE ? 45 * 60_000 : 10_000

/** The column default, taken off the shared builder rather than spelled again here.
 *  The ladder's frozen step does hardcode this string in its DDL, and `enumDrift`'s
 *  `empty fields blob drift` block is where those two are held equal — this file only
 *  needs the builder's side. */
const EMPTY_FIELDS_BLOB = buildNoteFieldsBlob([])

/** The population the backfill re-derives, stated on the INPUT corpus: a note whose
 *  derived blob differs from the column default. That is what `materializedRowMatches`
 *  compares and therefore exactly what `rowsRederived` counts — and it is NOT "the note
 *  has author keys", a reading these two agree with only by accident. They part company
 *  in both directions on a real corpus: a note whose every value the cap dropped has an
 *  empty `keys` and an empty `unreadable` yet a blob nothing like the default, and a
 *  note whose frontmatter is nothing but keys projected onto metadata of its own has
 *  authored frontmatter and the default blob. */
const REDERIVED = CORPUS.filter(
  (note) => buildNoteFieldsBlob(parseFrontmatterLines(note.frontmatter)) !== EMPTY_FIELDS_BLOB,
).length

if (CASE && !REDERIVED) {
  // Not a knob the shipped corpus can reach — it is checked in, and its whole point is
  // to carry all six key states. A CASE corpus can, and then every count keyed to
  // `REDERIVED` below reads `0 === 0`: the re-derivation half of this gate holds
  // vacuously and the measurement it exists to take is of file reads alone. Announced
  // rather than failed, for the same reason the bare-knob notice above is: the operator
  // chose the case, and the run still measures the read side honestly.
  console.warn(
    `[fields-backfill] case=${CASE} authors no key the fields column carries — every` +
      ' re-derivation count in this run is 0 === 0, and only the file reads are measured.',
  )
}

/** The same population seen from the snapshot rather than from the input — one
 *  predicate on both sides of every count below, so neither approximates the other. */
const rederived = (fields: NoteFields): boolean => serializeNoteFields(fields) !== EMPTY_FIELDS_BLOB

describe('the fields column backfills onto an existing index', () => {
  let notesDir: string
  let indexDb: string

  const userMount = (dir: string): EngineMount =>
    engineMountOf({ class: 'user-doc', prefix: '' }, createLocalFsFiles(dir))

  const seedPreFields = async (
    embedder?: ConstructorParameters<typeof NotariumStore>[0]['embedder'],
  ) => {
    const store = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: createNodeSqliteDriver(indexDb, { vec: Boolean(embedder) }),
      embedder,
      migrations: LADDER_WITHOUT_FIELDS,
    })

    for (const note of CORPUS) {
      await store.write({
        title: note.title,
        content: `body of ${note.title}`,
        ...(note.frontmatter ? { frontmatter: parseFrontmatterLines(note.frontmatter) } : {}),
      })
    }
    if (embedder) {
      await store.whenVectorsSettled()
    }

    return store
  }

  // The engine that performs the upgrade, and the only one in this file with the
  // rotating integrity sweep switched off — the other two (`seedPreFields` and the vector leg)
  // build a pre-fields index and re-embed, and neither reads `rescanStats()`. Off HERE because
  // the sweep re-reads a bounded batch on every rescan, which would fold into the very
  // counters the backfill is measured by.
  const openCurrent = () =>
    new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: createNodeSqliteDriver(indexDb),
      integritySweepBatchSize: 0,
    })

  const columnNames = async (db: ReturnType<typeof createNodeSqliteDriver>) =>
    (await db.all<{ name: string }>(`PRAGMA table_info(notes)`)).map((row) => row.name)

  const version = async (db: ReturnType<typeof createNodeSqliteDriver>) =>
    (await db.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [INDEX_VERSION_KEY]))
      ?.value

  beforeEach(() => {
    notesDir = mkdtempSync(join(tmpdir(), 'notarium-fields-notes-'))
    indexDb = join(mkdtempSync(join(tmpdir(), 'notarium-fields-db-')), 'index.db')
  })
  afterEach(() => {
    rmSync(notesDir, { recursive: true, force: true })
    // The index lives in its own mkdtemp dir, and a catalog-corpus run leaves a
    // ten-thousand-note database behind it — take both, not just the notes.
    rmSync(dirname(indexDb), { recursive: true, force: true })
  })

  it(
    'fills the column for the whole corpus without publishing a delta',
    async () => {
      const seeded = await seedPreFields()
      // The cut a consumer of the pre-fields index held. Nothing carries it across the restart
      // — it exists here only to prove, below, that the delta feed WOULD report this
      // work to a cursor that predates it.
      const preUpgrade = (await seeded.changes(null)).cursor
      const before = new Map(
        (await seeded.list()).map((note) => [
          note.filePath,
          readFileSync(join(notesDir, note.filePath), 'utf8'),
        ]),
      )

      // The last assertion in this test is a loop over `before`, and a loop over an
      // empty map is true of nothing — the same reason the counts below state their
      // length before their predicate.
      expect(before.size).toBe(CORPUS.length)
      await seeded.stop()

      let probe = createNodeSqliteDriver(indexDb)

      expect(await version(probe)).toBe(String(LADDER_WITHOUT_FIELDS.length))
      expect(await columnNames(probe)).not.toContain('fields')
      const hashesBefore = await probe.all<{ path: string; content_hash: string }>(
        `SELECT path, content_hash FROM notes ORDER BY path`,
      )
      await probe.close()

      const upgradeStartedAt = Date.now()
      const store = openCurrent()
      // Everything the step costs is inside this call: apply the ladder, wipe the
      // fingerprints, re-read the corpus, re-derive what moved, then project the seed.
      const seed = await store.changes(null)
      const upgradeMs = Date.now() - upgradeStartedAt

      expect(seed.inventory).toHaveLength(CORPUS.length)
      // The re-derivation ran inside ensureReady, so the read-model's first REAL cut —
      // taken with the seed's own cursor, the earliest one a consumer ever owns — finds
      // nothing to journal, no preview to invalidate, no edge to patch. Asserting this
      // on `seed.upserts` instead would prove nothing: that branch returns the literal.
      const quiet = await store.changes(seed.cursor)

      expect(quiet.upserts).toEqual([])
      // ...and it really was the delta branch that answered: it parks the sentinel in
      // `fields` for every row it did not re-send, which the boot seed never does. The
      // length is asserted first and is not ceremony: `every` and `toEqual([])` are both
      // true of an empty inventory, so a regression that returned one would read as a
      // clean poll here and as "delete the whole corpus" to applyDelta.
      expect(quiet.inventory).toHaveLength(CORPUS.length)
      expect(quiet.inventory.every((note) => note.fields === undefined)).toBe(true)
      // The counterweight. The engine has not forgotten the work — a cursor minted
      // before the upgrade sees every re-derived row, because the backfill stamps `seq`
      // and `seq` is a persisted column. So the emptiness above is a statement about
      // WHEN the work lands relative to the cursor, not about the feed staying silent.
      expect((await store.changes(preUpgrade)).upserts).toHaveLength(REDERIVED)

      // Every row carries a decoded blob, and exactly the re-derived ones carry a blob
      // that differs from the column default.
      expect(seed.inventory.every((note) => note.fields != null)).toBe(true)
      expect(seed.inventory.filter((note) => rederived(note.fields!))).toHaveLength(REDERIVED)
      if (!CASE) {
        const byTitle = new Map(seed.inventory.map((note) => [note.title, note]))

        expect(byTitle.get('Alpha')!.fields!.keys).toEqual({ status: 'in progress', sprint: '42' })
        expect(byTitle.get('Beta')!.fields!.keys).toEqual({ reviewers: ['ann', 'bo'] })
        expect(byTitle.get('Gamma')!.fields!.unreadable).toEqual(['broken'])
        expect(byTitle.get('Empty')!.fields!.keys).toEqual({ note: '' })
        expect(byTitle.get('Plain')!.fields!.keys).toEqual({})
        // The other direction of the same point, and this corpus's only carrier of it:
        // authored frontmatter whose every key the note projects onto metadata of its
        // own. Adopted with no upsert exactly like `Plain`, which is what makes "has
        // authored frontmatter" the wrong reading of the population. Spelled as the
        // whole blob rather than as `keys`, because that string is what
        // `materializedRowMatches` compares and therefore what decides adoption.
        expect(serializeNoteFields(byTitle.get('Projected')!.fields!)).toBe(EMPTY_FIELDS_BLOB)
        // The three cap states, spelled out because they are the ones the population
        // predicate is wrong about when it reads `keys`: all three have none.
        expect(byTitle.get('Capped')!.fields).toEqual({ keys: {}, truncated: ['blob'] })
        const namesLost = byTitle.get('NamesLost')!.fields!

        expect(namesLost.keys).toEqual({})
        expect(namesLost.truncated!.length).toBeGreaterThan(0)
        expect(namesLost.truncatedMore).toBeGreaterThan(0)
        const blanksLost = byTitle.get('BlanksLost')!.fields!

        expect(blanksLost.keys).toEqual({})
        expect(blanksLost.unreadable!.length).toBeGreaterThan(0)
        expect(blanksLost.unreadableMore).toBeGreaterThan(0)
      }

      // Every file was source-verified (the step cleared the fingerprints), but only the
      // ones whose projection actually moved were rewritten. Three polls have run by
      // now; the counters staying at one read per file is also how we know a settled
      // index does not re-read itself on every poll.
      expect(store.rescanStats()).toEqual({ filesRead: CORPUS.length, rowsRederived: REDERIVED })
      if (CASE) {
        // The numbers design/01 sends to `recap`. Printed only on a measurement run:
        // on the four-note default they are noise in every `make checkup`.
        console.log(
          `[fields-backfill] case=${CASE} scale=${SCALE}${
            SCALE_TAKEN ? '' : ' (this case ignores it)'
          } corpus=${CORPUS.length} upgrade=${upgradeMs}ms`,
          store.rescanStats(),
        )
      }
      await store.stop()

      probe = createNodeSqliteDriver(indexDb)

      expect(await version(probe)).toBe(String(INDEX_MIGRATIONS.length))
      expect(await columnNames(probe)).toContain('fields')
      // The embedding arbiter is derived from title+body, which the backfill never
      // touches — so a re-derivation cannot become a re-embed.
      expect(
        await probe.all<{ path: string; content_hash: string }>(
          `SELECT path, content_hash FROM notes ORDER BY path`,
        ),
      ).toEqual(hashesBefore)
      await probe.close()

      // P1: the files are the base. A derived-index migration writes nothing to disk.
      for (const [path, bytes] of before) {
        expect(readFileSync(join(notesDir, path), 'utf8')).toBe(bytes)
      }
    },
    TIMEOUT_MS,
  )

  it('materializes every canonical legacy source locator, independent of custom fields', async () => {
    const withFields = claudeConversationSourceLocator('fields-backfill-with-fields')!
    const plain = claudeConversationSourceLocator('fields-backfill-plain')!
    const legacy = new NotariumStore({
      mounts: [userMount(notesDir)],
      sql: createNodeSqliteDriver(indexDb),
      migrations: LADDER_WITHOUT_FIELDS,
    })

    await legacy.write({
      title: 'With fields',
      content: 'body',
      sourceLocator: withFields,
      frontmatter: parseFrontmatterLines('status: doing'),
    })
    await legacy.write({ title: 'Plain source', content: 'body', sourceLocator: plain })
    await legacy.stop()

    const before = createNodeSqliteDriver(indexDb)
    await before.run(`UPDATE notes SET source_locator = NULL`)
    await before.close()

    const upgraded = openCurrent()
    const byTitle = new Map((await upgraded.list()).map((note) => [note.title, note]))

    expect(byTitle.get('With fields')?.sourceLocator).toBe(withFields)
    expect(byTitle.get('Plain source')?.sourceLocator).toBe(plain)
    await upgraded.stop()
  })

  it(
    'journals no revision for the notes it re-derives',
    async () => {
      const persistence = new InMemoryRevisionPersistence()
      const first = new CachedStore({
        inner: new NotariumStore({
          mounts: [userMount(notesDir)],
          sql: createNodeSqliteDriver(indexDb),
          migrations: LADDER_WITHOUT_FIELDS,
        }),
        revisionPersistence: persistence,
        space: 'main',
        pollIntervalMs: 0,
      })

      await first.start()
      for (const note of CORPUS) {
        await first.write({
          title: note.title,
          content: `body of ${note.title}`,
          ...(note.frontmatter ? { frontmatter: parseFrontmatterLines(note.frontmatter) } : {}),
        })
      }
      const seeded = await first.list()

      // Every count below is a comparison against `before`, and `before` is one row per
      // note in `seeded` — an empty `seeded` would make the whole test true of nothing.
      expect(seeded).toHaveLength(CORPUS.length)
      const counted = async (store: CachedStore) => {
        const rows: Array<[string, number]> = []

        for (const note of seeded) {
          rows.push([note.title, (await store.revisions(note.id!, { offset: 0, limit: 50 })).total])
        }

        return rows
      }
      const before = await counted(first)

      expect(before.every(([, total]) => total > 0)).toBe(true)
      first.stop()
      await first.settle()

      const second = new CachedStore({
        inner: openCurrent(),
        revisionPersistence: persistence,
        space: 'main',
        pollIntervalMs: 0,
      })

      await second.start()
      expect(await counted(second)).toEqual(before)
      // Criterion 11 is about the journal, and the journal is fed by a POLL, not by the
      // boot seed — the seed carries no upserts by construction. So take the first real
      // cut, with the cursor boot just minted, and let it reconcile all the way through
      // applyDelta before counting again. Note what this does and does not prove: the
      // journal has a SECOND guard behind the ordering one, because applyDelta records
      // an external observation by content identity, so even a delta echoing every row
      // back writes no revision when the bytes did not move. The ordering half is gated
      // one test up, on the delta itself; this one gates the chain that ends in history.
      await second.reconcile()
      expect(await counted(second)).toEqual(before)
      // The axis is live on the read-model's own snapshot, not only in the engine row —
      // and it survives a poll that re-sent nothing, because the sentinel makes the
      // previous value carry forward instead of being read as an emptied blob.
      const carrying = (await second.list()).filter((note) => rederived(note.fields!))

      expect(carrying).toHaveLength(REDERIVED)
      if (!CASE) {
        expect((await second.list()).find((n) => n.title === 'Alpha')!.fields!.keys).toEqual({
          status: 'in progress',
          sprint: '42',
        })
      }
      second.stop()
      await second.settle()
    },
    TIMEOUT_MS,
  )

  itVector(
    're-derives the corpus without re-embedding a single note',
    async () => {
      let embedded = 0
      const embedder = {
        id: 'fields-backfill@v1',
        dimensions: 8,
        embed: async (texts: readonly string[]) => {
          embedded += texts.length
          return texts.map(() => {
            const vector = new Float32Array(8)

            vector[0] = 1
            return vector
          })
        },
      }
      const seeded = await seedPreFields(embedder)

      await seeded.stop()
      const seededEmbeds = embedded

      expect(seededEmbeds).toBeGreaterThan(0)
      const probe = createNodeSqliteDriver(indexDb, { vec: true })
      const sentinels = await probe.all<{ path: string; embedded_hash: string }>(
        `SELECT path, embedded_hash FROM notes ORDER BY path`,
      )

      await probe.close()

      const store = new NotariumStore({
        mounts: [userMount(notesDir)],
        sql: createNodeSqliteDriver(indexDb, { vec: true }),
        embedder,
      })

      await store.list()
      await store.whenVectorsSettled()
      expect(embedded).toBe(seededEmbeds)
      await store.stop()

      const after = createNodeSqliteDriver(indexDb, { vec: true })

      expect(
        await after.all<{ path: string; embedded_hash: string }>(
          `SELECT path, embedded_hash FROM notes ORDER BY path`,
        ),
      ).toEqual(sentinels)
      await after.close()
    },
    TIMEOUT_MS,
  )
})
