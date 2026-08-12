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
  LOCK_LEVELS,
  type LockLevel,
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

/** The enclosing method of a line: a facet property (`claimMany: async (…) =>`), a
 *  class method (`async purgeSpace(…)`) or a module function (`export const runPgMigrations`).
 *  Keyed by the nearest one above, which is what a reader would call it. */
const enclosingMethod = (lines: readonly string[], index: number): string | null => {
  const patterns = [
    /^\s{0,4}(\w+):\s*(?:async\s*)?\(/,
    /^\s{0,4}(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/,
    // A wrapped signature: the parameter list opens and the line ends there.
    /^\s{0,4}(?:async\s+)?(\w+)\s*\(\s*$/,
    /^export const (\w+) = async/,
  ]
  // A control-flow head reads exactly like a method head; the scan walks upwards, so
  // an `if (…) {` above the `BEGIN` would be reported as the transaction's name.
  const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'try'])

  for (let cursor = index; cursor >= 0; cursor--) {
    for (const pattern of patterns) {
      const match = pattern.exec(lines[cursor])

      if (match && !keywords.has(match[1])) {
        return match[1]
      }
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
