/**
 * The register of Postgres transactions, checked against the source — portable, so it
 * runs on every `npm test` rather than only where a live database exists.
 *
 * WHY: the lock order is a property of a TRANSACTION, and the live gate can only
 * observe transactions it knows to run. A new `BEGIN` that nobody declared is
 * therefore invisible to the mechanism — it takes whatever locks it likes, in
 * whatever order, and nothing turns red until two of them meet in production. This
 * test closes that hole from the other side: every `BEGIN` in the driver has a
 * register entry, every entry has a `BEGIN`, and every declaration is monotone
 * unless it names the exemption that lets it dip.
 *
 * Form follows `enumDrift.test.ts`: a structural invariant nothing at compile time
 * can hold, asserted over the sources themselves.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  LEVELS_NO_STATEMENT_CAN_ENTER,
  LOCK_LEVEL_OF_TABLE,
  LOCK_LEVELS,
  type LockLevel,
  NO_FOREIGN_KEY_MAY_POINT_AT,
} from '../../packages/server/src/services/metaDb/drivers/pg/lockOrder'
import { PG_TRANSACTIONS, type PgTransaction } from './pgTransactions'

const META_DB = path.resolve(import.meta.dirname, '../../packages/server/src/services/metaDb')

/** The scan zone: every module that may open a transaction against the meta-DB. */
const scannedFiles = (): string[] => {
  const driver = path.join(META_DB, 'drivers/pg')

  return [
    ...readdirSync(driver)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => path.join(driver, name)),
    path.join(META_DB, 'pgMetaDb.ts'),
    path.join(META_DB, 'migrations/runPgMigrations.ts'),
  ]
}

/** The name a line OPENS a method with, or null: a facet property
 *  (`claimMany: async (…) =>`), a class method (`async purgeSpace(…)`) or a module
 *  function (`export const runPgMigrations`).
 *
 *  A control-flow head reads exactly like a method head, so the keywords are excluded
 *  by name — otherwise an `if (…) {` above a `BEGIN` would be reported as the
 *  transaction's own. */
