/**
 * The lock order, OBSERVED — the half of the mechanism that watches what each
 * transaction really does against a live Postgres.
 *
 * WHY this shape. A gate that recognizes locks by reading SQL has to understand
 * intent in arbitrary text, and two review rounds went to showing it cannot: 21
 * tiered lock statements in 15 shapes, two of them assembled by interpolation and
 * carrying no text at all. So the surface is made finite first (ESLint keeps every
 * tiered lock inside `lockOrder`/`revisionLocks`) and only then observed: the level
 * of a lock is the HELPER that took it, the level of a mutation is its TARGET table,
 * and the keys a transaction holds come from the helper's own return value.
 *
 * What it checks, per transaction (the rules are stated in `lockOrder`):
 *   1. the levels it takes are a subsequence of what it registered — which, since a
 *      registered sequence is checked for monotonicity in the portable test, is
 *      monotonicity plus "nothing unregistered";
 *   2. it enters each level ONCE (the wide-scan mutex holder excepted, inside tier 3
 *      only — the mutex IS its order there);
 *   3. every later statement of a level stays inside the keys that entry declared;
 *   4. keys that did not exist at the entry are created in sorted order;
 *   5. `context_order` is never written without the per-scope advisory lock — the one
 *      rule about the PRESENCE of a lock rather than its order.
 *
 * And it runs every pooled transaction in the register, so "nobody exercised that
 * one" cannot pass for "that one is fine". Six of them never ran against Postgres in
 * this suite before; they need only scalar fixtures.
 */
import pg from 'pg'
import { expect, vi } from 'vitest'

import type { IdentityRecord, RevisionInput } from '@notarium/core'

import {
  LOCK_LEVEL_OF_TABLE,
  LOCK_LEVEL_REQUIRES,
  type LOCK_LEVELS,
} from '../../packages/server/src/services/metaDb/drivers/pg/lockOrder'
import { pooledPgTransactions } from './pgTransactions'
import { createPostgresTestSchema, describePostgres } from './postgresHarness'

/** The recorder lives in `vi.hoisted` because the mock factories below are evaluated
 *  before this module's own body runs. */
const observer = vi.hoisted(() => {
  type LockHold = {
    level: string
    scope: 'keys' | 'range'
    declared: readonly string[]
    held: readonly string[]
  }
  type Event =
    | { kind: 'begin'; client: unknown }
    | { kind: 'end'; client: unknown }
    | { kind: 'statement'; client: unknown; text: string; values: readonly unknown[] }
    | { kind: 'lock'; client: unknown; helper: string; hold: LockHold }

  const events: Event[] = []

  return {
    events,
    /** Wrap every `lock*` export so a level entry announces itself with its keys. */
    wrap: (module: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(module).map(([name, value]) => [
          name,
          typeof value === 'function' && name.startsWith('lock')
            ? async (...args: unknown[]) => {
                const result = (await (value as (...a: unknown[]) => Promise<unknown>)(...args)) as
                  { lock?: LockHold } | undefined

                if (result?.lock) {
                  events.push({ kind: 'lock', client: args[0], helper: name, hold: result.lock })
                }

                return result
              }
            : value,
        ]),
      ),
    record: (client: unknown, args: readonly unknown[]): void => {
      const first = args[0]
      const text =
        typeof first === 'string'
          ? first
          : typeof (first as { text?: unknown })?.text === 'string'
            ? (first as { text: string }).text
            : null

      if (text == null) {
        return
      }
      const trimmed = text.trim()

      if (/^BEGIN\b/i.test(trimmed)) {
        events.push({ kind: 'begin', client })
      } else if (/^(COMMIT|ROLLBACK)\b/i.test(trimmed)) {
        events.push({ kind: 'end', client })
      } else {
        events.push({
          kind: 'statement',
          client,
          text: trimmed,
          values: Array.isArray(args[1]) ? (args[1] as unknown[]) : [],
        })
      }
    },
  }
})

