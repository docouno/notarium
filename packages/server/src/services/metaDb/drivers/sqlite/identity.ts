import type {
  IdentityClaimOutcome,
  IdentityFileClaim,
  IdentityFileSettlement,
  IdentityPersistence,
  IdentityRecord,
} from '@notarium/core'
import {
  appendLegacyNameAlias,
  canonicalLegacyNameAliases,
  unionLegacyNameAliases,
} from '@notarium/core'

import type { SqliteDriverCtx } from './context'
import { rekeyReferences } from './identityRefs'
import { rekeyAndQuarantineRevisions } from './revisionQuarantine'

type IdentityRow = {
  id: string
  file_path: string
  space: string
  created_at: string | null
  materialized: number
  deleted_at: string | null
  address_revision: number | bigint
  legacy_name_aliases: string | null
  settlement_successor_id: string | null
}

const SELECT_COLUMNS =
  'id, file_path, space, created_at, materialized, deleted_at, address_revision, legacy_name_aliases, settlement_successor_id'
const SQLITE_ID_BATCH = 500

const recordOfRow = (r: IdentityRow): IdentityRecord => {
  const record: IdentityRecord = {
    id: r.id,
    legacyNameAliases: canonicalLegacyNameAliases(parseJson(r.legacy_name_aliases)),
    filePath: r.file_path,
    space: r.space,
    createdAt: r.created_at,
    materialized: r.materialized !== 0,
    deletedAt: r.deleted_at,
    addressRevision: Number(r.address_revision),
  }

  if (r.settlement_successor_id) {
    record.settlementSuccessorId = r.settlement_successor_id
  }

  return record
}

