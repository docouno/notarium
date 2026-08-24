import type { DatabaseSync } from 'node:sqlite'
import { ABILITY_AVAILABILITY_MODE } from '@notarium/contract'

import {
  type AbilityAvailability,
  type AbilityAvailabilityPersistence,
  type AbilityAvailabilityRecord,
  abilityTargetPurgedError,
} from '../../types'
import { assertAbilityTargetLive } from './abilityLifecycle'
import type { SqliteDriverCtx } from './context'

type AvailabilityRow = {
  home_space: string
  package_id: string
  mode:
    typeof ABILITY_AVAILABILITY_MODE.allProjects | typeof ABILITY_AVAILABILITY_MODE.selectedProjects
  project_id: string | null
}

const recordsOf = (rows: AvailabilityRow[]): AbilityAvailabilityRecord[] => {
  const records = new Map<string, AbilityAvailabilityRecord>()

  for (const row of rows) {
    const key = `${row.home_space}\0${row.package_id}`
    let record = records.get(key)

    if (!record) {
      record =
        row.mode === ABILITY_AVAILABILITY_MODE.allProjects
          ? {
              homeSpace: row.home_space,
              packageId: row.package_id,
              mode: ABILITY_AVAILABILITY_MODE.allProjects,
            }
          : {
              homeSpace: row.home_space,
              packageId: row.package_id,
              mode: ABILITY_AVAILABILITY_MODE.selectedProjects,
              projectIds: [],
            }
      records.set(key, record)
    }
    if (record.mode === ABILITY_AVAILABILITY_MODE.selectedProjects && row.project_id) {
      record.projectIds.push(row.project_id)
    }
  }

  return [...records.values()]
}

const select = `
  SELECT a.home_space, a.package_id, a.mode, b.project_id
    FROM ability_availability a
    LEFT JOIN ability_project_bindings b
      ON b.home_space = a.home_space AND b.package_id = a.package_id`

