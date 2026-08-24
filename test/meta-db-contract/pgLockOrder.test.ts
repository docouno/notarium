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

import {
  type IdentityRecord,
  INSTALLATION_GENERATION_PHASE,
  RESTORE_OPERATION_PHASE,
  type RevisionInput,
} from '@notarium/core'

import { abilityPackageOfLocator } from '../../packages/server/src/services/metaDb/abilityAddress'
import {
  LOCK_LEVEL_OF_TABLE,
  LOCK_LEVEL_REQUIRES,
  LOCK_LEVELS,
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
    | {
        kind: 'statement'
        client: unknown
        text: string
        values: readonly unknown[]
        /** Issued from inside a wrapped helper, which announces its own hold. */
        inHelper: boolean
      }
    | { kind: 'lock'; client: unknown; helper: string; hold: LockHold }

  const events: Event[] = []
  /** How deep inside a wrapped helper each client currently is. A helper's own lock
   *  statement is already announced by its return value; only statements OUTSIDE
   *  every helper are candidates for the inline-lock detector below. */
  const helperDepth = new Map<unknown, number>()

  return {
    events,
    /** Wrap every exported HELPER so a level entry announces itself with its keys.
     *  The filter is the return value, never the name: entering a level by CREATING
     *  its keys is `insertImportReservationPaths`, which a `lock*` prefix test
     *  silently excused — and with it the only entry rule 4 has anything to judge.
     *  Both modules export async functions only, so awaiting is not a shape change. */
    wrap: (module: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(module).map(([name, value]) => [
          name,
          typeof value === 'function'
            ? async (...args: unknown[]) => {
                const client = args[0]
                helperDepth.set(client, (helperDepth.get(client) ?? 0) + 1)
                let result: { lock?: LockHold } | undefined

                try {
                  result = (await (value as (...a: unknown[]) => Promise<unknown>)(...args)) as
                    { lock?: LockHold } | undefined
                } finally {
                  helperDepth.set(client, (helperDepth.get(client) ?? 1) - 1)
                }

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
          inHelper: (helperDepth.get(client) ?? 0) > 0,
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

/** Does this statement TAKE a lock, whatever expression it is spelled with? DML is one
 *  way; a bare `SELECT … FOR KEY SHARE` is another, and it was invisible here — which
 *  is how `agentDeltaCursors.advance` came to hold `folders` (L4f) under a register
 *  entry of `levels: []`, with three green gates over it. The strengths are the same
 *  list the ESLint layer matches, and for the same reason: a first draft forgets
 *  `FOR KEY SHARE`. */
const ROW_LOCK = /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b|\bFOR\s+(?:KEY\s+)?SHARE\b/i

/** Every table a lock statement names. A row lock is taken on what the statement
 *  READS, so the names come from its FROM/JOIN list; `LOCK TABLE` names its own. The
 *  answer is filtered against the tier map by the caller, so a non-tiered name here
 *  costs nothing. */
const lockedTables = (text: string): string[] => {
  const explicit = /\bLOCK\s+(?:TABLE\s+)?(?:ONLY\s+)?"?([a-z_][a-z0-9_]*)"?/i.exec(text)

  if (explicit) {
    return [explicit[1]]
  }
  if (!ROW_LOCK.test(text)) {
    return []
  }

  return [...text.matchAll(/\b(?:FROM|JOIN)\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((match) => match[1])
}

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

/** How a statement's parameter names a key OF ITS LEVEL. At every level but one the
 *  two are the same string: the entry declares the ids the rows are keyed by, and the
 *  statement binds them. `L4p` is the exception on purpose — the rows are keyed by the
 *  ADDRESS of a package and the entry is keyed by the PACKAGE, because the address is
 *  precisely what the other writer of that table changes (`lockOrder`, L4p). So a
 *  parameter is compared BOTH as itself and as the package it names; a parameter that
 *  is not an address projects to itself, so nothing else is affected. */
const LEVEL_KEY_PROJECTION: Partial<Record<Level, (parameter: string) => string>> = {
  L4p: abilityPackageOfLocator,
}

const keysOfStatement = (level: Level, values: readonly unknown[]): string[] => {
  const project = LEVEL_KEY_PROJECTION[level]
  const parameters = parameterStrings(values)

  return project ? [...new Set([...parameters, ...parameters.map(project)])] : parameters
}

/** Is this declared key named by a statement's parameters? A composite (`kind:id`,
 *  `space:path`) is declared as one string but reaches SQL as its PARTS, so it counts
 *  as named only when EVERY part is there — accepting a single part would let a
 *  shared component (the space, which every claim of an import shares) stand for the
 *  whole key. The split is searched rather than assumed, because a part may itself
 *  contain the separator. */
const namesKey = (key: string, params: ReadonlySet<string>): boolean => {
  if (params.has(key)) {
    return true
  }
  for (let at = key.indexOf(':'); at >= 0; at = key.indexOf(':', at + 1)) {
    if (params.has(key.slice(0, at)) && namesKey(key.slice(at + 1), params)) {
      return true
    }
  }

  return false
}

/** Which of these declared keys one statement names, in the order its parameters
 *  name them — within a single statement the parameter order IS the acquisition
 *  order, which is what rule 4 reads. Comparing raw parameters instead (what this
 *  replaced) could never match a composite at all, which is how rule 4 came to judge
 *  nothing at L1p. */
const keysNamedBy = (keys: readonly string[], params: readonly string[]): string[] => {
  const present = new Set(params)

  return keys
    .filter((key) => namesKey(key, present))
    .map((key) => ({
      key,
      at: params.findIndex((param) => key === param || key.endsWith(`:${param}`)),
    }))
    .sort((left, right) => left.at - right.at)
    .map((named) => named.key)
}

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
    const mutated = mutatedTable(event.text)
    // A helper's own lock statement is announced by the helper; anything else that
    // takes a lock on a tiered table is an acquisition this transaction made by hand,
    // and it is levelled exactly like a mutation of that table.
    const tables = [
      ...(mutated ? [mutated] : []),
      ...(event.inHelper ? [] : lockedTables(event.text)),
    ]
    const levels = [
      ...new Set(
        tables
          .map((table) => LOCK_LEVEL_OF_TABLE[table] as Level | undefined)
          .filter((level): level is Level => level != null),
      ),
    ]

    if (!levels.length) {
      continue
    }
    for (const level of levels) {
      current.steps.push({
        level,
        source: 'dml',
        text: event.text,
        keys: keysOfStatement(level, event.values),
      })
    }
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
    if (!keysNamedBy(hold.declared, step.keys).length) {
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
    const acquired: string[] = []

    for (const step of transaction.steps) {
      if (step.level !== level || step.source !== 'dml') {
        continue
      }
      for (const key of keysNamedBy(hold.absent, step.keys)) {
        if (!acquired.includes(key)) {
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
  legacyNameAliases: over.legacyNameAliases ?? [],
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

/** One test, and it creates a schema, migrates it and drives every registered
 *  transaction through a live database — so the vitest default (5 s) is not a
 *  budget it can be polled against, exactly as in the two sibling PG suites. */
const SUITE_TIMEOUT_MS = 15_000

describePostgres('Postgres lock order', { timeout: SUITE_TIMEOUT_MS }, () => {
  it('takes the levels every registered transaction declared, and every transaction runs', async () => {
    // Not `pg_…`: Postgres reserves that prefix for system schemas.
    const testSchema = await createPostgresTestSchema('lock_order')
    const db = testSchema.db
    const connect = pg.Pool.prototype.connect
    const seen = new Set<string>()
    const observedLevels = new Set<Level>()
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
    const seenLast: { transaction: Transaction | null } = { transaction: null }

    const run = async (id: string, action: () => Promise<unknown>): Promise<Level[]> => {
      const from = observer.events.length

      await action()
      const observed = transactionsIn(observer.events.slice(from))

      seenLast.transaction = observed[0] ?? null

      // Exactly one: every registered method opens a single transaction, and a
      // fixture built inside the window would otherwise be judged as this one.
      expect(observed.length, `${id} did not open exactly one transaction`).toBe(1)
      seen.add(id)
      for (const transaction of observed) {
        problems.push(...violationsOf(id, transaction))
      }

      const levels = [
        ...new Set(observed.flatMap((transaction) => transaction.steps.map((step) => step.level))),
      ]

      for (const level of levels) {
        observedLevels.add(level)
      }

      return levels
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
      // A non-empty selection on purpose: an empty one never reads the project rows,
      // so it would never enter L4f and the order this transaction shares with the
      // whole-space purge would go unobserved. A registry note for the same reason —
      // a `null` one never enters L3n, and the lifecycle fence above tier 4 would be
      // observed by half.
      await run('abilityAvailability.set', () =>
        db.abilityAvailability.set(
          'alpha',
          'skill-one',
          { mode: 'selected-projects', projectIds: ['project-alpha'] },
          'registry-note',
        ),
      )
      await run('abilityAvailability.clear', () =>
        db.abilityAvailability.clear('alpha', 'skill-one'),
      )
      await run('abilityAvailability.grantProject', () =>
        db.abilityAvailability.grantProject('alpha', 'skill-two', 'project-alpha', null),
      )
      await run('abilityAvailability.reserve', () =>
        db.abilityAvailability.reserve('alpha', 'skill-reserved', {
          mode: 'selected-projects',
          projectIds: ['project-alpha'],
        }),
      )
      await run('abilityAvailability.finalize', () =>
        db.abilityAvailability.finalize('alpha', 'skill-reserved', 'registry-reserved'),
      )
      await db.abilityAvailability.reserve('alpha', 'skill-cancelled', {
        mode: 'selected-projects',
        projectIds: ['project-alpha'],
      })
      await run('abilityAvailability.cancel', () =>
        db.abilityAvailability.cancel('alpha', 'skill-cancelled'),
      )
      const abilityCreateAccepted = {
        id: 'ability-create-operation',
        actorDigest: 'ability-create-actor',
        idempotencyDigest: 'ability-create-key',
        requestFingerprint: 'ability-create-request',
        space: 'alpha',
        packageId: 'AbilityPkg01',
        noteId: 'AbilityNote1',
        targetPath: '.notarium/skills/AbilityPkg01/SKILL.md',
        availabilityRequired: true,
        stageBinding: 'ability-create-stage',
        preparedEvidence: 'ability-create-evidence',
        identity: identity({
          id: 'AbilityNote1',
          filePath: '.notarium/skills/AbilityPkg01/SKILL.md',
          materialized: false,
        }),
        availability: {
          mode: 'selected-projects' as const,
          projectIds: ['project-alpha'],
        },
        createdAt: AT,
      }
      await run('abilityCreate.accept', () => db.abilityCreate.accept(abilityCreateAccepted))
      await db.abilityCreate.markPhysical(
        abilityCreateAccepted.id,
        abilityCreateAccepted.preparedEvidence,
        'ability-create-receipt',
        AT,
      )
      await run('abilityCreate.commit', () =>
        db.abilityCreate.commit({
          operationId: abilityCreateAccepted.id,
          preparedEvidence: abilityCreateAccepted.preparedEvidence,
          physicalReceipt: 'ability-create-receipt',
          identity: identity({
            id: abilityCreateAccepted.noteId,
            filePath: abilityCreateAccepted.targetPath,
            materialized: true,
          }),
          revision: revision(abilityCreateAccepted.noteId, {
            contentHash: 'ability-create-content',
            semanticFingerprint: 'ability-create-semantic',
            entryRole: 'origin',
          }) as RevisionInput & { contentHash: string; semanticFingerprint: string },
          content: new TextEncoder().encode('ability create content'),
          ownerProof: {
            sourceHash: 'ability-create-source',
            proofJson: '{}',
            receiptId: abilityCreateAccepted.id,
          },
          result: {
            packageId: abilityCreateAccepted.packageId,
            noteId: abilityCreateAccepted.noteId,
            versionToken: 'ability-create-version',
          },
          committedAt: AT,
        }),
      )
      await run('abilityCreate.finalize', () =>
        db.abilityCreate.finalize(
          abilityCreateAccepted.id,
          abilityCreateAccepted.preparedEvidence,
          'ability-create-receipt',
          AT,
        ),
      )
      const abilityCreateRejected = {
        ...abilityCreateAccepted,
        id: 'ability-create-rejected',
        idempotencyDigest: 'ability-create-rejected-key',
        packageId: 'AbilityPkg02',
        noteId: 'AbilityNote2',
        targetPath: '.notarium/skills/AbilityPkg02/SKILL.md',
        identity: identity({
          id: 'AbilityNote2',
          filePath: '.notarium/skills/AbilityPkg02/SKILL.md',
          materialized: false,
        }),
      }
      await db.abilityCreate.accept(abilityCreateRejected)
      await run('abilityCreate.reject', () =>
        db.abilityCreate.reject(abilityCreateRejected.id, 'probe-rejection', AT),
      )
      await run('sessions.startInferred', () =>
        db.sessions.startInferred(
          {
            id: 'session-inferred',
            owner: 'user:inferred',
            name: 'personal · now',
            named: false,
            parentId: null,
            createdAt: AT,
            lastSeenAt: AT,
            calls: 1,
            role: null,
            roleLocator: null,
            roleContextProjectId: null,
            projectId: null,
          },
          AT,
          AT,
          10,
        ),
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
            roleLocator: null,
            roleContextProjectId: null,
            projectId: null,
          },
          AT,
          AT,
          10,
        ),
      )
      await run('sessions.setRole', () =>
        db.sessions.setRole('user:al', 'session-1', {
          name: 'role-a',
          locator: {
            source: 'owned',
            kind: 'role',
            packageId: 'AbCdefGhij_1',
            location: { scope: 'personal', spaceId: 'alpha' },
          },
          contextProjectId: null,
        }),
      )
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
      const generation = {
        generation: 1,
        phase: INSTALLATION_GENERATION_PHASE.activeInstalled,
        activeKeyId: 'active-key',
        activeHash: 'active-hash',
        candidateKeyId: null,
        candidateHash: null,
        changedAt: AT,
      }

      await run('installationGeneration.compareAndSet', () =>
        db.installationGeneration.compareAndSet({ expected: null, record: generation }),
      )
      const freeze = await run('installationGeneration.acquireBackupFreeze', () =>
        db.installationGeneration.acquireBackupFreeze({
          owner: 'backup-owner',
          now: AT,
          expiresAt: '2026-08-11T11:00:00.000Z',
        }),
      )

      expect(freeze).toEqual([])
      await run('installationGeneration.renewBackupFreeze', () =>
        db.installationGeneration.renewBackupFreeze({
          owner: 'backup-owner',
          expected: {
            generation: 1,
            keyId: 'active-key',
            activeHash: 'active-hash',
            candidateKeyId: null,
            candidateHash: null,
          },
          now: '2026-08-11T10:05:00.000Z',
          expiresAt: '2026-08-11T11:05:00.000Z',
        }),
      )
      await run('spaceLifecycle.transition', () =>
        db.spaceLifecycle.transition({
          space: 'alpha',
          expectedPhases: ['active'],
          phase: 'active',
          changedAt: AT,
        }),
      )
      await run('causalOutbox.append', () =>
        db.causalOutbox.append({
          space: 'alpha',
          generation: 2,
          kind: 'lock-probe',
          operationId: null,
          resourceId: 'note-a',
          createdAt: AT,
        }),
      )

      // ── the identity tier and the facets under it ──────────────────────────
      await run('identity.claimMany', () =>
        db.identity.claimMany([
          identity({ id: 'note-b' }),
          identity({ id: 'note-a' }),
          identity({ id: 'note-terminal', filePath: 'terminal.md' }),
        ]),
      )
      await run('identity.mergeLegacyNameAlias', () =>
        db.identity.mergeLegacyNameAlias({
          id: 'note-b',
          space: 'alpha',
          alias: 'historic-note-b',
        }),
      )
      await run('ownerProofs.adopt', () =>
        db.ownerProofs.adopt({
          noteId: 'note-b',
          space: 'alpha',
          addressRevision: 1,
          expectedProofRevision: null,
          sourceHash: 'note-b-source',
          proofJson: '{}',
          receiptId: 'note-b-receipt',
          updatedAt: AT,
        }),
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

      // Registered since the preference facet landed, but never exercised until now:
      // an unexercised transaction is an unchecked one, which is exactly what the
      // completeness assertion below exists to catch.
      await run('abilityPreferences.setEnabled', () =>
        db.abilityPreferences.setEnabled(
          'user:al',
          {
            locator: {
              source: 'owned',
              kind: 'role',
              packageId: 'AbCdefGhij_1',
              location: { scope: 'space', spaceId: 'alpha' },
            },
            registryNoteId: 'note-a',
          },
          false,
          AT,
        ),
      )
      await run('abilityPlacement.moveOwnedRolePlacement', () =>
        db.abilityPlacement.moveOwnedRolePlacement({
          fromTargetId: 'project:project-alpha:AbCdefGhij_1',
          toTargetId: 'space:alpha:AbCdefGhij_1',
          fromLocator: 'owned:role:project:alpha:project-alpha:AbCdefGhij_1',
          toLocator: 'owned:role:space:alpha:AbCdefGhij_1',
          registryNoteId: 'note-a',
          manifestNoteId: 'note-a',
        }),
      )

      await run('contextSets.deleteSet', () => db.contextSets.deleteSet('set-1'))

      // ── revisions ──────────────────────────────────────────────────────────
      await run('revisions.append', () => db.revisions.append(revision('note-a'), 'body'))
      const accepted = {
        id: 'operation-probe',
        space: 'alpha',
        noteId: 'note-a',
        endpoint: 'history-restore',
        actorDigest: 'actor-probe',
        idempotencyDigest: 'key-probe',
        requestFingerprint: 'request-probe',
        stageBinding: 'stage-probe',
        sourceRevisionId: '1',
        targetPath: 'note-a.md',
        preparedEvidence: '{}',
        createdAt: AT,
      }

      await run('restoreOperations.accept', () => db.restoreOperations.accept(accepted))
      await run('restoreOperations.transition', () =>
        db.restoreOperations.transition({
          id: accepted.id,
          expectedPhases: [RESTORE_OPERATION_PHASE.staged],
          phase: RESTORE_OPERATION_PHASE.rejected,
          updatedAt: AT,
        }),
      )
      const terminalSource = await db.revisions.append(
        revision('note-terminal', { contentHash: 'terminal-source-hash' }),
        'terminal source',
      )
      const terminalAcceptance = {
        ...accepted,
        id: 'terminal-operation',
        noteId: 'note-terminal',
        actorDigest: 'terminal-actor',
        idempotencyDigest: 'terminal-key',
        requestFingerprint: 'terminal-request',
        sourceRevisionId: terminalSource.id,
        targetPath: 'terminal.md',
        preparedEvidence: 'terminal-accepted',
      }

      await db.restoreOperations.accept(terminalAcceptance)
      await db.restoreOperations.transition({
        id: terminalAcceptance.id,
        expectedPhases: [RESTORE_OPERATION_PHASE.staged],
        phase: RESTORE_OPERATION_PHASE.prepared,
        sourceRevisionId: terminalSource.id,
        expectedHeadRevisionId: terminalSource.id,
        targetPath: terminalAcceptance.targetPath,
        preparedEvidence: 'terminal-prepared',
        updatedAt: AT,
      })
      await db.restoreOperations.transition({
        id: terminalAcceptance.id,
        expectedPhases: [RESTORE_OPERATION_PHASE.prepared],
        phase: RESTORE_OPERATION_PHASE.physicalPublished,
        physicalReceipt: 'terminal-physical-receipt',
        updatedAt: AT,
      })
      await run('restoreTerminal.commit', () =>
        db.restoreTerminal.commit({
          operationId: terminalAcceptance.id,
          sourceRevisionId: terminalSource.id,
          expectedHeadRevisionId: terminalSource.id,
          targetPath: terminalAcceptance.targetPath,
          preparedEvidence: 'terminal-prepared',
          physicalReceipt: 'terminal-physical-receipt',
          expectedIdentity: {
            addressRevision: 1,
            filePath: terminalAcceptance.targetPath,
            deletedAt: null,
          },
          identity: identity({
            id: 'note-terminal',
            filePath: terminalAcceptance.targetPath,
            addressRevision: 1,
          }),
          revision: revision('note-terminal', {
            baseRevisionId: terminalSource.id,
            sourceRevisionId: terminalSource.id,
            kind: 'restore',
            entryRole: 'change',
            contentHash: 'terminal-restored-hash',
            expectedHeadRevisionId: terminalSource.id,
          }),
          content: 'terminal restored',
          proof: {
            expectedProofRevision: null,
            sourceHash: 'terminal-source-proof',
            proofJson: '{}',
            receiptId: 'terminal-proof-receipt',
          },
          result: {
            noteId: 'note-terminal',
            filePath: terminalAcceptance.targetPath,
            versionToken: 'terminal-version',
          },
          outboxKind: 'restore-terminal',
          committedAt: AT,
        }),
      )
      await run('restoreTerminal.finalize', () =>
        db.restoreTerminal.finalize({
          operationId: terminalAcceptance.id,
          preparedEvidence: 'terminal-prepared',
          physicalReceipt: 'terminal-physical-receipt',
          outboxKind: 'restore-terminal',
          finalizedAt: AT,
        }),
      )
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
      // Import reservations (#302). Their whole point is an exclusion that outlives a
      // file write, so the sequence they take is the thing under test: L0j before
      // anything, then the header, then the claims.
      await db.jobs.enqueue({
        id: 'import-job',
        space: 'alpha',
        kind: 'import',
        principal: 'user:al',
        createdAt: AT,
      })
      await db.jobs.claimNext('lease-1', ['import'], AT)
      const claimKey = {
        space: 'alpha',
        jobId: 'import-job',
        workerLease: 'lease-1',
        uploadRef: 'upload-1',
      }
      const reserved = await run('importReservations.reserve', () =>
        db.importReservations.reserve({
          ...claimKey,
          // DESCENDING by destination, on purpose. These keys do not exist yet, so
          // rule 4 — absent keys are acquired in sorted order — is the only thing
          // standing between two imports with overlapping destinations and a
          // deadlock halfway through each other's list. A fixture already in sorted
          // order cannot tell a sorting insert from an unsorted one.
          //
          // And the two orders CROSS: `entry_key` is the archive member's name,
          // `destination_path` the slug of the note's TITLE, and nothing ties them
          // together — an archive whose `Zebra.md` holds a note titled "Apple" is
          // ordinary. A fixture whose keys sort alike (`vault/a.md` → `imported/a.md`)
          // reads the same under a sort on either column, so it pins the ORDER
          // without pinning which column that order is over — and sorting by
          // `entry_key` would deadlock two real imports against each other while
          // both gates stayed green.
          entries: [
            // A SECOND claim, so the fenced write below has something to over-lock.
            {
              entryKey: 'vault/apple.md',
              destinationPath: 'imported/zebra.md',
              targetId: 'target-zebra',
              expectedId: null,
              ownership: 'fresh-owned',
            },
            {
              entryKey: 'vault/zebra.md',
              destinationPath: 'imported/apple.md',
              targetId: 'target-apple',
              expectedId: null,
              ownership: 'fresh-owned',
            },
          ],
          now: AT,
        }),
      )
      // Rule 4 can only judge keys the entry says were ABSENT, and this entry creates
      // every one of them. A hold that reported its own creations as already held —
      // which is what it did — left `absent` empty and the rule with nothing to read,
      // so the descending fixture above proved nothing.
      //
      // The SET, not the sequence: which keys this level was entered for is this
      // assertion's business (and length alone let a hold declare `entry_key`s here
      // and `space:destination_path` everywhere else), while the sequence is rule 4's
      // — pinning it here would catch the mis-sort as a broken expectation instead of
      // as the ordering violation it is.
      const claimed = seenLast.transaction?.holds.get('L1p')

      expect(claimed, 'the reserve never announced its L1p entry').toBeDefined()
      expect([...(claimed?.declared ?? [])].sort()).toEqual([
        'alpha:imported/apple.md',
        'alpha:imported/zebra.md',
      ])
      expect(claimed?.absent, 'the reserve entry claims to hold keys it creates').toEqual(
        claimed?.declared,
      )
      const taken = await db.importReservations.forJob('import-job')

      await run('importReservations.withFencedWrite', () =>
        db.importReservations.withFencedWrite(
          {
            reservationId: taken!.id,
            fence: taken!.fence,
            jobId: 'import-job',
            workerLease: 'lease-1',
            space: 'alpha',
            destinationPath: 'imported/apple.md',
          },
          async () => undefined,
        ),
      )
      // One write, ONE claim. Taking the whole reservation to find the row made a
      // write cost the size of the import: 10 000 row locks per note on a 10 000-note
      // tree, every one of them held across the file write. Spelled `space:path`
      // because that is the ONE vocabulary of this level — the pair the unique index
      // arbitrates on, and the pair every L1p helper now declares.
      expect(seenLast.transaction?.holds.get('L1p')?.declared).toEqual(['alpha:imported/apple.md'])
      await run('importReservations.adopt', () =>
        db.importReservations.adopt({ ...claimKey, now: AT }),
      )
      // Adopt changes only the header's job/fence while holding L1r. Its path read
      // is deliberately unlocked: any writer or closer of this reservation must
      // first queue behind that same header, and a rival reserve can only INSERT a
      // different row. Claiming an L1p entry here would contradict both the actual
      // transaction and its registry declaration.
      expect(seenLast.transaction?.holds.get('L1p')).toBeUndefined()
      await run('importReservations.closeForJob', () =>
        db.importReservations.closeForJob({ jobId: 'import-job', now: AT }),
      )
      // The FK cascade does acquire L1p, but the observer classifies statements by
      // their explicit target table and therefore cannot see that implicit step.
      // The registry declares it; the live trace must not fabricate a helper hold.
      expect(seenLast.transaction?.holds.get('L1p')).toBeUndefined()
      // Same fence, taken by the other side: an invalidation must queue behind an
      // entered write rather than commit inside it.
      await run('jobInvalidation.withJobFence', () => db.jobs.cancel('import-job', AT))
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
      // Same reason as above: a reserve that claimed nothing would never enter L1p,
      // and the level that arbitrates destinations would go unobserved.
      expect(reserved).toEqual(expect.arrayContaining(['L0j', 'L1r', 'L1p']))
      // …and the same question asked of the LADDER rather than of three fixtures: a
      // level no transaction in this run ever reaches is a level nothing above
      // observes. Written against `LOCK_LEVELS` itself, so adding a rung without a
      // fixture that reaches it fails here by name — which the three hand-written
      // arrays above could not do, and did not do when tier 4 arrived.
      expect([...LOCK_LEVELS].filter((level) => !observedLevels.has(level))).toEqual([])
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