const parseJson = (raw: string | null): unknown => {
  try {
    return raw == null ? [] : JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Upsert one row WITHOUT ever changing its space. The space guard is the whole
 *  point (#327): before it, a sibling space claiming an existing id simply
 *  overwrote `space`/`file_path` and the note changed owners on a poll order. */
const UPSERT_SQL = `INSERT INTO note_identity
       (id, file_path, space, created_at, materialized, deleted_at, legacy_name_aliases)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       address_revision = note_identity.address_revision + CASE
         WHEN note_identity.file_path IS NOT excluded.file_path
           OR note_identity.deleted_at IS NOT excluded.deleted_at
         THEN 1 ELSE 0 END,
       file_path = excluded.file_path,
       created_at = excluded.created_at,
       materialized = excluded.materialized,
       deleted_at = excluded.deleted_at,
       settlement_successor_id = CASE
         WHEN excluded.deleted_at IS NULL THEN NULL
         ELSE note_identity.settlement_successor_id
       END
     WHERE note_identity.space = excluded.space`

const mergeAliases = (
  db: SqliteDriverCtx['required'],
  select: ReturnType<SqliteDriverCtx['required']['prepare']>,
  id: string,
  incoming: readonly string[],
): readonly string[] => {
  const row = select.get(id) as IdentityRow
  const aliases = unionLegacyNameAliases(
    canonicalLegacyNameAliases(parseJson(row.legacy_name_aliases)),
    incoming,
  )
  db.prepare('UPDATE note_identity SET legacy_name_aliases = ? WHERE id = ?').run(
    JSON.stringify(aliases),
    id,
  )
  return aliases
}

export const createIdentityFacet = (ctx: SqliteDriverCtx): IdentityPersistence => ({
  init: () => ctx.ensureInit(),
  loadAll: async (space: string) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(`SELECT ${SELECT_COLUMNS} FROM note_identity WHERE space = ?`)
      .all(space) as IdentityRow[]
    return rows.map(recordOfRow)
  },
  findById: async (id: string) => {
    await ctx.ensureInit()
    const r = ctx.required
      .prepare(`SELECT ${SELECT_COLUMNS} FROM note_identity WHERE id = ?`)
      .get(id) as IdentityRow | undefined

    return r ? recordOfRow(r) : null
  },
  findByIds: async (ids: readonly string[]) => {
    await ctx.ensureInit()
    const wanted = [...new Set(ids)]
    const byId = new Map<string, IdentityRecord>()

    for (let offset = 0; offset < wanted.length; offset += SQLITE_ID_BATCH) {
      const chunk = wanted.slice(offset, offset + SQLITE_ID_BATCH)
      const rows = ctx.required
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM note_identity WHERE id IN (${chunk.map(() => '?').join(', ')})`,
        )
        .all(...chunk) as IdentityRow[]

      rows.forEach((row) => byId.set(row.id, recordOfRow(row)))
    }

    return wanted.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
  },
  claimMany: async (records: readonly IdentityRecord[]) => {
    if (!records.length) {
      return []
    }
    await ctx.ensureInit()
    const db = ctx.required
    const owner = db.prepare(`SELECT ${SELECT_COLUMNS} FROM note_identity WHERE id = ?`)
    const upsert = db.prepare(UPSERT_SQL)
    const outcomes: IdentityClaimOutcome[] = []

    // IMMEDIATE takes the writer reservation before the ownership reads, so a
    // sibling connection cannot commit its own claim between them and the write.
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of records) {
        const existing = owner.get(r.id) as IdentityRow | undefined

        if (existing && existing.space !== r.space) {
          outcomes.push({ id: r.id, status: 'foreign-owner', owner: recordOfRow(existing) })
          continue
        }
        upsert.run(
          r.id,
          r.filePath,
          r.space,
          r.createdAt,
          r.materialized ? 1 : 0,
          r.deletedAt,
          JSON.stringify(canonicalLegacyNameAliases(r.legacyNameAliases)),
        )
        const legacyNameAliases = mergeAliases(db, owner, r.id, r.legacyNameAliases)
        outcomes.push({ id: r.id, status: 'claimed', legacyNameAliases })
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }

    return outcomes
  },
  mergeLegacyNameAlias: async ({ id, space, alias }) => {
    await ctx.ensureInit()
    const db = ctx.required
    db.exec('BEGIN IMMEDIATE')
    try {
      const select = db.prepare(`SELECT ${SELECT_COLUMNS} FROM note_identity WHERE id = ?`)
      const row = select.get(id) as IdentityRow | undefined

      if (!row || row.space !== space) {
        db.exec('COMMIT')
        return { status: 'not-owned' } as const
      }
      const seen = new Set<string>()
      let target = row

      for (;;) {
        if (seen.has(target.id)) {
          throw new Error(`identity settlement successor cycle for ${id}`)
        }
        seen.add(target.id)
        const successorId = target.settlement_successor_id

        if (!successorId) {
          break
        }
        if (!target.deleted_at) {
          throw new Error(`live identity ${target.id} has a settlement successor`)
        }
        const successor = select.get(successorId) as IdentityRow | undefined

        if (!successor || successor.space !== space) {
          throw new Error(`identity settlement successor disappeared for ${target.id}`)
        }
        target = successor
      }
      const legacyNameAliases = appendLegacyNameAlias(
        canonicalLegacyNameAliases(parseJson(target.legacy_name_aliases)),
        alias,
      )
      db.prepare('UPDATE note_identity SET legacy_name_aliases = ? WHERE id = ?').run(
        JSON.stringify(legacyNameAliases),
        target.id,
      )
      db.exec('COMMIT')
      return { status: 'merged', id: target.id, legacyNameAliases } as const
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
  settleFileClaim: async ({ space, filePath, current, observedId, at }: IdentityFileClaim) => {
    await ctx.ensureInit()
    const db = ctx.required
    const select = db.prepare(`SELECT ${SELECT_COLUMNS} FROM note_identity WHERE id = ?`)
    const upsert = db.prepare(UPSERT_SQL)

    db.exec('BEGIN IMMEDIATE')
    try {
      const ownerRow = select.get(observedId) as IdentityRow | undefined
      const settlement = ((): IdentityFileSettlement => {
        if (ownerRow && ownerRow.space !== space) {
          // The durable owner is authoritative and untouched. The claimant keeps
          // its own id, made durable here so the convergence that rewrites the
          // file's frontmatter can never publish a half-settled identity.
          const currentRow = select.get(current.id) as IdentityRow | undefined
          const record: IdentityRecord = {
            ...current,
            legacyNameAliases: unionLegacyNameAliases(
              currentRow
                ? canonicalLegacyNameAliases(parseJson(currentRow.legacy_name_aliases))
                : [],
              current.legacyNameAliases,
            ),
            space,
            filePath,
            deletedAt: null,
          }

          upsert.run(
            record.id,
            record.filePath,
            record.space,
            record.createdAt,
            record.materialized ? 1 : 0,
            record.deletedAt,
            JSON.stringify(record.legacyNameAliases),
          )
          record.legacyNameAliases = mergeAliases(db, select, record.id, record.legacyNameAliases)
          rekeyReferences(db, { space, fromId: observedId, toId: record.id })
          rekeyAndQuarantineRevisions(db, { space, fromId: observedId, toId: record.id })

          return { status: 'foreign-owner', owner: recordOfRow(ownerRow), record }
        }
        // A live note of THIS space holds the id at another path while the
        // claimant is a DIFFERENT identity: a user-copied file, not a rename.
        // Nothing moves — accepting would take the id off the original path.
        // The claimant's own id being the observed one is the opposite case (a
        // genuine move), and it is decided by the branch below.
        if (
          current.id !== observedId &&
          ownerRow &&
          !ownerRow.deleted_at &&
          ownerRow.file_path !== filePath
        ) {
          return {
            status: 'duplicate-path-owner',
            owner: recordOfRow(ownerRow),
            record: {
              ...current,
              legacyNameAliases: canonicalLegacyNameAliases(current.legacyNameAliases),
            },
          }
        }
        // Free, tombstoned-and-ours, this very path's, or the claimant's own id
        // arriving at a new path: the file's claim is the path's identity.
        const currentRow = select.get(current.id) as IdentityRow | undefined
        const record: IdentityRecord = {
          id: observedId,
          legacyNameAliases: unionLegacyNameAliases(
            ownerRow ? canonicalLegacyNameAliases(parseJson(ownerRow.legacy_name_aliases)) : [],
            currentRow ? canonicalLegacyNameAliases(parseJson(currentRow.legacy_name_aliases)) : [],
            current.legacyNameAliases,
          ),
          filePath,
          space,
          createdAt: ownerRow?.created_at ?? current.createdAt ?? at,
          materialized: true,
          deletedAt: null,
        }

        if (current.id !== observedId) {
          // The causal migration enforces one live identity per space/path. Retire
          // the claimant before reviving its observed id; the transaction keeps the
          // swap atomic, while the opposite order violates that invariant halfway
          // through the statement sequence.
          upsert.run(
            current.id,
            current.filePath,
            space,
            current.createdAt,
            current.materialized ? 1 : 0,
            at,
            JSON.stringify(canonicalLegacyNameAliases(current.legacyNameAliases)),
          )
          mergeAliases(db, select, current.id, current.legacyNameAliases)
        }
        upsert.run(
          record.id,
          record.filePath,
          record.space,
          record.createdAt,
          record.materialized ? 1 : 0,
          record.deletedAt,
          JSON.stringify(record.legacyNameAliases),
        )
        record.legacyNameAliases = mergeAliases(db, select, record.id, record.legacyNameAliases)
        if (current.id === observedId) {
          return { status: 'accepted', record }
        }
        db.prepare('UPDATE note_identity SET settlement_successor_id = ? WHERE id = ?').run(
          record.id,
          current.id,
        )
        rekeyReferences(db, { space, fromId: current.id, toId: record.id })
        rekeyAndQuarantineRevisions(db, { space, fromId: current.id, toId: record.id })

        return { status: 'accepted', record, retiredId: current.id }
      })()

      db.exec('COMMIT')
      return settlement
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  },
  close: () => ctx.close(),
})