const headOf = (line: string): string | null => {
  const patterns = [
    /^\s{0,4}(\w+):\s*(?:async\s*)?\(/,
    /^\s{0,4}(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/,
    // A wrapped signature: the parameter list opens and the line ends there.
    /^\s{0,4}(?:async\s+)?(\w+)\s*\(\s*$/,
    /^export const (\w+) = async/,
  ]
  const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'try'])

  for (const pattern of patterns) {
    const match = pattern.exec(line)

    if (match && !keywords.has(match[1])) {
      return match[1]
    }
  }

  return null
}

/** The enclosing method of a line: the nearest head above it, which is what a reader
 *  would call it. */
const enclosingMethod = (lines: readonly string[], index: number): string | null => {
  for (let cursor = index; cursor >= 0; cursor--) {
    const head = headOf(lines[cursor])

    if (head !== null) {
      return head
    }
  }

  return null
}

/** Every `BEGIN` in the scan zone, as `<module>.<method>`. Matched on the statement,
 *  not on a receiver name: half the driver runs through `ctx.required`. */
const declaredInSource = (): string[] => {
  const found: string[] = []

  for (const file of scannedFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n')
    const module = path.basename(file, '.ts')

    lines.forEach((line, index) => {
      if (!/\.query\('BEGIN'\)/.test(line)) {
        return
      }
      const method = enclosingMethod(lines, index)

      expect(method, `${file}:${index + 1} opens a transaction outside any method`).not.toBeNull()
      found.push(`${module}.${method}`)
    })
  }

  return found.sort()
}

/** Source with the comments taken out. A helper NAMED in a docblock is not a helper
 *  CALLED, and the paragraphs in this driver name their locks constantly — the whole
 *  point of the scan below is which calls a transaction makes, so prose that reads like
 *  one has to go first. */
const withoutComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//gu, ' ').replaceAll(/\/\/[^\n]*/gu, ' ')

/** The two modules the ladder allows a tiered lock in, read as TEXT. A level is
 *  entered through a helper of theirs or it is not entered at all — see below. */
const helperModules = (): string[] =>
  ['drivers/pg/lockOrder.ts', 'drivers/pg/revisionLocks.ts'].map((name) =>
    readFileSync(path.join(META_DB, name), 'utf8'),
  )

/** Which levels a helper actually hands back a hold FOR. `lockOrder` builds every one
 *  of them through its private `hold(...)`; `revisionLocks` builds its three inline
 *  from the namespace map, so those are read as the `LockLevel` literals they are.
 *
 *  Deliberately narrow, and the narrowness is the safe direction: a hold spelled some
 *  third way reads here as NO way into the level, which is red — a level that lost its
 *  last helper and a helper this scan stopped recognizing are both worth the look. */
const levelsWithHelper = (): Set<string> => {
  const [lockOrder, revisionLocks] = helperModules().map(withoutComments)

  return new Set([
    ...[...lockOrder.matchAll(/\bhold\(\s*'(L\d[a-z]?)'/g)].map((match) => match[1]),
    ...[...revisionLocks.matchAll(/'(L\d[a-z]?)'/g)].map((match) => match[1]),
  ])
}

/** The stripes are three levels behind ONE helper, chosen by its namespace argument:
 *  `lockRevisionKeys(client, 'note', …)` enters L3n and nothing else. A call whose
 *  namespace is a variable therefore reads as no entry, which is the safe direction. */
const REVISION_STRIPE_LEVEL: Readonly<Record<string, LockLevel>> = {
  space: 'L3s',
  note: 'L3n',
  blob: 'L3b',
}

/** The levels this piece of source enters ITSELF: `hold('L…')` is how the two lock
 *  modules spell the entry they hand back, and the stripe namespace is how the third
 *  spells it. Read out of the helper's own body, so a helper renamed or moved changes
 *  nothing here — the level travels with the code that takes the lock. */
const levelsTakenIn = (source: string): LockLevel[] => [
  ...[...source.matchAll(/\bhold\(\s*'(L\d[a-z]?)'/gu)].map((match) => match[1] as LockLevel),
  ...[...source.matchAll(/\blockRevisionKeys\(\s*[^,]+,\s*'(space|note|blob)'/gu)].map(
    (match) => REVISION_STRIPE_LEVEL[match[1]],
  ),
]

/** Where a declaration STARTS: a top-level `const`/`function`, or a method head.
 *  Both are needed, and for the same reason — one bounds the other. */
const startsIn = (lines: readonly string[]): number[] =>
  lines.flatMap((line, index) =>
    headOf(line) !== null || /^(?:export )?(?:const|function|async function) \w+\b/u.test(line)
      ? [index]
      : [],
  )

/** The source of the thing a line starts, and no more than it. Two bounds, whichever
 *  comes first: the line that CLOSES it — a `}` back at its own indentation, which a
 *  formatted file guarantees — or the next declaration. Neither alone is enough: the
 *  last method of a class is followed by fields no pattern starts on, so the next
 *  declaration never comes and the span ran to the end of the file (which is how
 *  `purgeSpace` came to "call" every facet the class constructs); a one-line arrow
 *  closes on no `}` of its own and would swallow the function after it. */
const bodyAt = (lines: readonly string[], from: number, starts: readonly number[]): string => {
  const indent = /^\s*/u.exec(lines[from])![0].length
  const closes = new RegExp(`^\\s{${indent}}\\}`, 'u')
  const next = starts.find((start) => start > from) ?? lines.length

  for (let cursor = from + 1; cursor < next; cursor++) {
    if (closes.test(lines[cursor])) {
      return lines.slice(from, cursor + 1).join('\n')
    }
  }

  return lines.slice(from, next).join('\n')
}

/** Every module-level function of the scan zone, by name, as source. A transaction
 *  rarely locks with its own hands: it calls `enterIdentityTierForReferences`, which
 *  calls `lockIdentityRows`, which is where `hold('L1')` lives.
 *
 *  Module-level only, deliberately: a facet METHOD is reached as `pins.addPin(…)`, and
 *  a scan that keyed methods by their bare name would read that call as an edge into
 *  every same-named method in the zone. */
const moduleFunctions = (): Map<string, string> => {
  const sources = new Map<string, string>()

  for (const file of scannedFiles()) {
    const lines = withoutComments(readFileSync(file, 'utf8')).split('\n')
    const starts = startsIn(lines)

    lines.forEach((line, index) => {
      const match = /^(?:export )?(?:const|function|async function) (\w+)\b/u.exec(line)

      if (match) {
        sources.set(match[1], bodyAt(lines, index, starts))
      }
    })
  }

  return sources
}

/** Which levels a call to each module-level function can end up entering — its own
 *  plus everything it calls, to a fixed point. Recursion and mutual recursion are
 *  simply where the point stops moving. */
const levelsByFunction = (): Map<string, Set<LockLevel>> => {
  const sources = moduleFunctions()
  const levels = new Map<string, Set<LockLevel>>(
    [...sources].map(([name, source]) => [name, new Set(levelsTakenIn(source))]),
  )

  for (let settled = false; !settled;) {
    settled = true

    for (const [name, source] of sources) {
      const own = levels.get(name)!

      for (const call of source.matchAll(/\b(\w+)\s*\(/gu)) {
        for (const level of levels.get(call[1]) ?? []) {
          if (!own.has(level)) {
            own.add(level)
            settled = false
          }
        }
      }
    }
  }

  return levels
}

/** The levels a transaction BODY enters, by the same reading. */
const levelsEnteredIn = (body: string, byFunction: Map<string, Set<LockLevel>>): Set<LockLevel> => {
  const entered = new Set<LockLevel>(levelsTakenIn(body))

  for (const call of body.matchAll(/\b(\w+)\s*\(/gu)) {
    for (const level of byFunction.get(call[1]) ?? []) {
      entered.add(level)
    }
  }

  return entered
}

/** The body of every transaction in the scan zone, keyed the way the register keys it:
 *  the method a `BEGIN` sits in, bounded the way every other declaration is. */
const transactionBodies = (): Map<string, string> => {
  const bodies = new Map<string, string>()

  for (const file of scannedFiles()) {
    const lines = withoutComments(readFileSync(file, 'utf8')).split('\n')
    const module = path.basename(file, '.ts')
    const starts = startsIn(lines)

    lines.forEach((line, index) => {
      if (!/\.query\('BEGIN'\)/.test(line)) {
        return
      }
      const from = [...starts].reverse().find((start) => start <= index) ?? 0

      bodies.set(`${module}.${enclosingMethod(lines, index)}`, bodyAt(lines, from, starts))
    })
  }

  return bodies
}

/** The levels nothing enters, and the reason each is allowed to have no entry.
 *
 *  `L2b` (`context_set_attachments`), and the two halves of that have to be told apart
 *  because only one of them is inherited. The LEVEL is: `git show main:…/lockOrder.ts`
 *  has it, has the table map and has no `hold('L2b'` either. The RACE is not — its
 *  second writer, `abilityPlacement.moveOwnedRolePlacement`, exists only on this
 *  branch, and it is the same shape as the one closed at `L2d` and `L4p`:
 *  `contextSets.attach` INSERTs a row keyed by the very `(target_kind, target_id)` the
 *  move rewrites by range, the two share no row and therefore no lock, and under READ
 *  COMMITTED the attachment lands on a target id the role has just left.
 *
 *  Left open deliberately and not by inheritance: `attach` is a single autocommit
 *  statement today, so closing it means making it a registered transaction — a change
 *  inside the context-sets contour, not this one. That is why it is written down here
 *  instead of being assumed away, and why `L2b` is NOT in
 *  `LEVELS_NO_STATEMENT_CAN_ENTER`: adding it there would demand a helper of a
 *  transaction whose counterpart cannot take one.
 *
 *  Checked as an EQUALITY, not as an allowance: the day `L2b` gets its helper this
 *  line has to go, or the test says so. */
const LEVELS_WITHOUT_HELPER: readonly LockLevel[] = ['L2b']

const levelIndex = (level: LockLevel): number => LOCK_LEVELS.indexOf(level)

const isTierThree = (level: LockLevel): boolean => level.startsWith('L3')

/** Where a declaration goes backwards. */
const dipsIn = (levels: readonly LockLevel[]): Array<[LockLevel, LockLevel]> => {
  const dips: Array<[LockLevel, LockLevel]> = []

  for (let i = 1; i < levels.length; i++) {
    if (levelIndex(levels[i]) < levelIndex(levels[i - 1])) {
      dips.push([levels[i - 1], levels[i]])
    }
  }

  return dips
}

describe('Postgres transaction register', () => {
  it('has an entry for every transaction in the driver, and no entry without one', () => {
    const inSource = declaredInSource()
    const registered = PG_TRANSACTIONS.map((transaction) => transaction.id).sort()

    // Both directions in one assertion, so a RENAMED method reports as both the
    // undeclared new name and the vanished old one rather than as a single riddle.
    expect(inSource).toEqual(registered)
  })

  it('declares each transaction only once', () => {
    const ids = PG_TRANSACTIONS.map((transaction) => transaction.id)

    expect(ids).toEqual([...new Set(ids)])
  })

  it('declares a monotone level sequence, or names the exemption that lets it dip', () => {
    const offenders: string[] = []

    for (const transaction of PG_TRANSACTIONS) {
      for (const [from, to] of dipsIn(transaction.levels)) {
        const excused =
          // The mutex IS the order inside tier 3, and it is the first tier-3 level.
          (transaction.exempt === 'wide-scan' &&
            isTierThree(from) &&
            isTierThree(to) &&
            transaction.levels.find(isTierThree) === 'L3m') ||
          // An append upserts the CAS blob before its stripes and reasserts it after.
          (transaction.exempt === 'append-cas' && from === 'L3t' && to === 'L3s')

        if (!excused) {
          offenders.push(`${transaction.id}: ${from} → ${to}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('claims the wide-scan mutex only where it is actually taken', () => {
    // The claim is a FACT, so it is checkable: a transaction whose order inside tier 3
    // is "the mutex" has to enter the mutex. (It is not checkable the other way round —
    // a declaration is a level list, and `L3m` in it IS the claim.)
    const unfounded = PG_TRANSACTIONS.filter(
      (transaction: PgTransaction) =>
        transaction.exempt === 'wide-scan' && !transaction.levels.includes('L3m'),
    ).map((transaction) => transaction.id)

    expect(unfounded).toEqual([])
  })

  // The half of the order NOBODY writes down: an implicit lock. ESLint makes the
  // explicit lock surface finite and the live gate observes it, but a FOREIGN KEY
  // takes `FOR KEY SHARE` on the parent row with no statement to see, at whatever
  // point the child is written. `lockOrder` states which parents that is fatal for;
  // this reads the schema and holds it to the statement.
  it('lets no foreign key point at a table the ladder cannot order', () => {
    const offenders: string[] = []

    for (const dialect of ['postgres', 'sqlite']) {
      const directory = path.join(META_DB, 'migrations', dialect)

      for (const name of readdirSync(directory).filter((file) => file.endsWith('.sql'))) {
        // Comments out first: these files EXPLAIN their keys, and the paragraph
        // saying why `spaces` may not be one reads exactly like the key it forbids.
        const sql = readFileSync(path.join(directory, name), 'utf8').replaceAll(/--[^\n]*/g, '')

        // Both spellings: the table constraint (`FOREIGN KEY (…) REFERENCES x(…)`)
        // and the column one (`space TEXT REFERENCES x(id)`) reach the same catalog.
        for (const match of sql.matchAll(/\bREFERENCES\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
          if (NO_FOREIGN_KEY_MAY_POINT_AT.includes(match[1].toLowerCase())) {
            offenders.push(`${dialect}/${name} → ${match[1]}`)
          }
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('keeps every current provider contour table in the lock hierarchy', () => {
    const providerTables = [
      'secret_keyring',
      'credentials',
      'provider_resources',
      'provider_attachments',
      'provider_call_log',
    ]

    expect(providerTables.filter((table) => Object.hasOwn(LOCK_LEVEL_OF_TABLE, table))).toEqual(
      providerTables,
    )
  })

  // The question NO gate asked: not "is this level in order", but "is there a way INTO
  // it at all". A level with no incoming helper is observed by rule 1 alone — its
  // position in the sequence — because rules 2–4 are stated over the keys an ENTRY
  // declares, and an entry that never happens declares nothing. That is not a thin
  // fixture, it is vacuity by construction, and it is portable: it reads the ladder and
  // the two modules allowed to lock, and nothing else.
  it('lets no level be entered without a helper that declares its keys', () => {
    const withHelper = levelsWithHelper()

    expect(LOCK_LEVELS.filter((level) => !withHelper.has(level))).toEqual(LEVELS_WITHOUT_HELPER)
  })

  // The question the rule above CANNOT ask, and the one the level it was written for
  // needed: not "is there a way into this level", but "did THIS transaction take it".
  // `L4p` had a helper and two call sites; deleting both call sites left every portable
  // test green, because the helper still existed and the level still had its way in.
  // The rule is a property of a transaction, so it is asked of one — the register says
  // which levels a transaction takes, and the source says which of them it enters
  // through a helper. Only the levels no statement can enter by itself
  // (`LEVELS_NO_STATEMENT_CAN_ENTER`) are held to it: elsewhere the exact-key write IS
  // the lock, and demanding a helper would be demanding ceremony.
  //
  // Read statically, which is what makes it portable: a call graph over the scan zone,
  // from the transaction's body through whatever it calls, down to the `hold(...)` the
  // helper hands back. Comments are stripped first — a lock NAMED in a paragraph is not
  // a lock TAKEN, and this driver names them constantly.
  it('takes every level no statement can enter through a helper, or declares the sweep', () => {
    const byFunction = levelsByFunction()
    const bodies = transactionBodies()
    const offenders: string[] = []

    for (const transaction of PG_TRANSACTIONS) {
      const body = bodies.get(transaction.id)

      if (body === undefined) {
        // A transaction with no body at all is what the first test of this file
        // reports, by name and in both directions; saying it twice says nothing new.
        continue
      }
      const entered = levelsEnteredIn(body, byFunction)

      for (const level of new Set(transaction.levels)) {
        if (!LEVELS_NO_STATEMENT_CAN_ENTER.includes(level)) {
          continue
        }
        // Checked as an EQUALITY, like the exemptions above it: a declared sweep that
        // turns out to call a helper is as wrong as a helper that went missing — one
        // of them is a lie about the transaction, and which one is the reader's to
        // find out.
        if (entered.has(level) === (transaction.sweeps?.[level] !== undefined)) {
          offenders.push(
            entered.has(level)
              ? `${transaction.id}: ${level} is declared a sweep and enters through a helper`
              : `${transaction.id}: ${level} is declared and no helper of the ladder enters it`,
          )
        }
      }
      for (const excused of Object.keys(transaction.sweeps ?? {}) as LockLevel[]) {
        if (!transaction.levels.includes(excused)) {
          offenders.push(`${transaction.id}: ${excused} is excused as a sweep and never declared`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('excuses a dip only where a dip exists', () => {
    // `append-cas` is the one excuse that IS about a dip: it names the CAS blob upsert
    // that precedes the stripes. An entry claiming it without dipping is stale.
    const unused = PG_TRANSACTIONS.filter(
      (transaction: PgTransaction) =>
        transaction.exempt === 'append-cas' && !dipsIn(transaction.levels).length,
    ).map((transaction) => transaction.id)

    expect(unused).toEqual([])
  })
})
