import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { frontmatterValue, parseAbilityLocator } from '@notarium/core'
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
      expect(stdout).toContain('"scopePins": 10')
      expect(stdout).toContain('"agentRoleMoves": 1')
      const db = new DatabaseSync(join(dataDir, 'meta.db'), { readOnly: true })

      try {
        const rows = db
          .prepare(
            `SELECT from_locator, to_locator, registry_note_id, manifest_note_id
               FROM ability_placement_trail`,
          )
          .all() as Array<{
          from_locator: string
          to_locator: string
          registry_note_id: string
          manifest_note_id: string
        }>
        expect(rows).toHaveLength(1)
        const from = parseAbilityLocator(rows[0].from_locator)
        const to = parseAbilityLocator(rows[0].to_locator)

        if (
          from?.source !== 'owned' ||
          from.kind !== 'role' ||
          from.location.scope !== 'project' ||
          to?.source !== 'owned' ||
          to.kind !== 'role' ||
          to.location.scope !== 'space'
        ) {
          throw new Error('seeded placement trail does not carry one Project→Space Role move')
        }

        expect(from).toMatchObject({
          source: 'owned',
          kind: 'role',
          location: { scope: 'project' },
        })
        expect(to).toMatchObject({
          source: 'owned',
          kind: 'role',
          packageId: from.packageId,
          location: { scope: 'space', spaceId: from.location.spaceId },
        })
        expect(rows[0].registry_note_id).toBe(rows[0].manifest_note_id)
        const targetId = `space:${encodeURIComponent(to.location.spaceId)}:${to.packageId}`
        const sourceId = `project:${encodeURIComponent(from.location.projectId)}:${from.packageId}`

        for (const table of ['context_set_attachments', 'context_scope_pins', 'context_order']) {
          expect(
            Number(
              (
                db
                  .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE target_id = ?`)
                  .get(targetId) as { count: number }
              ).count,
            ),
          ).toBeGreaterThan(0)
          expect(
            Number(
              (
                db
                  .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE target_id = ?`)
                  .get(sourceId) as { count: number }
              ).count,
            ),
          ).toBe(0)
        }
        expect(
          Number(
            (
              db
                .prepare('SELECT COUNT(*) AS count FROM ability_preferences WHERE locator = ?')
                .get(rows[0].to_locator) as { count: number }
            ).count,
          ),
        ).toBe(1)
        expect(
          Number(
            (
              db
                .prepare('SELECT COUNT(*) AS count FROM agent_sessions WHERE role_locator = ?')
                .get(rows[0].to_locator) as { count: number }
            ).count,
          ),
        ).toBeGreaterThan(0)
      } finally {
        db.close()
      }
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
        // Owner rows key by the stable id the seed minted for the init user.
        const admin = db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get() as {
          id: string
        }
        expect([...written].sort((a, b) => a.name.localeCompare(b.name))).toEqual(
          disabled
            .map((preference) => ({
              owner: admin.id,
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
        const mainSpaceId = spaces.find((space) => space.slug === 'main')!.id
        const personal = packagesOf.get(mainSpaceId)!
        const projectRolePackage = [...personal].find(
          ([, parsed]) => parsed.role && parsed.name === 'grooming',
        )
        const projectRole = projectRolePackage?.[1]
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

        // The published manifest and the identity row have to name the SAME note. A
        // PROJECT placement is the shape where they can diverge — the package lives
        // under the reserved `_projects/<encoded-project>` root instead of the library
        // root — and `notarium-id` is what a later rename, restore or exact locator
        // resolves against, so a manifest carrying a foreign id is a silent swap that
        // no count of published packages would show. Read off the real seeder, on the
        // seeded meta-DB this row already holds open.
        const roleIdentity = db
          .prepare(
            `SELECT id, file_path FROM note_identity
              WHERE space = ? AND file_path LIKE ? AND deleted_at IS NULL`,
          )
          .get(mainSpaceId, `%/${projectRolePackage![0]}/SKILL.md`) as
          { file_path: string; id: string } | undefined

        expect(roleIdentity?.file_path).toContain('_projects/')
        expect(roleIdentity?.file_path).toContain(`/${projectRolePackage![0]}/SKILL.md`)
        expect(
          frontmatterValue(
            await readFile(join(dataDir, 'spaces', 'main', roleIdentity!.file_path), 'utf8'),
            'notarium-id',
          ),
        ).toBe(roleIdentity?.id)
        const markdownPackage = [...personal].find(
          ([, parsed]) => parsed.name === 'markdown-package-proof',
        )
        const assetPackage = [...personal].find(
          ([, parsed]) => parsed.name === 'asset-package-proof',
        )

        expect(markdownPackage).toBeTruthy()
        expect(assetPackage).toBeTruthy()
        await expect(
          readFile(
            join(
              dataDir,
              'spaces/main',
              SKILL_MOUNT,
              markdownPackage![0],
              'references/checklist.md',
            ),
            'utf8',
          ),
        ).resolves.toContain('A restorable package member')
        await expect(
          readFile(
            join(dataDir, 'spaces/main', SKILL_MOUNT, assetPackage![0], 'assets/template.bin'),
            'utf8',
          ),
        ).resolves.toBe('seeded binary-shaped resource')

        const malformed = [...personal.values()].find(
          (parsed) => parsed.name === 'malformed-attachment-proof',
        )
        expect(malformed?.linkedSkills).toEqual([
          expect.objectContaining({ kind: 'invalid', reason: 'invalid-locator' }),
        ])
        const missing = [...personal.values()].find(
          (parsed) => parsed.name === 'missing-dependency-proof',
        )
        const missingLink = missing?.linkedSkills[0]
        expect(missingLink).toMatchObject({ kind: 'locator', label: 'deleted-dependency-proof' })
        expect(personal.has(missingLink?.kind === 'locator' ? missingLink.packageId : '')).toBe(
          false,
        )

        const oversized = [...personal].find(
          ([, parsed]) => parsed.name === 'agent-created-oversized-proof',
        )
        expect(oversized).toBeTruthy()
        const operation = db
          .prepare(
            `SELECT package_id, note_id, phase FROM ability_create_operations
              WHERE package_id = ?`,
          )
          .get(oversized![0]) as { package_id: string; note_id: string; phase: string }
        expect(operation.phase).toBe('succeeded')
        expect(
          (
            await readFile(
              join(dataDir, 'spaces/main', SKILL_MOUNT, operation.package_id, 'SKILL.md'),
              'utf8',
            )
          ).length,
        ).toBeGreaterThan(64 * 1024)
        const revision = db
          .prepare(
            `SELECT principal, agent_owner, agent_name, session_name, session_attach, entry_role,
                    kind, created_at, content_hash, semantic_fingerprint, restore_safety
               FROM note_revisions WHERE note_id = ?`,
          )
          .all(operation.note_id)
        expect(revision).toEqual([
          expect.objectContaining({
            // Both columns must name the SAME account: the principal's owner segment
            // is an id resolved through the account catalog, not a brand — a literal
            // here would pass while the row rendered as an unnamed agent.
            principal: `pat:${admin.id}:ability-author`,
            agent_owner: admin.id,
            agent_name: 'Seed ability author',
            session_name: 'Agent ability authoring',
            session_attach: 'declared',
            entry_role: 'origin',
          }),
        ])
        expect(
          db
            .prepare(
              `SELECT 1 FROM context_scope_pins AS pins
                JOIN folders ON folders.id = pins.target_id
               WHERE pins.note_id = ? AND folders.path = 'web'`,
            )
            .get(operation.note_id),
        ).toBeTruthy()
      } finally {
        db.close()
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})
