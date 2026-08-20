import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { parseAbilityLocator } from '@notarium/core'
import { parseSkillFile } from '@notarium/server'

import { buildCasesWorld } from './build'

const execFileAsync = promisify(execFile)

const SKILL_MOUNT = join('.notarium', 'skills')
/** The read-only inventory the stand ships with; a System preference row names a
 *  package from HERE, so its id has to be read off the same files the host reads. */
const BUNDLED_CATALOG = resolve('packages/server/src/services/roles/catalog')

/** Every package under one root, by its immutable directory name — the id a locator
 *  carries. Personal and a Space root are the same directory; a project's packages
 *  live one level down under `_projects/<id>`, and `recursive` reaches both. */
const packagesUnder = async (
  root: string,
): Promise<Map<string, ReturnType<typeof parseSkillFile>>> => {
  const found = new Map<string, ReturnType<typeof parseSkillFile>>()
  let entries: string[]

  try {
    entries = await readdir(root, { recursive: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.endsWith('SKILL.md')) {
      continue
    }
    const directoryName = dirname(entry).split(/[\\/]/u).pop()!
    found.set(
      directoryName,
      parseSkillFile(await readFile(join(root, entry), 'utf8'), directoryName),
    )
  }

  return found
}

describe('agent-roles real seed', () => {
  it('seeds exact role context and editable personal/project memory for the QA owner', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'notarium-agent-roles-seed-'))

    try {
      const { stdout } = await execFileAsync(
        resolve('node_modules/.bin/tsx'),
        ['scripts/seed.ts'],
        {
          cwd: resolve('.'),
          env: {
            ...process.env,
            AUTH_MODE: 'password',
            CASE: 'agent-roles',
            DATA_DIR: dataDir,
            NOW: '2026-08-15T12:00:00.000Z',
            PORT: '8793',
            SCALE: '1',
            SEED: 'agent-roles-test',
          },
          maxBuffer: 4 * 1024 * 1024,
        },
      )

      expect(stdout).toContain('"ok": true')
      expect(stdout).toContain('"scopePins": 8')
      const memoryRoot = join(dataDir, 'spaces', 'main', '.notarium', 'memory')
      const memoryFiles = (await readdir(memoryRoot, { recursive: true })).filter((entry) =>
        entry.endsWith('.md'),
      )
      expect(memoryFiles).toContain('release-preferences.md')
      const projectMemory = memoryFiles.find((entry) => entry.endsWith('/release-handoff.md'))
      expect(projectMemory).toBeTruthy()
      expect(await readFile(join(memoryRoot, projectMemory!), 'utf8')).toContain(
        'explicit release evidence before handoff',
      )
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  // `CASE=a,b` is the ordinary way a stand is built, and it is where a merge that
  // drops a world field stops being a unit-test abstraction: the skill fleet
  // disappears with its links, and the preference rows that address those skills
  // either point at nothing or abort the seed outright. Only a real seed of a real
  // combination shows which of the two happened.
  it('seeds a COMBINED abilities world with its skills and the preferences addressing them', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'notarium-abilities-merge-seed-'))
    // Expected FROM the merged world rather than from a number typed here: the point
    // is that the seeder publishes what the combination declares, and a hand-written
    // count would go stale the day the case grows a package.
    const combined = buildCasesWorld('agent-abilities-rich,trash-mixed', {
      now: '2026-08-15T12:00:00.000Z',
      scale: 1,
      seed: 'abilities-merge-test',
    })

    try {
      const { stdout } = await execFileAsync(
        resolve('node_modules/.bin/tsx'),
        ['scripts/seed.ts'],
        {
          cwd: resolve('.'),
          env: {
            ...process.env,
            AUTH_MODE: 'password',
            CASE: 'agent-abilities-rich,trash-mixed',
            DATA_DIR: dataDir,
            NOW: '2026-08-15T12:00:00.000Z',
            PORT: '8793',
            SCALE: '1',
            SEED: 'abilities-merge-test',
          },
          maxBuffer: 4 * 1024 * 1024,
        },
      )

      expect(stdout).toContain('"ok": true')
      // Every declared skill package published, and every owner Enable/Disable row
      // that addresses one written: a merge that drops the fleet either seeds a stand
      // silently missing it or aborts on the preference that points at nothing.
      expect(combined.agentSkills?.length).toBeGreaterThan(0)
      expect(combined.agentAbilityPreferences?.length).toBeGreaterThan(0)
      expect(stdout).toContain(`"agentSkills": ${combined.agentSkills?.length}`)
      expect(stdout).toContain(
        `"agentAbilityPreferences": ${combined.agentAbilityPreferences?.length}`,
      )

      // …and now what was WRITTEN, not how many rows the applier counted. The counter
      // above increments once per declaration whatever the row says, so inverting
      // `enabled` in the real applier left every assertion here green while the stand
      // it seeds served disabled abilities as enabled. The facet is sparse — a row
      // exists only for a DISABLED ability — so the rows are the state.
      const db = new DatabaseSync(join(dataDir, 'meta.db'), { readOnly: true })
      // A bundled package is addressed by the id its own manifest declares, not by its
      // directory — the same identity `bundledAbilityIdentityOf` reads.
      const bundled = new Map(
        [...(await packagesUnder(BUNDLED_CATALOG)).values()].map((parsed) => [
          parsed.metadata['notarium.package-id'],
          parsed,
        ]),
      )

      try {
        const spaces = db.prepare('SELECT id, slug FROM spaces').all() as Array<{
          id: string
          slug: string
        }>
        const packagesOf = new Map(
          await Promise.all(
            spaces.map(
              async ({ id, slug }) =>
                [id, await packagesUnder(join(dataDir, 'spaces', slug, SKILL_MOUNT))] as const,
            ),
          ),
        )
        const rows = db
          .prepare('SELECT owner, locator, updated_at FROM ability_preferences')
          .all() as Array<{ owner: string; locator: string; updated_at: string }>

        // Each row read back to the ability a HUMAN named in the case file: the owner,
        // the manifest name of the package the locator addresses, and the placement it
        // addresses it at — `shared-reviewer` exists at two, and only one is disabled.
        const written = rows.map((row) => {
          const locator = parseAbilityLocator(row.locator)

          if (!locator) {
            throw new Error(`ability preference row carries no locator: ${row.locator}`)
          }
          const parsed =
            locator.source === 'owned'
              ? packagesOf.get(locator.location.spaceId)?.get(locator.packageId)
              : bundled.get(locator.packageId)

          if (!parsed) {
            throw new Error(`ability preference names a package nothing published: ${row.locator}`)
          }

          return {
            owner: row.owner,
            source: locator.source,
            kind: locator.kind,
            name: parsed.name,
            scope: locator.source === 'owned' ? locator.location.scope : 'system',
            updatedAt: row.updated_at,
          }
        })
        // The catalog authors the owner as `sergey`; the real applier renames it to the
        // init user, so the row belongs to the login the stand actually hands out.
        const disabled = (combined.agentAbilityPreferences ?? []).filter(
          (preference) => !preference.enabled,
        )
        expect(disabled.length).toBeGreaterThan(0)
        expect([...written].sort((a, b) => a.name.localeCompare(b.name))).toEqual(
          disabled
            .map((preference) => ({
              owner: 'admin',
              source: preference.ability.source,
              kind: preference.ability.kind,
              name: preference.ability.name,
              scope:
                preference.ability.source === 'system'
                  ? 'system'
                  : preference.ability.kind === 'role'
                    ? preference.ability.target.kind
                    : preference.ability.home.kind,
              updatedAt: '2026-08-15T12:00:00.000Z',
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        )

        // The other half of the written state: a role the case placed in a PROJECT of
        // the owner's personal space, with a dependency. Personal is the root of that
        // space, so the Add has to install the supporting package in the personal
        // library and say so in the link. Seeded with no answer to "which space is
        // personal" the link came out `[[notarium-id:space:…]]` — an address
        // `ownedPlacementOf` refuses — and the stand still reported a healthy seed.
        const personal = packagesOf.get(spaces.find((space) => space.slug === 'main')!.id)!
        const projectRole = [...personal.values()].find(
          (parsed) => parsed.role && parsed.name === 'grooming',
        )
        expect(projectRole?.linkedSkills).toEqual([
          expect.objectContaining({
            kind: 'locator',
            source: 'owned',
            scope: 'personal',
            label: 'grooming-evidence',
          }),
        ])
        const dependency = projectRole!.linkedSkills[0]
        const installed = personal.get(dependency.kind === 'locator' ? dependency.packageId : '')
        // Named by the id the link carries rather than by the manifest name, which the
        // case deliberately renames — an exact link keeps resolving across a rename,
        // and a link that resolves to nothing is what the defect produced.
        expect(installed?.name).toBe('grooming-evidence-mine')
      } finally {
        db.close()
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})
