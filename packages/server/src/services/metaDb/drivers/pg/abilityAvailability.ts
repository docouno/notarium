import type { PoolClient } from 'pg'
import { ABILITY_AVAILABILITY_MODE } from '@notarium/contract'

import {
  type AbilityAvailability,
  type AbilityAvailabilityPersistence,
  type AbilityAvailabilityRecord,
  abilityTargetPurgedError,
} from '../../types'
import { assertAbilityTargetLive } from './abilityLifecycle'
import type { PgDriverCtx } from './context'
import {
  lockAbilityAvailabilityPackage,
  lockAbilityAvailabilityRow,
  lockAbilityHomeProjects,
} from './lockOrder'

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

const assertProjects = async (
  client: PoolClient,
  homeSpace: string,
  projectIds: readonly string[],
): Promise<void> => {
  if (!projectIds.length) {
    return
  }
  const found = new Set((await lockAbilityHomeProjects(client, homeSpace, projectIds)).ids)
  const missing = projectIds.find((id) => !found.has(id))

  if (missing) {
    throw abilityTargetPurgedError(
      `project ${missing} does not belong to ability home space ${homeSpace}`,
    )
  }
}

export const createAbilityAvailabilityFacet = (
  ctx: PgDriverCtx,
): AbilityAvailabilityPersistence => ({
  get: async (homeSpace, packageId) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `${select}
        WHERE a.home_space = $1 AND a.package_id = $2
        ORDER BY b.project_id ASC`,
      [homeSpace, packageId],
    )
    return recordsOf(result.rows as AvailabilityRow[])[0] ?? null
  },

  listForSpace: async (homeSpace) => {
    await ctx.ensureInit()
    const result = await ctx.required.query(
      `${select}
        WHERE a.home_space = $1
        ORDER BY a.package_id ASC, b.project_id ASC`,
      [homeSpace],
    )
    return recordsOf(result.rows as AvailabilityRow[])
  },

  reserve: async (homeSpace, packageId, availability) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()
    const projectIds =
      availability.mode === ABILITY_AVAILABILITY_MODE.selectedProjects
        ? [...new Set(availability.projectIds)].sort()
        : []

    try {
      await client.query('BEGIN')
      await lockAbilityAvailabilityPackage(client, homeSpace, packageId)
      await assertAbilityTargetLive(client, homeSpace, null)
      await assertProjects(client, homeSpace, projectIds)
      const inserted = await client.query(
        `INSERT INTO ability_availability (home_space, package_id, mode, registry_note_id)
         VALUES ($1, $2, $3, NULL)
         ON CONFLICT(home_space, package_id) DO NOTHING
         RETURNING package_id`,
        [homeSpace, packageId, availability.mode],
      )

      if (inserted.rowCount === 1 && projectIds.length) {
        await client.query(
          `INSERT INTO ability_project_bindings (home_space, package_id, project_id)
           SELECT $1, $2, unnest($3::text[])`,
          [homeSpace, packageId, projectIds],
        )
      }
      await client.query('COMMIT')
      return inserted.rowCount === 1
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  finalize: async (homeSpace, packageId, actualNoteId) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockAbilityAvailabilityPackage(client, homeSpace, packageId)
      await assertAbilityTargetLive(client, homeSpace, actualNoteId)
      const updated = await client.query(
        `UPDATE ability_availability
            SET registry_note_id = $3
          WHERE home_space = $1 AND package_id = $2 AND registry_note_id IS NULL`,
        [homeSpace, packageId, actualNoteId],
      )
      await client.query('COMMIT')
      return updated.rowCount === 1
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  cancel: async (homeSpace, packageId) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockAbilityAvailabilityPackage(client, homeSpace, packageId)
      const removed = await client.query(
        `DELETE FROM ability_availability
          WHERE home_space = $1 AND package_id = $2 AND registry_note_id IS NULL`,
        [homeSpace, packageId],
      )
      await client.query('COMMIT')
      return removed.rowCount === 1
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  set: async (homeSpace, packageId, availability: AbilityAvailability, registryNoteId) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()
    const projectIds =
      availability.mode === ABILITY_AVAILABILITY_MODE.selectedProjects
        ? [...new Set(availability.projectIds)].sort()
        : []

    try {
      await client.query('BEGIN')
      await lockAbilityAvailabilityPackage(client, homeSpace, packageId)
      // Above L4f, and above the write: the ability this policy is ABOUT has to be
      // alive before the projects it binds are even read. The same fence, in the same
      // order, as the preferences facet next door.
      await assertAbilityTargetLive(client, homeSpace, registryNoteId ?? null)
      await assertProjects(client, homeSpace, projectIds)
      // The registry note is LEARNED, never forgotten: a caller that does not know it
      // (a host with no read-model barrier to ask) must not erase the key a caller
      // that did know it wrote, or the purge sweep silently falls back to the
      // pre-arbitration assumption for a row that had the answer.
      await client.query(
        `INSERT INTO ability_availability (home_space, package_id, mode, registry_note_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(home_space, package_id) DO UPDATE SET
           mode = excluded.mode,
           registry_note_id =
             COALESCE(excluded.registry_note_id, ability_availability.registry_note_id)`,
        [homeSpace, packageId, availability.mode, registryNoteId ?? null],
      )
      await client.query(
        'DELETE FROM ability_project_bindings WHERE home_space = $1 AND package_id = $2',
        [homeSpace, packageId],
      )
      if (projectIds.length) {
        await client.query(
          `INSERT INTO ability_project_bindings (home_space, package_id, project_id)
           SELECT $1, $2, unnest($3::text[])`,
          [homeSpace, packageId, projectIds],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  clear: async (homeSpace, packageId) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockAbilityAvailabilityPackage(client, homeSpace, packageId)
      await client.query(
        'DELETE FROM ability_project_bindings WHERE home_space = $1 AND package_id = $2',
        [homeSpace, packageId],
      )
      await client.query(
        'DELETE FROM ability_availability WHERE home_space = $1 AND package_id = $2',
        [homeSpace, packageId],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  grantProject: async (homeSpace, packageId, projectId, registryNoteId) => {
    await ctx.ensureInit()
    const client = await ctx.required.connect()

    try {
      await client.query('BEGIN')
      await lockAbilityAvailabilityPackage(client, homeSpace, packageId)
      await assertAbilityTargetLive(client, homeSpace, registryNoteId ?? null)
      await assertProjects(client, homeSpace, [projectId])
      const { mode } = await lockAbilityAvailabilityRow(client, homeSpace, packageId)

      if (mode !== ABILITY_AVAILABILITY_MODE.allProjects) {
        await client.query(
          `INSERT INTO ability_availability (home_space, package_id, mode, registry_note_id)
           VALUES ($1, $2, '${ABILITY_AVAILABILITY_MODE.selectedProjects}', $3)
           ON CONFLICT(home_space, package_id) DO UPDATE SET
             registry_note_id =
               COALESCE(excluded.registry_note_id, ability_availability.registry_note_id)`,
          [homeSpace, packageId, registryNoteId ?? null],
        )
        await client.query(
          `INSERT INTO ability_project_bindings (home_space, package_id, project_id)
           VALUES ($1, $2, $3)
           ON CONFLICT(home_space, package_id, project_id) DO NOTHING`,
          [homeSpace, packageId, projectId],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
})
