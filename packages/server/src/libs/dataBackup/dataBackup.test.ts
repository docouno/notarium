import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type BackupLayout,
  createOnlineDataBackup,
  restoreDataBackup,
  verifyDataBackup,
} from './dataBackup'

const roots: string[] = []

const temp = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-backup-test-'))
  roots.push(root)
  return root
}

const layoutFor = (dataDir: string): BackupLayout => ({
  dataDir,
  metaDbPath: join(dataDir, 'meta.db'),
  spacesDir: join(dataDir, 'spaces'),
  jobsDir: join(dataDir, 'jobs'),
})

const replayKeyringFixture = async (
  keyringDir: string,
): Promise<{ keyId: string; hash: string }> => {
  const secret = Buffer.alloc(32, 0x2a)
  const keyId = `rk_${createHash('sha256')
    .update('notarium-replay-key-id\0')
    .update(secret)
    .digest('hex')
    .slice(0, 24)}`
  const key = Buffer.from(
    `${JSON.stringify({
      format: 'notarium-replay-key',
      formatVersion: 1,
      keyId,
      secret: secret.toString('base64url'),
    })}\n`,
  )
  const hash = `sha256:${createHash('sha256').update(key).digest('hex')}`

  await mkdir(join(keyringDir, 'keys'), { recursive: true })
  await writeFile(join(keyringDir, 'keys', `${keyId}.json`), key)
  await writeFile(
    join(keyringDir, 'active.json'),
    `${JSON.stringify({
      format: 'notarium-replay-key-pointer',
      formatVersion: 1,
      generation: 1,
      keyId,
      keyHash: hash,
    })}\n`,
  )
  return { keyId, hash }
}

