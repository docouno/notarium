import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FIELD_SCHEMA_MAX_BYTES } from '@notarium/core'

import { FIELD_SCHEMA_STATUS } from './consts'
import { createFieldSchemaStore, createInMemoryFieldSchemaStore } from './fieldSchemaStore'

describe('field schema store over localfs claims', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'notarium-fields-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('CAS-protects the first create and returns the fresh token for the next write', async () => {
    const store = createFieldSchemaStore((space) => (space === 's1' ? root : null))
    const empty = await store.read('s1')

    expect(empty).toMatchObject({
      version: 1,
      fields: [],
      status: FIELD_SCHEMA_STATUS.ready,
    })
    expect(empty.readOnly).toBeUndefined()
    const updates = await Promise.all([
      store.update('s1', {
        version: 1,
        fields: [{ key: 'status', type: 'text' }],
        versionToken: empty.versionToken,
      }),
      store.update('s1', {
        version: 1,
        fields: [{ key: 'owner', type: 'text' }],
        versionToken: empty.versionToken,
      }),
    ])
    expect(updates.filter((result) => result.status === 'saved')).toHaveLength(1)
    expect(updates.filter((result) => result.status === 'conflict')).toHaveLength(1)

    const saved = updates.find((result) => result.status === 'saved')!
    const second = await store.update('s1', {
      version: 1,
      fields: [{ key: 'priority', type: 'number' }],
      versionToken: saved.current.versionToken,
    })
    expect(second.status).toBe('saved')
    if (second.status !== 'saved') {
      throw new Error('second field schema write did not save')
    }
    const stale = await store.update('s1', {
      version: 1,
      fields: [{ key: 'stale', type: 'text' }],
      versionToken: saved.current.versionToken,
    })
    expect(stale).toMatchObject({ status: 'conflict', reason: 'field_schema_conflict' })
    expect(await readFile(join(root, '.notarium/fields/schema.yaml'), 'utf8')).toContain(
      'key: priority',
    )
  })

  it('detects an external same-size rewrite rather than serving a cached schema', async () => {
    const dir = join(root, '.notarium/fields')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'schema.yaml')
    await writeFile(path, 'version: 1\nfields:\n  - key: slate\n    type: text\n')
    const store = createFieldSchemaStore(() => root)
    const first = await store.read('s1')

    await writeFile(path, 'version: 1\nfields:\n  - key: amber\n    type: text\n')
    const second = await store.read('s1')
    expect(first.fields[0].key).toBe('slate')
    expect(second.fields[0].key).toBe('amber')
    expect(second.versionToken).not.toBe(first.versionToken)
  })

  it('reports occupied and oversized resources as read-only errors', async () => {
    const dir = join(root, '.notarium/fields')
    await mkdir(join(dir, 'schema.yaml'), { recursive: true })
    const store = createFieldSchemaStore(() => root)
    const occupied = await store.read('s1')

    expect(occupied.readOnly).toBe(true)
    expect(occupied.status).toBe(FIELD_SCHEMA_STATUS.unavailable)
    expect(occupied.error).toContain('directory')

    await rm(join(dir, 'schema.yaml'), { recursive: true })
    await writeFile(join(dir, 'schema.yaml'), 'x'.repeat(FIELD_SCHEMA_MAX_BYTES + 1))
    const oversized = await store.read('s1')
    expect(oversized.readOnly).toBe(true)
    expect(oversized.status).toBe(FIELD_SCHEMA_STATUS.unavailable)
    expect(oversized.error).toContain('too large')
  })

  it('drops a poisoned adapter so a repaired parent is readable without a restart', async () => {
    const dir = join(root, '.notarium/fields')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'schema.yaml'), 'version: 1\nfields: []\n')
    const store = createFieldSchemaStore(() => root)

    await chmod(dir, 0o000)
    try {
      const failed = await store.read('s1')
      expect(failed.readOnly).toBe(true)
      expect(failed.error).toContain('could not be read')
    } finally {
      await chmod(dir, 0o755)
    }

    const repaired = await store.read('s1')
    expect(repaired).toMatchObject({ version: 1, fields: [] })
    expect(repaired.readOnly).toBeUndefined()
  })

  it('refuses a PUT that would make its own document unreadable and preserves the file', async () => {
    const store = createFieldSchemaStore(() => root)
    const empty = await store.read('s1')
    const first = await store.update('s1', {
      version: 1,
      fields: [{ key: 'status', type: 'text' }],
      versionToken: empty.versionToken,
    })

    expect(first.status).toBe('saved')
    if (first.status !== 'saved') {
      throw new Error('first field schema write did not save')
    }
    const before = await readFile(join(root, '.notarium/fields/schema.yaml'), 'utf8')
    const tooLarge = await store.update('s1', {
      version: 1,
      fields: [{ key: 'status', type: 'text', label: 'x'.repeat(FIELD_SCHEMA_MAX_BYTES) }],
      versionToken: first.current.versionToken,
    })

    expect(tooLarge.status).toBe('invalid')
    expect(await readFile(join(root, '.notarium/fields/schema.yaml'), 'utf8')).toBe(before)
  })

  it('serves a newer document read-only and never rewrites its bytes', async () => {
    const dir = join(root, '.notarium/fields')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'schema.yaml')
    const before = 'version: 999\nfuture: keep\nfields:\n  - key: status\n    type: text\n'
    await writeFile(path, before)
    const store = createFieldSchemaStore(() => root)
    const current = await store.read('s1')

    expect(current).toMatchObject({
      version: 999,
      fields: [{ key: 'status', type: 'text' }],
      status: FIELD_SCHEMA_STATUS.futureVersion,
      readOnly: true,
    })
    const refused = await store.update('s1', {
      version: 1,
      fields: [{ key: 'other', type: 'text' }],
      versionToken: current.versionToken,
    })
    expect(refused).toMatchObject({ status: 'conflict', reason: 'field_schema_read_only' })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it.each([
    ['localfs', () => createFieldSchemaStore(() => root)],
    ['memory', () => createInMemoryFieldSchemaStore()],
  ])('rejects an invalid direct update consistently in %s', async (_name, create) => {
    const store = create()
    const current = await store.read('s1')
    const result = await store.update('s1', {
      version: 1,
      versionToken: current.versionToken,
      fields: [
        { key: 'first', type: 'text', label: 'Same' },
        { key: 'second', type: 'text', label: ' same ' },
      ],
    })

    expect(result.status).toBe('invalid')
    store.clear('s1')
    expect(await store.read('s1')).toMatchObject({ fields: [] })
  })

  it('advances the in-memory CAS token after updating a seeded raw document', async () => {
    const store = createInMemoryFieldSchemaStore()

    store.seedRaw('s1', 'version: 1\nfields:\n  - key: status\n    type: text\n')
    const before = await store.read('s1')
    const saved = await store.update('s1', {
      version: 1,
      versionToken: before.versionToken,
      fields: [{ key: 'owner', type: 'text' }],
    })

    expect(saved.status).toBe('saved')
    if (saved.status !== 'saved') {
      throw new Error('raw schema update did not save')
    }
    expect(saved.current.versionToken).not.toBe(before.versionToken)
    await expect(
      store.update('s1', {
        version: 1,
        versionToken: before.versionToken,
        fields: [{ key: 'stale', type: 'text' }],
      }),
    ).resolves.toMatchObject({ status: 'conflict', reason: 'field_schema_conflict' })
  })
})