vi.mock('../../packages/server/src/services/metaDb/drivers/pg/lockOrder', async (importOriginal) =>
  observer.wrap(await importOriginal<Record<string, unknown>>()),
)
vi.mock(
  '../../packages/server/src/services/metaDb/drivers/pg/revisionLocks',
  async (importOriginal) => observer.wrap(await importOriginal<Record<string, unknown>>()),
)

type Level = (typeof LOCK_LEVELS)[number]

/** The table a statement MUTATES — its target, not every name it mentions. */
const mutatedTable = (text: string): string | null =>
  /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+"?([a-z_][a-z0-9_]*)"?/i.exec(text)?.[1] ?? null

/** Strings a statement passes as parameters, arrays flattened — the only key material
 *  available without parsing SQL, and enough to say which declared keys it touches. */
const parameterStrings = (values: readonly unknown[]): string[] =>
  values.flatMap((value) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : typeof value === 'string'
        ? [value]
        : [],
  )

/** A composite key (`kind:id`) is declared as one string but reaches SQL as its
 *  parts, so both spellings count as naming it. */
const keyForms = (keys: readonly string[]): Set<string> =>
  new Set(keys.flatMap((key) => [key, ...key.split(':')]))

type Step = {
  level: Level
  source: 'lock' | 'dml'
  helper?: string
  text?: string
  keys: string[]
}

type Transaction = {
  steps: Step[]
  holds: Map<Level, { declared: string[]; absent: string[]; scope: string }>
}

/** Split the recorded events into transactions, keyed by backend: a pool reuses its
 *  clients, and `ROLLBACK` is an ordinary outcome in four facets, so the boundary is
 *  `BEGIN` … `(COMMIT|ROLLBACK)` rather than "one client, one transaction". */
const transactionsIn = (events: readonly (typeof observer.events)[number][]): Transaction[] => {
  const open = new Map<unknown, Transaction>()
  const done: Transaction[] = []

  for (const event of events) {
    if (event.kind === 'begin') {
      open.set(event.client, { steps: [], holds: new Map() })
      continue
    }
    const current = open.get(event.client)

    if (!current) {
      continue
    }
    if (event.kind === 'end') {
      open.delete(event.client)
      done.push(current)
      continue
    }
    if (event.kind === 'lock') {
      const level = event.hold.level as Level
      const declared = [...event.hold.declared]
      const held = new Set(event.hold.held)

      current.holds.set(level, {
        declared,
        absent: declared.filter((key) => !held.has(key)),
        scope: event.hold.scope,
      })
      current.steps.push({ level, source: 'lock', helper: event.helper, keys: declared })
      continue
    }
    const table = mutatedTable(event.text)
    const level = table ? (LOCK_LEVEL_OF_TABLE[table] as Level | undefined) : undefined

    if (!level) {
      continue
    }
    current.steps.push({
      level,
      source: 'dml',
      text: event.text,
      keys: parameterStrings(event.values),
    })
  }

  return done
}

const collapse = (levels: readonly Level[]): Level[] =>
  levels.filter((level, index) => level !== levels[index - 1])

const isSubsequence = (observed: readonly Level[], declared: readonly Level[]): boolean => {
  let cursor = 0

  for (const level of observed) {
    const found = declared.indexOf(level, cursor)

    if (found < 0) {
      return false
    }
    cursor = found + 1
  }

  return true
}

