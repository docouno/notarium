import AdmZip from 'adm-zip'
import type { FastifyInstance } from 'fastify'
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renameNoReplaceIfAvailable } from '@notarium/engine'
import { createServer } from '../../packages/server/src/apps/server/server'
import { SYSTEM_PRINCIPAL } from '../../packages/server/src/services/authz'
import {
  createFsRoleLibrary,
  createRolesService,
  inMemoryAbilityPersistence,
  type SkillPackage,
} from '../../packages/server/src/services/roles'
import { describeAtomicPublish } from '../role-library-contract/atomicPublishGate'
import { writableLibrary } from '../roleLibraryComposition'

let root: string
let app: FastifyInstance | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-role-mount-'))
})

afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('createServer — configured role mount', () => {
  describeAtomicPublish('a package published into the configured skill directory', () => {
    let notesDir: string
    let skillDir: string
    let directoryName: string
    let manifest: string

    /** The mount under test: packages live in their OWN directory, addressed by the
     *  space through a `skill`-class prefix that is not under `notesDir`. */
    const boot = async () => {
      notesDir = join(root, 'notes')
      skillDir = join(root, 'custom-skill-library')
      app = await createServer({
        spaces: [
          {
            slug: 'main',
            engine: 'notarium',
            notesDir,
            mounts: [
              { class: 'user-doc', dir: notesDir, prefix: '' },
              {
                class: 'agent-memory',
                dir: join(notesDir, '.notarium/memory'),
                prefix: '.notarium/memory',
              },
              {
                class: 'profile',
                dir: join(notesDir, '.notarium/profile'),
                prefix: '.notarium/profile',
              },
              { class: 'skill', dir: skillDir, prefix: '.roles-library' },
            ],
          },
        ],
        metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
        authMode: 'none',
        engineDataDir: join(root, 'engine'),
        jobsDataDir: join(root, 'jobs'),
        importStagingDir: join(root, 'jobs', 'imports'),
        pollIntervalMs: 10,
        replayKeyring: {
          path: join(root, 'replay-keys'),
          topology: 'canonical-local',
        },
      })
      await app.ready()
    }

    /** One Add of the bundled `grooming` template, located by the manifest it wrote:
     *  the directory name is a minted id, so nothing in the test may spell it. */
    const publishGrooming = async () => {
      const added = await app!.inject({
        method: 'POST',
        url: '/api/me/agent-roles',
        payload: { name: 'grooming', scope: 'personal' },
      })
      expect(added.statusCode, added.body).toBe(201)
      const found = (
        await Promise.all(
          (await readdir(skillDir)).map(async (entry) => ({
            directoryName: entry,
            manifest: await readFile(join(skillDir, entry, 'SKILL.md'), 'utf8'),
          })),
        )
      ).find((entry) => entry.manifest.includes('\nname: grooming\n'))!

      directoryName = found.directoryName
      manifest = found.manifest
    }

    /** The non-Markdown company a real package keeps: scripts, references, assets. */
    const addPackageResources = async () => {
      for (const folder of ['scripts', 'assets', 'references']) {
        await mkdir(join(skillDir, directoryName, folder), { recursive: true })
      }
      await writeFile(
        join(skillDir, directoryName, 'scripts', 'run.sh'),
        '#!/bin/sh\necho copied\n',
      )
      await writeFile(
        join(skillDir, directoryName, 'references', 'guide.md'),
        '# Guide\n\nSupporting evidence.\n',
      )
      await writeFile(
        join(skillDir, directoryName, 'assets', 'template.bin'),
        Buffer.from([0, 1, 2, 255]),
      )
    }

    /** The identity the scanner mints for one package member, once it has seen it. */
    const noteIdFor = async (member: string): Promise<string> => {
      const db = new DatabaseSync(join(root, 'meta.db'))
      let id = ''

      try {
        await vi.waitFor(async () => {
          const row = db
            .prepare(
              `SELECT id FROM note_identity
               WHERE file_path = ? AND deleted_at IS NULL`,
            )
            .get(`.roles-library/${directoryName}/${member}`) as { id: string } | undefined

          expect(row?.id).toBeDefined()
          id = row!.id
        })
      } finally {
        db.close()
      }

      return id
    }

    /** The identity the scanner mints for a package RESOURCE, once it has seen it. */
    const guideNoteId = async (): Promise<string> => {
      const db = new DatabaseSync(join(root, 'meta.db'))
      let id = ''

      try {
        await vi.waitFor(async () => {
          const row = db
            .prepare(
              `SELECT id FROM note_identity
               WHERE file_path = ? AND deleted_at IS NULL`,
            )
            .get(`.roles-library/${directoryName}/references/guide.md`) as
            { id: string } | undefined

          expect(row?.id).toBeDefined()
          id = row!.id
        })
      } finally {
        db.close()
      }

      return id
    }

    beforeEach(async () => {
      await boot()
      await publishGrooming()
    })

    it('deletes one auxiliary as one tombstone, whatever the auxiliary is named', async () => {
      // `<pkg>/references/SKILL.md` ends exactly like the package root and is not one.
      // Deleting it must not take the folder it sits in — the package is addressed by
      // its ROOT, and root-ness is a mount-relative question the engine already
      // answered when it built the row.
      await addPackageResources()
      await writeFile(
        join(skillDir, directoryName, 'references', 'SKILL.md'),
        '---\nname: nested\ndescription: Not a package root.\n---\n\n# Nested\n',
      )
      const guide = await guideNoteId()
      const nested = await noteIdFor(`references/SKILL.md`)

      const removed = await app!.inject({ method: 'DELETE', url: `/api/note?id=${nested}` })
      expect(removed.statusCode).toBe(200)

      // The sibling survives, and so does the manifest that really is the root.
      await expect(
        stat(join(skillDir, directoryName, 'references', 'guide.md')),
      ).resolves.toBeDefined()
      await expect(stat(join(skillDir, directoryName, 'SKILL.md'))).resolves.toBeDefined()
      const stillThere = await app!.inject({ method: 'GET', url: `/api/note?id=${guide}` })
      expect(stillThere.statusCode).toBe(200)
    })

    it('names the package directory by a minted id and mounts its manifest as a note', async () => {
      expect(directoryName).toMatch(/^[A-Za-z0-9_-]{12}$/)
      expect(manifest).toContain(`\nnotarium-id: ${directoryName}\n`)
      const roleNote = await app!.inject({
        method: 'GET',
        url: `/api/note?id=${encodeURIComponent(directoryName)}`,
      })

      expect(roleNote.statusCode).toBe(200)
      expect(roleNote.json()).toEqual(
        expect.objectContaining({
          id: directoryName,
          filePath: `.roles-library/${directoryName}/SKILL.md`,
        }),
      )
    })

    it('writes body and description through the common note route, in place', async () => {
      const roleNote = await app!.inject({
        method: 'GET',
        url: `/api/note?id=${encodeURIComponent(directoryName)}`,
      })
      const saved = await app!.inject({
        method: 'POST',
        url: '/api/note',
        payload: {
          originalId: directoryName,
          versionToken: roleNote.json().versionToken,
          directory: `.roles-library/${directoryName}`,
          content: '# Edited role\n\nUpdated instructions.\n',
          description: 'Renamed through typed skill metadata.',
        },
      })

      expect(saved.statusCode, saved.body).toBe(200)
      expect(saved.json().filePath).toBe(`.roles-library/${directoryName}/SKILL.md`)
      const written = await readFile(join(skillDir, directoryName, 'SKILL.md'), 'utf8')
      expect(written).toContain('\ndescription: Renamed through typed skill metadata.\n')
      expect(written).toContain('\n  notarium.kind: role\n')
      expect(written).toContain('Updated instructions.')
      const listed = await app!.inject({ method: 'GET', url: '/api/me/agent-roles' })
      expect(listed.json().items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'grooming',
            source: 'owned',
            locator: expect.objectContaining({
              source: 'owned',
              location: expect.objectContaining({ scope: 'personal' }),
            }),
          }),
        ]),
      )
    })

    it('never rekeys the package, whatever manifest name a save carries', async () => {
      // The manifest NAME is the package's machine key: locators, attachments and the
      // base a project version overrides are all matched by it. An ordinary note save
      // has no channel to rewrite it, so a payload that names one changes nothing —
      // not even when the name is taken, or not a legal name at all.
      await app!.inject({
        method: 'POST',
        url: '/api/me/agent-skills',
        payload: {
          name: 'custom-proof',
          description: 'A custom procedure.',
          instructions: '# Custom proof\n\nFollow the procedure.',
          scope: 'personal',
        },
      })

      for (const name of ['grooming-renamed', 'custom-proof', 'Invalid Skill']) {
        const roleNote = await app!.inject({
          method: 'GET',
          url: `/api/note?id=${encodeURIComponent(directoryName)}`,
        })
        const saved = await app!.inject({
          method: 'POST',
          url: '/api/note',
          payload: {
            originalId: directoryName,
            versionToken: roleNote.json().versionToken,
            content: `# Edited role\n\nSaved beside the name ${name}.\n`,
            name,
          },
        })

        expect(saved.statusCode, saved.body).toBe(200)
        await expect(
          readFile(join(skillDir, directoryName, 'SKILL.md'), 'utf8'),
        ).resolves.toContain('\nname: grooming\n')
      }
    })

    it('refuses a save that would move the manifest into another package', async () => {
      const roleNote = await app!.inject({
        method: 'GET',
        url: `/api/note?id=${encodeURIComponent(directoryName)}`,
      })
      const foreignDirectory = await app!.inject({
        method: 'POST',
        url: '/api/note',
        payload: {
          originalId: directoryName,
          versionToken: roleNote.json().versionToken,
          directory: '.roles-library/another-package',
          content: '# Edited role\n\nMust not land.\n',
        },
      })

      expect(foreignDirectory.statusCode).toBe(400)
      await expect(access(join(skillDir, directoryName, 'SKILL.md'))).resolves.toBeUndefined()
      // …and nothing leaked into the space's own notes directory either.
      await expect(access(join(notesDir, '.notarium/skills/grooming/SKILL.md'))).rejects.toThrow()
    })

    it('creates exactly one custom skill under a racing duplicate, readable at once', async () => {
      const customRequests = await Promise.all([
        app!.inject({
          method: 'POST',
          url: '/api/me/agent-skills',
          payload: {
            name: 'custom-proof',
            description: 'A custom procedure.',
            instructions: '# Custom proof\n\nFollow the procedure.',
            scope: 'personal',
          },
        }),
        app!.inject({
          method: 'POST',
          url: '/api/me/agent-skills',
          payload: {
            name: 'custom-proof',
            description: 'A racing duplicate.',
            instructions: '# Racing duplicate\n\nDo not overwrite the first package.',
            scope: 'personal',
          },
        }),
      ])

      expect(customRequests.map((response) => response.statusCode).sort()).toEqual([201, 409])
      const createdCustom = customRequests.find((response) => response.statusCode === 201)!
      const immediateCustomRead = await app!.inject({
        method: 'GET',
        url: `/api/note?id=${encodeURIComponent(createdCustom.json().skill.noteId as string)}`,
      })
      expect(immediateCustomRead.statusCode, immediateCustomRead.body).toBe(200)
    })

    it('creates a Space-wide custom skill with the reach it stated', async () => {
      const spaceCustom = await app!.inject({
        method: 'POST',
        url: '/api/me/agent-skills',
        payload: {
          name: 'space-proof',
          description: 'A space-wide custom procedure.',
          instructions: '# Space proof\n\nFollow this procedure in the selected space.',
          scope: 'space',
          space: 'main',
          availability: { mode: 'all-projects' },
        },
      })

      expect(spaceCustom.statusCode, spaceCustom.body).toBe(201)
      expect(spaceCustom.json().skill).toEqual(
        expect.objectContaining({
          name: 'space-proof',
          scope: 'space',
          space: 'main',
          availability: { mode: 'all-projects' },
        }),
      )
    })

    it('keeps the package out of the default export and ships it whole under scope=all', async () => {
      await addPackageResources()
      const defaultExport = await app!.inject({ method: 'GET', url: '/api/s/main/export' })

      expect(defaultExport.statusCode).toBe(200)
      expect(
        new AdmZip(defaultExport.rawPayload)
          .getEntries()
          .some((entry) => entry.entryName.startsWith('.roles-library/')),
      ).toBe(false)

      const members = ['SKILL.md', 'references/guide.md', 'scripts/run.sh', 'assets/template.bin']

      for (const url of [
        '/api/s/main/export?scope=all',
        // Stripping frontmatter is a Markdown transform, and a package is bytes: the
        // scripts and assets must come out identical either way.
        '/api/s/main/export?scope=all&frontmatter=strip',
      ]) {
        const archive = await app!.inject({ method: 'GET', url })
        expect(archive.statusCode).toBe(200)
        const zip = new AdmZip(archive.rawPayload)

        for (const member of members) {
          expect(zip.readFile(`.roles-library/${directoryName}/${member}`)).toEqual(
            await readFile(join(skillDir, directoryName, member)),
          )
        }
      }
    })

    it('registers a package resource as a note and keeps it inside its package', async () => {
      await addPackageResources()
      const guideId = await guideNoteId()
      const guideNote = await app!.inject({
        method: 'GET',
        url: `/api/note?id=${encodeURIComponent(guideId)}`,
      })

      expect(guideNote.statusCode, guideNote.body).toBe(200)
      const renamedGuide = await app!.inject({
        method: 'POST',
        url: '/api/note',
        payload: {
          originalId: guideId,
          versionToken: guideNote.json().versionToken,
          directory: `.roles-library/${directoryName}/references`,
          content: '# Renamed guide\n\nUpdated supporting evidence.\n',
        },
      })
      expect(renamedGuide.statusCode, renamedGuide.body).toBe(200)
      expect(renamedGuide.json().filePath).toBe(
        `.roles-library/${directoryName}/references/renamed-guide.md`,
      )
      const movedGuide = await app!.inject({
        method: 'POST',
        url: '/api/note',
        payload: {
          originalId: guideId,
          versionToken: renamedGuide.json().versionToken,
          directory: `.roles-library/${directoryName}/other`,
          content: '# Renamed guide\n\nMust not move.\n',
        },
      })
      expect(movedGuide.statusCode).toBe(400)
    })

    it('deletes the package with its resources, keeps neighbours, and restores its root', async () => {
      const neighbours = (await readdir(skillDir)).filter((entry) => entry !== directoryName)
      await addPackageResources()
      const guideId = await guideNoteId()
      const removed = await app!.inject({
        method: 'DELETE',
        url: `/api/note?id=${encodeURIComponent(directoryName)}`,
      })

      expect(removed.statusCode, removed.body).toBe(200)
      await expect(access(join(skillDir, directoryName))).rejects.toThrow()
      for (const neighbour of neighbours) {
        await expect(access(join(skillDir, neighbour, 'SKILL.md'))).resolves.toBeUndefined()
      }
      const trash = await app!.inject({ method: 'GET', url: '/api/s/main/trash' })
      expect(trash.statusCode, trash.body).toBe(200)
      expect(trash.json().items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ noteId: directoryName, class: 'skill' }),
          expect.objectContaining({ noteId: guideId, class: 'skill' }),
        ]),
      )
      const rootTombstone = trash
        .json()
        .items.find((item: { noteId: string }) => item.noteId === directoryName) as {
        revisionId: string
      }
      const restored = await app!.inject({
        method: 'POST',
        url: '/api/s/main/trash/restore',
        payload: {
          id: directoryName,
          revisionId: rootTombstone.revisionId,
          idempotencyKey: 'restore-role-package-root',
        },
      })
      expect(restored.statusCode, restored.body).toBe(200)
      expect(restored.json()).toMatchObject({
        status: 'succeeded',
        id: directoryName,
        filePath: `.roles-library/${directoryName}/SKILL.md`,
      })
      await expect(readFile(join(skillDir, directoryName, 'SKILL.md'), 'utf8')).resolves.toContain(
        '\nname: grooming\n',
      )
      // Restoring the ROOT restores the root. Each resource is its own note with its
      // own tombstone, so nothing comes back that the user did not ask for.
      await expect(
        access(join(skillDir, directoryName, 'references', 'guide.md')),
      ).rejects.toThrow()
      await expect(
        access(join(skillDir, directoryName, 'assets', 'template.bin')),
      ).rejects.toThrow()
    })
  })

  it.each(['duplicate', 'foreign-owner'] as const)(
    'keeps an ID-backed role addressable after a %s claim verdict',
    async (verdict) => {
      const notesDir = join(root, 'notes')
      const foreignNotesDir = join(root, 'foreign-notes')
      const skillDir = join(root, 'custom-skill-library')
      const metaDbPath = join(root, 'meta.db')
      const claimedId = 'BBBBBBBBBBBB'
      const ownerDir = verdict === 'duplicate' ? notesDir : foreignNotesDir

      await mkdir(ownerDir, { recursive: true })
      await writeFile(
        join(ownerDir, 'owner.md'),
        `---\nnotarium-id: ${claimedId}\n---\n# Existing owner\n\nOwned elsewhere.\n`,
      )
      const space = (slug: string, dir: string, rolesDir = join(dir, '.notarium/skills')) => ({
        slug,
        engine: 'notarium' as const,
        notesDir: dir,
        mounts: [
          { class: 'user-doc' as const, dir, prefix: '' },
          {
            class: 'agent-memory' as const,
            dir: join(dir, '.notarium/memory'),
            prefix: '.notarium/memory',
          },
          {
            class: 'profile' as const,
            dir: join(dir, '.notarium/profile'),
            prefix: '.notarium/profile',
          },
          { class: 'skill' as const, dir: rolesDir, prefix: '.roles-library' },
        ],
      })

      app = await createServer({
        spaces: [
          space('main', notesDir, skillDir),
          ...(verdict === 'foreign-owner' ? [space('foreign', foreignNotesDir)] : []),
        ],
        metaDbUrl: `sqlite:${metaDbPath}`,
        authMode: 'none',
        engineDataDir: join(root, 'engine'),
        jobsDataDir: join(root, 'jobs'),
        importStagingDir: join(root, 'jobs', 'imports'),
        pollIntervalMs: 10,
      })
      await app.ready()
      const ownerSpace = verdict === 'duplicate' ? 'main' : 'foreign'

      expect(
        (await app.inject({ method: 'GET', url: `/api/s/${ownerSpace}/notes` })).statusCode,
      ).toBe(200)
      await vi.waitFor(
        async () => {
          expect(
            (await app!.inject({ method: 'GET', url: `/api/note?id=${claimedId}` })).statusCode,
          ).toBe(200)
        },
        { timeout: 5_000 },
      )

      const ownedPackage: SkillPackage = {
        directoryName: claimedId,
        files: new Map([
          [
            'SKILL.md',
            Buffer.from(
              `---\nnotarium-id: ${claimedId}\nname: collision-role\ndescription: Exercises identity arbitration.\nmetadata:\n  notarium.kind: role\n---\n\nInstructions.\n`,
            ),
          ],
        ]),
      }
      const library = writableLibrary(
        createFsRoleLibrary({
          publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
          rootForSpace: () => skillDir,
        }),
      )
      const roles = createRolesService({
        ...inMemoryAbilityPersistence(),
        catalog: async () => [],
        ...library.deps,
      })

      await expect(
        library.putIfAbsent({ scope: 'personal', space: 'main' }, ownedPackage),
      ).resolves.toBe(true)
      expect((await app.inject({ method: 'GET', url: '/api/s/main/notes' })).statusCode).toBe(200)
      const roleDirectory = join(skillDir, claimedId)
      await expect(readFile(join(roleDirectory, 'SKILL.md'), 'utf8')).resolves.toContain(
        '\nname: collision-role\n',
      )
      await expect(
        roles.listEffective({ personalSpace: 'main' }, SYSTEM_PRINCIPAL),
      ).resolves.toMatchObject({
        roles: [expect.objectContaining({ name: 'collision-role' })],
      })

      const db = new DatabaseSync(metaDbPath)
      let registryId = ''

      try {
        await vi.waitFor(
          async () => {
            const row = db
              .prepare(
                `SELECT id FROM note_identity
                 WHERE file_path = ? AND deleted_at IS NULL`,
              )
              .get(`.roles-library/${claimedId}/SKILL.md`) as { id: string } | undefined

            expect(row?.id).toBeDefined()
            registryId = row!.id
            const response = await app!.inject({
              method: 'GET',
              url: `/api/note?id=${encodeURIComponent(registryId)}`,
            })

            expect(response.statusCode).toBe(200)
            expect(response.json().filePath).toBe(`.roles-library/${claimedId}/SKILL.md`)
          },
          { timeout: 5_000 },
        )
      } finally {
        db.close()
      }
      expect(registryId).not.toBe(claimedId)
      const settledManifest = await readFile(join(roleDirectory, 'SKILL.md'), 'utf8')

      if (verdict === 'duplicate') {
        expect(settledManifest).toContain(`\nnotarium-id: ${claimedId}\n`)
      } else {
        expect(settledManifest).toContain(`\nnotarium-id: ${registryId}\n`)
      }
    },
    15_000,
  )
})