const fixture = async (): Promise<{
  parent: string
  data: string
  archive: string
  db: DatabaseSync
}> => {
  const parent = await temp()
  const data = join(parent, 'source')
  const archive = join(parent, 'backup.zip')

  await mkdir(join(data, 'spaces', 'main', 'empty', 'nested'), { recursive: true })
  await mkdir(join(data, 'jobs', 'imports'), { recursive: true })
  await mkdir(join(data, 'jobs', 'imports', 'main'), { recursive: true })
  await mkdir(join(data, 'spaces', 'main', 'draft.part'), { recursive: true })
  await mkdir(join(data, 'spaces', 'main', '.notarium-fs-ops', 'strict-recovery'), {
    recursive: true,
  })
  await mkdir(
    join(data, 'spaces', 'main', 'notes', '.draft.install-550e8400-e29b-41d4-a716-446655440000'),
    { recursive: true },
  )
  await mkdir(
    join(
      data,
      'spaces',
      'main',
      '.notarium',
      'skills',
      '_projects',
      'cHJvamVjdA',
      '.AbCdefGhij_1.install-550e8400-e29b-41d4-a716-446655440000',
    ),
    { recursive: true },
  )
  await mkdir(join(data, 'spaces', 'main', '.notarium', 'skills', '.draft.install-authored'), {
    recursive: true,
  })
  await mkdir(join(data, 'spaces', 'main', '.notarium', 'skills', 'ready', 'assets'), {
    recursive: true,
  })
  await mkdir(
    join(
      data,
      'spaces',
      'main',
      '.notarium',
      'skills',
      'ready',
      'assets',
      '.draft.install-550e8400-e29b-41d4-a716-446655440000',
    ),
    { recursive: true },
  )
  await mkdir(join(data, 'engine'), { recursive: true })
  await writeFile(join(data, 'spaces', 'main', 'note.md'), '# Before\n')
  await writeFile(
    join(data, 'spaces', 'main', '.12345678-1234-1234-1234-123456789abc.tmp'),
    'atomic note temp',
  )
  await writeFile(join(data, 'jobs', 'imports', 'main', 'upload.import'), 'durable upload')
  await writeFile(join(data, 'jobs', 'imports', 'main', 'upload.import.part'), 'incomplete upload')
  await writeFile(join(data, 'spaces', 'main', 'model.part'), 'legitimate note attachment')
  await writeFile(join(data, 'spaces', 'main', 'draft.part', 'kept.md'), '# Kept\n')
  await writeFile(
    join(data, 'spaces', 'main', '.notarium-fs-ops', 'strict-recovery', 'candidate'),
    'restart-durable restore candidate',
  )
  await writeFile(
    join(
      data,
      'spaces',
      'main',
      'notes',
      '.draft.install-550e8400-e29b-41d4-a716-446655440000',
      'important.md',
    ),
    '# Legitimate note\n',
  )
  await writeFile(
    join(
      data,
      'spaces',
      'main',
      '.notarium',
      'skills',
      '_projects',
      'cHJvamVjdA',
      '.AbCdefGhij_1.install-550e8400-e29b-41d4-a716-446655440000',
      'SKILL.md',
    ),
    'partial package',
  )
  await writeFile(
    join(data, 'spaces', 'main', '.notarium', 'skills', '.draft.install-authored', 'kept.bin'),
    'authored resource',
  )
  await writeFile(
    join(
      data,
      'spaces',
      'main',
      '.notarium',
      'skills',
      'ready',
      'assets',
      '.12345678-1234-1234-1234-123456789abc.tmp',
    ),
    'authored package resource',
  )
  await writeFile(
    join(
      data,
      'spaces',
      'main',
      '.notarium',
      'skills',
      'ready',
      'assets',
      '.draft.install-550e8400-e29b-41d4-a716-446655440000',
      'resource.bin',
    ),
    'authored package directory',
  )
  await utimes(
    join(data, 'spaces', 'main', 'note.md'),
    new Date('2020-01-02T03:04:05.000Z'),
    new Date('2020-01-02T03:04:05.000Z'),
  )
  await writeFile(join(data, 'engine', 'main.db'), 'derived index')

  const db = new DatabaseSync(join(data, 'meta.db'))
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE probe (value TEXT NOT NULL)')
  db.prepare('INSERT INTO probe VALUES (?)').run('account-and-history')

  return { parent, data, archive, db }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('online data backup and restore', () => {
  it('backs up a live WAL database, retries a concurrent file write, and restores durable state', async () => {
    const source = await fixture()
    let changed = false
    let checkpoints = 0
    const result = await createOnlineDataBackup({
      layout: layoutFor(source.data),
      output: source.archive,
      quietMs: 0,
      checkpoint: async () => {
        checkpoints += 1
        if (checkpoints === 2) {
          await writeFile(join(source.data, 'spaces', 'main', 'note.md'), '# After\n')
          changed = true
        }
      },
    })

    expect(changed).toBe(true)
    expect(result.attempts).toBeGreaterThan(1)
    expect(result.manifest.omitted).toEqual(['data/engine'])
    expect(result.manifest.files.map((file) => file.path)).toContain(
      'data/jobs/imports/main/upload.import',
    )
    expect(result.manifest.files.map((file) => file.path)).not.toContain(
      'data/jobs/imports/main/upload.import.part',
    )
    expect(result.manifest.files.some((file) => file.path.startsWith('data/secret-keyring/'))).toBe(
      false,
    )
    expect(result.manifest.files.map((file) => file.path)).not.toContain(
      'data/spaces/main/.12345678-1234-1234-1234-123456789abc.tmp',
    )
    expect(result.manifest.files.map((file) => file.path)).not.toContain(
      'data/spaces/main/.notarium/skills/_projects/cHJvamVjdA/.AbCdefGhij_1.install-550e8400-e29b-41d4-a716-446655440000/SKILL.md',
    )
    expect(result.manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'data/spaces/main/model.part',
        'data/spaces/main/draft.part/kept.md',
        'data/spaces/main/.notarium-fs-ops/strict-recovery/candidate',
        'data/spaces/main/notes/.draft.install-550e8400-e29b-41d4-a716-446655440000/important.md',
        'data/spaces/main/.notarium/skills/.draft.install-authored/kept.bin',
        'data/spaces/main/.notarium/skills/ready/assets/.12345678-1234-1234-1234-123456789abc.tmp',
        'data/spaces/main/.notarium/skills/ready/assets/.draft.install-550e8400-e29b-41d4-a716-446655440000/resource.bin',
      ]),
    )

    // The writer remained open throughout the backup; a later source write is not
    // part of the already-published point-in-time archive.
    source.db.prepare('INSERT INTO probe VALUES (?)').run('after-backup')

    const verified = await verifyDataBackup({ input: source.archive })

    expect(verified.manifest.files).toEqual(result.manifest.files)
    expect(verified.bytes).toBeGreaterThan(0)

    const restored = join(source.parent, 'restored')
    await restoreDataBackup({
      layout: layoutFor(restored),
      input: source.archive,
    })

    expect(await readFile(join(restored, 'spaces', 'main', 'note.md'), 'utf8')).toBe('# After\n')
    expect(await readFile(join(restored, 'jobs', 'imports', 'main', 'upload.import'), 'utf8')).toBe(
      'durable upload',
    )
    await expect(
      readFile(join(restored, 'jobs', 'imports', 'main', 'upload.import.part')),
    ).rejects.toThrow(/ENOENT/)
    expect(await readFile(join(restored, 'spaces', 'main', 'model.part'), 'utf8')).toBe(
      'legitimate note attachment',
    )
    expect(await readFile(join(restored, 'spaces', 'main', 'draft.part', 'kept.md'), 'utf8')).toBe(
      '# Kept\n',
    )
    expect(
      await readFile(
        join(restored, 'spaces', 'main', '.notarium-fs-ops', 'strict-recovery', 'candidate'),
        'utf8',
      ),
    ).toBe('restart-durable restore candidate')
    expect(
      Math.abs(
        Math.trunc((await stat(join(restored, 'spaces', 'main', 'note.md'))).mtimeMs) -
          Math.trunc((await stat(join(source.data, 'spaces', 'main', 'note.md'))).mtimeMs),
      ),
    ).toBeLessThanOrEqual(1)
    await expect(readFile(join(restored, 'engine', 'main.db'))).rejects.toThrow(/ENOENT/)
    expect(await readdir(join(restored, 'spaces', 'main', 'empty', 'nested'))).toEqual([])

    const restoredDb = new DatabaseSync(join(restored, 'meta.db'), { readOnly: true })

    try {
      expect(restoredDb.prepare('SELECT value FROM probe').all()).toEqual([
        { value: 'account-and-history' },
      ])
      expect(restoredDb.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally {
      restoredDb.close()
      source.db.close()
    }
  })

  it('binds the SQLite snapshot and keyring to one stable installation generation', async () => {
    const source = await fixture()
    const keyringDir = join(source.data, 'replay-keyring')
    const active = await replayKeyringFixture(keyringDir)
    source.db.exec(`
      CREATE TABLE installation_generation (
        singleton INTEGER PRIMARY KEY,
        generation INTEGER NOT NULL,
        phase TEXT NOT NULL,
        active_key_id TEXT,
        active_hash TEXT,
        candidate_key_id TEXT,
        candidate_hash TEXT
      )
    `)
    source.db
      .prepare(
        `INSERT INTO installation_generation
          (singleton, generation, phase, active_key_id, active_hash,
           candidate_key_id, candidate_hash)
         VALUES (1, 1, 'active-installed', ?, ?, NULL, NULL)`,
      )
      .run(active.keyId, active.hash)
    const bundle = {
      generation: 1,
      keyId: active.keyId,
      activeHash: active.hash,
      candidateKeyId: null,
      candidateHash: null,
    }
    let renewals = 0
    let releases = 0
    const result = await createOnlineDataBackup({
      layout: { ...layoutFor(source.data), keyringDir },
      output: source.archive,
      quietMs: 0,
      checkpoint: async () => {},
      generationCut: async () => ({
        bundle,
        renew: async () => {
          renewals += 1
        },
        release: async () => {
          releases += 1
        },
      }),
    })

    expect(result.manifest.installationGeneration).toEqual(bundle)
    expect(result.manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'data/replay-keyring/active.json',
        `data/replay-keyring/keys/${active.keyId}.json`,
      ]),
    )
    expect(renewals).toBeGreaterThanOrEqual(3)
    expect(releases).toBe(1)
    await expect(verifyDataBackup({ input: source.archive })).resolves.toMatchObject({
      manifest: { installationGeneration: bundle },
    })

    const restored = join(source.parent, 'restored-generation')
    await restoreDataBackup({ layout: layoutFor(restored), input: source.archive })
    await expect(
      readFile(join(restored, 'replay-keyring', 'active.json'), 'utf8'),
    ).resolves.toContain(active.keyId)
    const mismatched = join(source.parent, 'generation-mismatch.zip')
    const zip = new AdmZip(source.archive)
    const manifest = JSON.parse(zip.readAsText('manifest.json')) as {
      installationGeneration: { activeHash: string }
    }
    manifest.installationGeneration.activeHash = `sha256:${'0'.repeat(64)}`
    zip.updateFile('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
    zip.writeZip(mismatched)
    await expect(verifyDataBackup({ input: mismatched })).rejects.toThrow(
      /key does not match the generation bundle/,
    )
    source.db.close()
  })

  it('rejects a checksum-valid ZIP whose payload differs from the manifest', async () => {
    const source = await fixture()
    await createOnlineDataBackup({
      layout: layoutFor(source.data),
      output: source.archive,
      quietMs: 0,
      checkpoint: async () => {},
    })
    source.db.close()

    const tampered = join(source.parent, 'tampered.zip')
    const zip = new AdmZip(source.archive)
    zip.updateFile('data/spaces/main/note.md', Buffer.from('# Tampered\n'))
    zip.writeZip(tampered)

    const target = join(source.parent, 'target')
    await expect(verifyDataBackup({ input: tampered })).rejects.toThrow(/manifest checksums/)
    await expect(restoreDataBackup({ layout: layoutFor(target), input: tampered })).rejects.toThrow(
      /manifest checksums/,
    )
    expect(await readdir(target)).toEqual([])
  })

  it('rejects an unmanifested transient payload instead of filtering it during restore', async () => {
    const source = await fixture()
    await createOnlineDataBackup({
      layout: layoutFor(source.data),
      output: source.archive,
      quietMs: 0,
      checkpoint: async () => {},
    })
    source.db.close()

    const tampered = join(source.parent, 'extra-transient.zip')
    const zip = new AdmZip(source.archive)
    zip.addFile('data/jobs/imports/unlisted.part', Buffer.from('must not be restored'))
    zip.writeZip(tampered)

    const target = join(source.parent, 'target')
    await expect(verifyDataBackup({ input: tampered })).rejects.toThrow(/manifest checksums/)
    await expect(restoreDataBackup({ layout: layoutFor(target), input: tampered })).rejects.toThrow(
      /manifest checksums/,
    )
    expect(await readdir(target)).toEqual([])
  })

  it('rejects a manifest that explicitly admits the provider credential keyring', async () => {
    const source = await fixture()
    await mkdir(join(source.data, 'secret-keyring', 'keys'), { recursive: true })
    await writeFile(
      join(source.data, 'secret-keyring', 'keys', 'ck_111111111111111111111111.json'),
      'must stay outside the archive',
    )
    const result = await createOnlineDataBackup({
      layout: layoutFor(source.data),
      output: source.archive,
      quietMs: 0,
      checkpoint: async () => {},
    })
    source.db.close()
    expect(result.manifest.files.some((file) => file.path.startsWith('data/secret-keyring/'))).toBe(
      false,
    )

    const payload = Buffer.from('credential-key-material')
    const path = 'data/secret-keyring/keys/ck_111111111111111111111111.json'
    const tampered = join(source.parent, 'credential-keyring.zip')
    const zip = new AdmZip(source.archive)
    const manifest = JSON.parse(zip.readAsText('manifest.json')) as {
      files: Array<{
        path: string
        size: number
        sha256: string
        mtimeMs: number
      }>
      directories: string[]
    }
    manifest.directories.push('data/secret-keyring', 'data/secret-keyring/keys')
    manifest.files.push({
      path,
      size: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
      mtimeMs: Date.now(),
    })
    zip.addFile(path, payload)
    zip.updateFile('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
    zip.writeZip(tampered)

    await expect(verifyDataBackup({ input: tampered })).rejects.toThrow(
      /must not contain the provider credential keyring/,
    )
    await expect(
      restoreDataBackup({
        layout: layoutFor(join(source.parent, 'credential-keyring-target')),
        input: tampered,
      }),
    ).rejects.toThrow(/must not contain the provider credential keyring/)
  })

  it('retries a DB-only concurrent commit and restores the committed row', async () => {
    const source = await fixture()
    let checkpoints = 0
    const result = await createOnlineDataBackup({
      layout: layoutFor(source.data),
      output: source.archive,
      quietMs: 100,
      checkpoint: async () => {
        checkpoints += 1
        if (checkpoints === 2) {
          source.db.prepare('INSERT INTO probe VALUES (?)').run('committed-during-backup')
        }
      },
    })

    expect(result.attempts).toBeGreaterThan(1)
    const restored = join(source.parent, 'restored-db-race')
    await restoreDataBackup({ layout: layoutFor(restored), input: source.archive })
    const db = new DatabaseSync(join(restored, 'meta.db'), { readOnly: true })

    try {
      expect(db.prepare('SELECT value FROM probe ORDER BY rowid').all()).toEqual([
        { value: 'account-and-history' },
        { value: 'committed-during-backup' },
      ])
    } finally {
      db.close()
      source.db.close()
    }
  })

  it('enforces the manifest directory set exactly', async () => {
    const source = await fixture()
    await createOnlineDataBackup({
      layout: layoutFor(source.data),
      output: source.archive,
      quietMs: 0,
      checkpoint: async () => {},
    })
    source.db.close()

    const missing = join(source.parent, 'missing-directory.zip')
    const missingZip = new AdmZip(source.archive)
    missingZip.deleteFile('data/spaces/main/empty/nested/')
    missingZip.writeZip(missing)
    await expect(verifyDataBackup({ input: missing })).rejects.toThrow(/manifest checksums/)

    const extra = join(source.parent, 'extra-directory.zip')
    const extraZip = new AdmZip(source.archive)
    extraZip.addFile('data/engine/', Buffer.alloc(0))
    extraZip.writeZip(extra)
    await expect(verifyDataBackup({ input: extra })).rejects.toThrow(/manifest checksums/)

    const alias = join(source.parent, 'alias-directory.zip')
    const aliasZip = new AdmZip(source.archive)
    aliasZip.addFile('data/aa/spaces/alias/', Buffer.alloc(0))
    aliasZip.writeZip(alias)
    const rawAlias = await readFile(alias)
    const canonicalName = Buffer.from('data/aa/spaces/alias/')
    const aliasedName = Buffer.from('data///spaces/alias/')

    for (
      let offset = rawAlias.indexOf(canonicalName);
      offset !== -1;
      offset = rawAlias.indexOf(canonicalName, offset + aliasedName.length)
    ) {
      aliasedName.copy(rawAlias, offset)
    }
    await writeFile(alias, rawAlias)
    await expect(verifyDataBackup({ input: alias })).rejects.toThrow(/unsafe ZIP entry path/)
  })

  it('reaches SQLite integrity_check after checksum-valid database corruption', async () => {
    const source = await fixture()
    await createOnlineDataBackup({
      layout: layoutFor(source.data),
      output: source.archive,
      quietMs: 0,
      checkpoint: async () => {},
    })
    source.db.close()

    const corrupt = join(source.parent, 'corrupt-db.zip')
    const zip = new AdmZip(source.archive)
    const payload = Buffer.from('not a sqlite database')
    const manifest = JSON.parse(zip.readAsText('manifest.json')) as {
      files: Array<{ path: string; size: number; sha256: string }>
    }
    const meta = manifest.files.find((file) => file.path === 'data/meta.db')!
    meta.size = payload.length
    meta.sha256 = createHash('sha256').update(payload).digest('hex')
    zip.updateFile('data/meta.db', payload)
    zip.updateFile('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
    zip.writeZip(corrupt)

    await expect(verifyDataBackup({ input: corrupt })).rejects.toThrow(/not a database|file is not/)
  })

  it('rejects unsafe source names and symlink roots before publishing', async () => {
    const source = await fixture()
    await writeFile(join(source.data, 'spaces', 'main', 'slash\\name.md'), '# Unsafe\n')
    await expect(
      createOnlineDataBackup({
        layout: layoutFor(source.data),
        output: source.archive,
        quietMs: 0,
        checkpoint: async () => {},
      }),
    ).rejects.toThrow(/cannot be represented safely/)
    await expect(stat(source.archive)).rejects.toThrow(/ENOENT/)

    await rm(join(source.data, 'spaces', 'main', 'slash\\name.md'))
    const outputAlias = join(source.parent, 'output-alias')
    await symlink(join(source.data, 'spaces'), outputAlias)
    await expect(
      createOnlineDataBackup({
        layout: layoutFor(source.data),
        output: join(outputAlias, 'backup.zip'),
        quietMs: 0,
        checkpoint: async () => {},
      }),
    ).rejects.toThrow(/outside DATA_DIR/)

    await rm(join(source.data, 'spaces'), { recursive: true })
    const outside = join(source.parent, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.md'), 'secret')
    await symlink(outside, join(source.data, 'spaces'))
    await expect(
      createOnlineDataBackup({
        layout: layoutFor(source.data),
        output: source.archive,
        quietMs: 0,
        checkpoint: async () => {},
      }),
    ).rejects.toThrow(/source root must be a real directory/)
    source.db.close()
  })

  it('bounds archive extraction resources', async () => {
    const source = await fixture()
    const producerLimited = join(source.parent, 'producer-limited.zip')
    await expect(
      createOnlineDataBackup({
        layout: layoutFor(source.data),
        output: producerLimited,
        quietMs: 0,
        checkpoint: async () => {},
        maxArchiveEntries: 1,
      }),
    ).rejects.toThrow(/resource limits/)
    await expect(stat(producerLimited)).rejects.toThrow(/ENOENT/)
    const byteLimited = join(source.parent, 'producer-byte-limited.zip')
    await expect(
      createOnlineDataBackup({
        layout: layoutFor(source.data),
        output: byteLimited,
        quietMs: 0,
        checkpoint: async () => {},
        maxArchiveBytes: 8,
      }),
    ).rejects.toThrow(/resource limits/)
    await expect(stat(byteLimited)).rejects.toThrow(/ENOENT/)
    const escapedMetadataLimited = join(source.parent, 'producer-metadata-limited.zip')
    const escapedPath = join(source.data, 'spaces', 'main', `${'\u0001'.repeat(180)}.md`)
    await writeFile(escapedPath, '# Escaped path\n')
    await expect(
      createOnlineDataBackup({
        layout: layoutFor(source.data),
        output: escapedMetadataLimited,
        quietMs: 0,
        checkpoint: async () => {},
        maxMetadataBytes: 4_000,
      }),
    ).rejects.toThrow(/metadata limits|resource limits/)
    await expect(stat(escapedMetadataLimited)).rejects.toThrow(/ENOENT/)
    await rm(escapedPath)

    await createOnlineDataBackup({
      layout: layoutFor(source.data),
      output: source.archive,
      quietMs: 0,
      checkpoint: async () => {},
    })
    source.db.close()

    await expect(verifyDataBackup({ input: source.archive, maxArchiveBytes: 128 })).rejects.toThrow(
      /resource limits/,
    )
    await expect(verifyDataBackup({ input: source.archive, maxArchiveEntries: 1 })).rejects.toThrow(
      /resource limits/,
    )
    await expect(
      verifyDataBackup({ input: source.archive, maxMetadataBytes: 128 }),
    ).rejects.toThrow(/resource limits|metadata limits/)
  })

  it('refuses restore over existing data', async () => {
    const source = await fixture()
    await createOnlineDataBackup({
      layout: layoutFor(source.data),
      output: source.archive,
      quietMs: 0,
      checkpoint: async () => {},
    })
    source.db.close()

    const target = join(source.parent, 'target')
    await mkdir(target)
    await writeFile(join(target, 'keep.txt'), 'do not touch')

    await expect(
      restoreDataBackup({ layout: layoutFor(target), input: source.archive }),
    ).rejects.toThrow(/fresh empty DATA_DIR/)
    await expect(
      restoreDataBackup({ layout: layoutFor(target), input: source.archive }),
    ).rejects.toThrow(/archive first, then place the matching secret-keyring/)
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('do not touch')

    const interrupted = join(source.parent, 'interrupted')
    await mkdir(join(interrupted, '.notarium-restore-abandoned'), { recursive: true })
    await expect(
      restoreDataBackup({ layout: layoutFor(interrupted), input: source.archive }),
    ).rejects.toThrow(/interrupted restore/)

    const outside = join(source.parent, 'outside-target')
    const targetAlias = join(source.parent, 'target-alias')
    await mkdir(outside)
    await symlink(outside, targetAlias)
    await expect(
      restoreDataBackup({ layout: layoutFor(targetAlias), input: source.archive }),
    ).rejects.toThrow(/target must be a real directory/)
    expect(await readdir(outside)).toEqual([])
  })
})