const violationsOf = (id: string, transaction: Transaction): string[] => {
  const registered = pooledPgTransactions().find((entry) => entry.id === id)

  if (!registered) {
    return [`${id} is not in the register`]
  }
  const problems: string[] = []
  const observed = collapse(transaction.steps.map((step) => step.level))

  if (!isSubsequence(observed, registered.levels)) {
    problems.push(`${id} took ${observed.join(' → ')}, registered ${registered.levels.join(' → ')}`)
  }
  // One entry per level. A wide-scan holder is excused INSIDE tier 3 — its closure
  // and its blob set are discovered from rows it already holds, which is exactly why
  // it takes the mutex.
  const entries = new Map<Level, number>()

  for (const entry of transaction.steps.filter((step) => step.source === 'lock')) {
    entries.set(entry.level, (entries.get(entry.level) ?? 0) + 1)
  }
  for (const [level, count] of entries) {
    const excused = registered.exempt === 'wide-scan' && level.startsWith('L3')

    if (count > 1 && !excused) {
      problems.push(`${id} entered ${level} ${count} times`)
    }
  }
  for (const [index, step] of transaction.steps.entries()) {
    const requires = LOCK_LEVEL_REQUIRES[step.level] as Level | undefined

    if (
      step.source === 'dml' &&
      requires &&
      !transaction.steps
        .slice(0, index)
        .some((earlier) => earlier.source === 'lock' && earlier.level === requires)
    ) {
      problems.push(`${id} wrote at ${step.level} without entering ${requires}: ${step.text}`)
    }
    const hold = transaction.holds.get(step.level)

    if (step.source !== 'dml' || !hold || hold.scope !== 'keys' || !hold.declared.length) {
      continue
    }
    const declared = keyForms(hold.declared)

    if (!step.keys.some((key) => declared.has(key))) {
      problems.push(`${id} wrote at ${step.level} outside its declared keys: ${step.text}`)
    }
  }
  // Keys the entry could not hold, because they had no row yet, are ACQUIRED in
  // sorted order — the one ordering a row lock cannot give. Acquisition is the FIRST
  // touch: a later write to a key this transaction already created is a row it holds,
  // and no ordering rule reaches it. (Measuring every touch instead flagged the
  // settlement, whose retire legitimately revisits the key it created first.)
  for (const [level, hold] of transaction.holds) {
    if (!hold.absent.length) {
      continue
    }
    const absent = new Set(hold.absent)
    const acquired: string[] = []

    for (const step of transaction.steps) {
      if (step.level !== level || step.source !== 'dml') {
        continue
      }
      for (const key of step.keys) {
        if (absent.has(key) && !acquired.includes(key)) {
          acquired.push(key)
        }
      }
    }
    if (acquired.some((key, index) => index > 0 && key < acquired[index - 1])) {
      problems.push(`${id} created absent keys out of order at ${level}: ${acquired.join(', ')}`)
    }
  }

  return problems
}

const AT = '2026-08-11T10:00:00.000Z'

const identity = (over: Partial<IdentityRecord> & { id: string }): IdentityRecord => ({
  filePath: `${over.id}.md`,
  space: 'alpha',
  createdAt: AT,
  materialized: true,
  deletedAt: null,
  ...over,
})

const revision = (noteId: string, over: Partial<RevisionInput> = {}): RevisionInput => ({
  noteId,
  space: 'alpha',
  baseRevisionId: null,
  theirRevisionId: null,
  sourceRevisionId: null,
  kind: 'write',
  entryRole: 'origin',
  principal: 'ui',
  contentHash: `${noteId}-hash`,
  title: noteId,
  class: 'user-doc',
  slug: null,
  tags: [],
  createdAt: AT,
  charsAdded: 1,
  charsRemoved: 0,
  ...over,
})