const assertProjects = (
  db: DatabaseSync,
  homeSpace: string,
  projectIds: readonly string[],
): void => {
  if (!projectIds.length) {
    return
  }
  const placeholders = projectIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT id FROM folders WHERE type = 'project' AND space = ? AND id IN (${placeholders})`,
    )
    .all(homeSpace, ...projectIds) as Array<{ id: string }>
  const found = new Set(rows.map(({ id }) => id))
  const missing = projectIds.find((id) => !found.has(id))

  if (missing) {
    throw abilityTargetPurgedError(
      `project ${missing} does not belong to ability home space ${homeSpace}`,
    )
  }
}

export const createAbilityAvailabilityFacet = (
  ctx: SqliteDriverCtx,
): AbilityAvailabilityPersistence => ({
  get: async (homeSpace, packageId) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `${select}
          WHERE a.home_space = ? AND a.package_id = ?
          ORDER BY b.project_id ASC`,
      )
      .all(homeSpace, packageId) as AvailabilityRow[]
    return recordsOf(rows)[0] ?? null
  },

  listForSpace: async (homeSpace) => {
    await ctx.ensureInit()
    const rows = ctx.required
      .prepare(
        `${select}
          WHERE a.home_space = ?
          ORDER BY a.package_id ASC, b.project_id ASC`,
      )
      .all(homeSpace) as AvailabilityRow[]
    return recordsOf(rows)
  },

  reserve: async (homeSpace, packageId, availability) => {
    await ctx.ensureInit()
    const db = ctx.required
    const projectIds =
      availability.mode === ABILITY_AVAILABILITY_MODE.selectedProjects
        ? [...new Set(availability.projectIds)].sort()
        : []

    db.exec('BEGIN IMMEDIATE')
    try {
      assertAbilityTargetLive(db, homeSpace, null)
      assertProjects(db, homeSpace, projectIds)
      const inserted = db
        .prepare(
          `INSERT INTO ability_availability (home_space, package_id, mode, registry_note_id)
           VALUES (?, ?, ?, NULL)
           ON CONFLICT(home_space, package_id) DO NOTHING`,
        )
        .run(homeSpace, packageId, availability.mode).changes

      if (inserted === 1) {
        const insert = db.prepare(
          'INSERT INTO ability_project_bindings (home_space, package_id, project_id) VALUES (?, ?, ?)',
        )

        for (const projectId of projectIds) {
          insert.run(homeSpace, packageId, projectId)
        }
      }
      db.exec('COMMIT')
      return inserted === 1
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },

  finalize: async (homeSpace, packageId, actualNoteId) => {
    await ctx.ensureInit()
    const db = ctx.required

    db.exec('BEGIN IMMEDIATE')
    try {
      assertAbilityTargetLive(db, homeSpace, actualNoteId)
      const changed = db
        .prepare(
          `UPDATE ability_availability
              SET registry_note_id = ?
            WHERE home_space = ? AND package_id = ? AND registry_note_id IS NULL`,
        )
        .run(actualNoteId, homeSpace, packageId).changes

      db.exec('COMMIT')
      return changed === 1
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },

  cancel: async (homeSpace, packageId) => {
    await ctx.ensureInit()
    const changed = ctx.required
      .prepare(
        `DELETE FROM ability_availability
          WHERE home_space = ? AND package_id = ? AND registry_note_id IS NULL`,
      )
      .run(homeSpace, packageId).changes

    return changed === 1
  },

  set: async (homeSpace, packageId, availability: AbilityAvailability, registryNoteId) => {
    await ctx.ensureInit()
    const db = ctx.required
    const projectIds =
      availability.mode === ABILITY_AVAILABILITY_MODE.selectedProjects
        ? [...new Set(availability.projectIds)].sort()
        : []

    db.exec('BEGIN IMMEDIATE')
    try {
      // Before the projects it binds are even read: the ability this policy is ABOUT
      // has to be alive first. The same fence, in the same place, as the preferences
      // facet next door.
      assertAbilityTargetLive(db, homeSpace, registryNoteId ?? null)
      assertProjects(db, homeSpace, projectIds)
      // The registry note is LEARNED, never forgotten: a caller that does not know it
      // (a host with no read-model barrier to ask) must not erase the key a caller
      // that did know it wrote, or the purge sweep silently falls back to the
      // pre-arbitration assumption for a row that had the answer.
      db.prepare(
        `INSERT INTO ability_availability (home_space, package_id, mode, registry_note_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(home_space, package_id) DO UPDATE SET
           mode = excluded.mode,
           registry_note_id =
             COALESCE(excluded.registry_note_id, ability_availability.registry_note_id)`,
      ).run(homeSpace, packageId, availability.mode, registryNoteId ?? null)
      db.prepare(
        'DELETE FROM ability_project_bindings WHERE home_space = ? AND package_id = ?',
      ).run(homeSpace, packageId)
      const insert = db.prepare(
        'INSERT INTO ability_project_bindings (home_space, package_id, project_id) VALUES (?, ?, ?)',
      )

      for (const projectId of projectIds) {
        insert.run(homeSpace, packageId, projectId)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },

  clear: async (homeSpace, packageId) => {
    await ctx.ensureInit()
    const db = ctx.required

    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        'DELETE FROM ability_project_bindings WHERE home_space = ? AND package_id = ?',
      ).run(homeSpace, packageId)
      db.prepare('DELETE FROM ability_availability WHERE home_space = ? AND package_id = ?').run(
        homeSpace,
        packageId,
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },

  grantProject: async (homeSpace, packageId, projectId, registryNoteId) => {
    await ctx.ensureInit()
    const db = ctx.required

    db.exec('BEGIN IMMEDIATE')
    try {
      assertAbilityTargetLive(db, homeSpace, registryNoteId ?? null)
      assertProjects(db, homeSpace, [projectId])
      const current = db
        .prepare('SELECT mode FROM ability_availability WHERE home_space = ? AND package_id = ?')
        .get(homeSpace, packageId) as { mode: string } | undefined

      if (current?.mode !== ABILITY_AVAILABILITY_MODE.allProjects) {
        db.prepare(
          `INSERT INTO ability_availability (home_space, package_id, mode, registry_note_id)
           VALUES (?, ?, '${ABILITY_AVAILABILITY_MODE.selectedProjects}', ?)
           ON CONFLICT(home_space, package_id) DO UPDATE SET
             registry_note_id =
               COALESCE(excluded.registry_note_id, ability_availability.registry_note_id)`,
        ).run(homeSpace, packageId, registryNoteId ?? null)
        db.prepare(
          `INSERT INTO ability_project_bindings (home_space, package_id, project_id)
           VALUES (?, ?, ?)
           ON CONFLICT(home_space, package_id, project_id) DO NOTHING`,
        ).run(homeSpace, packageId, projectId)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  },
})
