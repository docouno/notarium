import AdmZip from 'adm-zip'
import type { FastifyInstance } from 'fastify'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createServer } from '../../packages/server/src/apps/server/server'

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
  it('reads and writes roles through the configured skill directory', async () => {
    const notesDir = join(root, 'notes')
    const skillDir = join(root, 'custom-skill-library')
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
      pollIntervalMs: 0,
    })
    await app.ready()

    const added = await app.inject({
      method: 'POST',
      url: '/api/me/agent-roles',
      payload: { name: 'grooming', scope: 'personal' },
    })
    expect(added.statusCode).toBe(201)
    await expect(access(join(skillDir, 'grooming', 'SKILL.md'))).resolves.toBeUndefined()
    await expect(access(join(notesDir, '.notarium/skills/grooming/SKILL.md'))).rejects.toThrow()
    await mkdir(join(skillDir, 'grooming', 'scripts'), { recursive: true })
    await mkdir(join(skillDir, 'grooming', 'assets'), { recursive: true })
    await mkdir(join(skillDir, 'grooming', 'references'), { recursive: true })
    await writeFile(join(skillDir, 'grooming', 'scripts', 'run.sh'), '#!/bin/sh\necho copied\n')
    await writeFile(
      join(skillDir, 'grooming', 'references', 'guide.md'),
      '# Guide\n\nSupporting evidence.\n',
    )
    const binary = Buffer.from([0, 1, 2, 255])
    await writeFile(join(skillDir, 'grooming', 'assets', 'template.bin'), binary)

    const listed = await app.inject({ method: 'GET', url: '/api/me/agent-roles' })
    expect(listed.json().roles).toEqual([
      expect.objectContaining({ name: 'grooming', scope: 'personal' }),
    ])

    const defaultExport = await app.inject({ method: 'GET', url: '/api/s/main/export' })
    expect(defaultExport.statusCode).toBe(200)
    expect(
      new AdmZip(defaultExport.rawPayload)
        .getEntries()
        .some((entry) => entry.entryName.startsWith('.roles-library/')),
    ).toBe(false)

    const fullExport = await app.inject({
      method: 'GET',
      url: '/api/s/main/export?scope=all',
    })
    expect(fullExport.statusCode).toBe(200)
    const zip = new AdmZip(fullExport.rawPayload)

    for (const member of [
      'SKILL.md',
      'references/guide.md',
      'scripts/run.sh',
      'assets/template.bin',
    ]) {
      expect(zip.readFile(`.roles-library/grooming/${member}`)).toEqual(
        await readFile(join(skillDir, 'grooming', member)),
      )
    }

    const strippedExport = await app.inject({
      method: 'GET',
      url: '/api/s/main/export?scope=all&frontmatter=strip',
    })
    const stripped = new AdmZip(strippedExport.rawPayload)

    for (const member of [
      'SKILL.md',
      'references/guide.md',
      'scripts/run.sh',
      'assets/template.bin',
    ]) {
      expect(stripped.readFile(`.roles-library/grooming/${member}`)).toEqual(
        await readFile(join(skillDir, 'grooming', member)),
      )
    }
  })
})