describePostgres('Postgres lock order', () => {
  it('takes the levels every registered transaction declared, and every transaction runs', async () => {
    // Not `pg_…`: Postgres reserves that prefix for system schemas.
    const testSchema = await createPostgresTestSchema('lock_order')
    const db = testSchema.db
    const connect = pg.Pool.prototype.connect
    const seen = new Set<string>()
    const problems: string[] = []

    // pg's `query` and `connect` are five-way overloads; the wrappers only forward, so
    // they are typed as plain passthroughs and cast back at the assignment.
    type Passthrough = (...args: unknown[]) => unknown

    const instrument = (client: pg.PoolClient): pg.PoolClient => {
      const marked = client as pg.PoolClient & { __observed?: true }

      if (marked.__observed) {
        return marked
      }
      marked.__observed = true
      const query = client.query.bind(client) as Passthrough

      marked.query = ((...args: unknown[]) => {
        observer.record(client, args)

        return query(...args)
      }) as unknown as pg.PoolClient['query']

      return marked
    }
    // The callback form is not optional: `pool.query()` — half of this driver — calls
    // `connect(cb)` internally.
    const original = connect as Passthrough

    pg.Pool.prototype.connect = function (this: pg.Pool, callback?: unknown): unknown {
      if (typeof callback === 'function') {
        return original.call(
          this,
          (err: Error | undefined, client: pg.PoolClient, release: unknown) =>
            (callback as Passthrough)(err, err ? client : instrument(client), release),
        )
      }

      return (original.call(this) as Promise<pg.PoolClient>).then(instrument)
    } as typeof pg.Pool.prototype.connect

    /** Run one registered transaction and judge only what it did. */
    const run = async (id: string, action: () => Promise<unknown>): Promise<Level[]> => {
      const from = observer.events.length

      await action()
      const observed = transactionsIn(observer.events.slice(from))

      // Exactly one: every registered method opens a single transaction, and a
      // fixture built inside the window would otherwise be judged as this one.
      expect(observed.length, `${id} did not open exactly one transaction`).toBe(1)
      seen.add(id)
      for (const transaction of observed) {
        problems.push(...violationsOf(id, transaction))
      }

      return [
        ...new Set(observed.flatMap((transaction) => transaction.steps.map((step) => step.level))),
      ]
    }

    try {
      await db.spaces.upsert({
        id: 'alpha',
        slug: 'alpha',
        notesDir: '/alpha',
        displayName: 'Alpha',
        aliases: [],
        createdAt: AT,
        archivedAt: null,
        archivedBy: null,
      })
      await db.folders.upsert({
        id: 'folder-alpha',
        space: 'alpha',
        path: 'notes',
        pathAliases: [],
        lastSeen: AT,
        createdAt: AT,
      })
      await db.projects.upsert({
        id: 'project-alpha',
        space: 'alpha',
        path: '',
        slug: 'alpha-project',
        aliases: [],
        pathAliases: [],
        displayName: 'Alpha project',
        status: 'active',
        lastSeen: AT,
        createdAt: AT,
      })

      // ── outside the hierarchy, but still transactions ──────────────────────
      await run('auth.createFirstUser', () =>
        db.auth.createFirstUser({
          username: 'al',
          displayName: 'Al',
          passwordHash: 'hash',
          admin: true,
          disabledAt: null,
          createdAt: AT,
          personalSpace: null,
        }),
      )
      await run('pgMetaDb.grantMemberToActiveSpace', () =>
        db.grantMemberToActiveSpace('alpha', 'al', 'writer', AT),
      )
      await run('sessions.startNamed', () =>
        db.sessions.startNamed(
          {
            id: 'session-1',
            owner: 'user:al',
            name: 'work',
            named: true,
            parentId: null,
            createdAt: AT,
            lastSeenAt: AT,
            calls: 1,
            role: null,
          },
          AT,
          AT,
          10,
        ),
      )
      await run('sessions.setRole', () => db.sessions.setRole('user:al', 'session-1', 'role-a'))
      await run('agentDeltaCursors.advance', () =>
        db.agentDeltaCursors.advance(
          { owner: 'user:al', session: { id: 'session-1', parentId: null } },
          'project-alpha',
          '1',
          AT,
        ),
      )
      await run('oauth.upsertPendingClient', () =>
        db.oauth.upsertPendingClient(
          {
            clientId: 'client-1',
            kind: 'dcr',
            clientName: 'Client',
            redirectUris: ['https://example.test/cb'],
            createdAt: AT,
            lastSeen: AT,
            activatedAt: null,
          },
          10,
          AT,
        ),
      )

      // ── the identity tier and the facets under it ──────────────────────────
      await run('identity.claimMany', () =>
        db.identity.claimMany([identity({ id: 'note-b' }), identity({ id: 'note-a' })]),
      )
      await run('favorites.add', () =>
        db.favorites.add({
          owner: 'user:al',
          space: 'alpha',
          kind: 'note',
          entityId: 'note-a',
          createdAt: AT,
          rank: null,
        }),
      )
      await run('favorites.removeByEntity', () =>
        db.favorites.removeByEntity('user:al', 'alpha', 'note-b'),
      )
      await run('contextSets.addItem', async () => {
        await db.contextSets.createSet({
          id: 'set-1',
          homeSpace: 'alpha',
          name: 'Set',
          items: [],
          createdAt: AT,
        })

        return db.contextSets.addItem('set-1', { space: 'alpha', noteId: 'note-a' })
      })
      await run('contextSets.reorderItems', () => db.contextSets.reorderItems('set-1', ['note-a']))
      await run('contextSets.removeItem', () => db.contextSets.removeItem('set-1', 'note-a'))
      await run('scopePins.addPin', () =>
        db.scopePins.addPin({
          targetKind: 'project',
          targetId: 'project-alpha',
          targetSpace: 'alpha',
          noteSpace: 'alpha',
          noteId: 'note-a',
          createdAt: AT,
        }),
      )
      await run('contextOrder.setOrder', () =>
        db.contextOrder.setOrder('project', 'project-alpha', 'alpha', [
          { entryKind: 'set', entryRef: 'set-1' },
          { entryKind: 'pin', entryRef: 'note-a' },
        ]),
      )

      await run('contextSets.deleteSet', () => db.contextSets.deleteSet('set-1'))

      // ── revisions ──────────────────────────────────────────────────────────
      await run('revisions.append', () => db.revisions.append(revision('note-a'), 'body'))
      // Over a note that HAS revisions and a blob — the fixture is built OUTSIDE the
      // window, because everything inside one is judged as the transaction it labels.
      await db.revisions.append(revision('note-purged', { contentHash: 'purged-hash' }), 'gone')
      await run('revisions.purgeNotes', () => db.revisions.purgeNotes('alpha', ['note-purged']))

      // The target of the re-key gets its own row first: then the settlement has TWO
      // chains to merge, which is what makes it demote a later origin — and that write
      // lands on a row the contamination closure never contained.
      await db.revisions.append(revision('note-observed', { contentHash: 'observed-hash' }), 'own')

      // A settlement that actually reaches every level below identity: the claimant
      // owns a favourite, a pin with an order overlay, and history.
      const settlement = await run('identity.settleFileClaim', () =>
        db.identity.settleFileClaim({
          space: 'alpha',
          filePath: 'note-a.md',
          current: identity({ id: 'note-a' }),
          observedId: 'note-observed',
          at: AT,
        }),
      )
      // The same transaction again, with BOTH identity rows absent and the pair
      // ordered `current < observed`: this is the only shape in which a settlement
      // CREATES two keys, so without it the "absent keys are created in sorted order"
      // rule is observed on `claimMany` alone — vacuous exactly where it was written.
      await run('identity.settleFileClaim', () =>
        db.identity.settleFileClaim({
          space: 'alpha',
          filePath: 'aa-claimant.md',
          current: identity({ id: 'aa-claimant', filePath: 'aa-claimant.md' }),
          observedId: 'zz-observed',
          at: AT,
        }),
      )
      const purge = await run('pgMetaDb.purgeSpace', () => db.purgeSpace('alpha'))

      expect(problems).toEqual([])
      // The two transactions that span the hierarchy have to SPAN it here as well —
      // a fixture that touches no favourite and no overlay would let the whole
      // middle of the ladder pass unobserved. Checked AFTER the violations, so a
      // broken order reports as the rule it broke rather than as a thin fixture.
      expect(settlement).toEqual(
        expect.arrayContaining(['L1', 'L2a', 'L2c', 'L2d', 'L2e', 'L2f', 'L3m', 'L3n', 'L3t']),
      )
      expect(purge).toEqual(
        expect.arrayContaining(['L1', 'L2a', 'L2b', 'L2c', 'L2d', 'L2e', 'L2f', 'L3m', 'L3t']),
      )
      // Completeness in the same test: an unexercised transaction is an unchecked one.
      expect([...seen].sort()).toEqual(
        pooledPgTransactions()
          .map((transaction) => transaction.id)
          .sort(),
      )
    } finally {
      pg.Pool.prototype.connect = connect
      await testSchema.teardown()
    }
  })
})
