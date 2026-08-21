// The producer/consumer boundary itself: what an adapter hands its
// composition root, and what each consumer is granted out of it. The facet
// CONTRACTS — what each capability does when present — live with their owners;
// this file is only about shape, and about the two degradations that must not
// read as one: an absent capability refuses, an absent accelerator only costs.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createLocalFsFiles,
  createNodeSqliteDriver,
  engineMountOf,
  type FileStore,
  NotariumStore,
  resourceAuthorityAdapterOf,
} from '@notarium/engine'

import { baseOnlyAssembly, withFacets } from './fileStoreAssembly'

const roots: string[] = []

const mkroot = (name: string): string => {
  const root = mkdtempSync(join(tmpdir(), `notarium-assembly-${name}-`))

  roots.push(root)
  return root
}

const storeOn = (files: Parameters<typeof engineMountOf>[1]): NotariumStore =>
  new NotariumStore({
    mounts: [engineMountOf({ class: 'user-doc', prefix: '' }, files)],
    sql: createNodeSqliteDriver(':memory:'),
    integritySweepBatchSize: 0,
  })

describe('FileStoreAssembly — the producer boundary', () => {
  it('is not usable as the base port it carries', () => {
    const assembly = createLocalFsFiles(mkroot('shape'))
    const takesBase = (files: FileStore): FileStore => files

    // The nesting IS the boundary. If the aggregate were structurally a
    // FileStore, every consumer that asked for the port would silently receive
    // the whole registry of capabilities with it.
    // @ts-expect-error an assembly is not a base port
    takesBase(assembly)
    expect(Object.hasOwn(assembly, 'scan')).toBe(false)
    expect(Object.keys(assembly).sort()).toEqual(['accelerators', 'base', 'capabilities'])
  })

  it('composes with no capabilities at all and still performs the whole base contract', async () => {
    const root = mkroot('base-only')
    const declared = createLocalFsFiles(root)
    // Everything this deployment can do, and nothing more: the namespaces exist
    // and are empty. No stub methods, so nothing can throw ENOTSUP mid-operation.
    const assembly = baseOnlyAssembly(declared.base)

    expect(assembly.capabilities).toEqual({})
    expect(assembly.accelerators).toEqual({})

    const mount = engineMountOf({ class: 'user-doc', prefix: '' }, assembly)
    const authorityAdapter = resourceAuthorityAdapterOf({ id: 'notes', prefix: '' }, assembly)

    expect(mount.fileCapabilities).toEqual({})
    expect(mount.fileAccelerators).toEqual({})
    expect(Object.hasOwn(mount.fileCapabilities, 'exactRead')).toBe(false)
    expect(Object.hasOwn(mount.fileAccelerators, 'exactDirectorySpelling')).toBe(false)
    expect(authorityAdapter.capabilities).toEqual({})
    expect(Object.hasOwn(authorityAdapter.capabilities, 'resourceObservation')).toBe(false)
    expect(Object.hasOwn(authorityAdapter.capabilities, 'packagePublication')).toBe(false)

    const { base } = assembly

    await base.write('note.md', 'body')
    await expect(base.read('note.md')).resolves.toBe('body')
    await expect(base.exists('note.md')).resolves.toBe(true)
    expect((await base.stat('note.md'))?.size).toBe(4)
    expect((await base.scan()).map((entry) => entry.path)).toEqual(['note.md'])

    await expect(base.makeDir('folder')).resolves.toBe(true)
    await expect(base.dirExists('folder')).resolves.toBe(true)
    await expect(base.listDirs()).resolves.toEqual(['folder'])

    await base.rename('note.md', 'folder/note.md')
    await expect(base.read('folder/note.md')).resolves.toBe('body')
    await base.renameDir('folder', 'moved')
    await expect(base.read('moved/note.md')).resolves.toBe('body')

    await base.remove('moved/note.md')
    await expect(base.exists('moved/note.md')).resolves.toBe(false)
    await base.removeDir('moved')
    await expect(base.dirExists('moved')).resolves.toBe(false)
  })

  it('grants the note store its own facets and nothing the authority owns', () => {
    const mount = engineMountOf(
      { class: 'user-doc', prefix: '' },
      createLocalFsFiles(mkroot('mount-view')),
    )

    expect(Object.keys(mount.fileCapabilities).sort()).toEqual([
      'conditionalFileMutation',
      'directoryNoReplaceMove',
      'entryIdentity',
      'exactRead',
      'fileNoReplaceMove',
      'resourceExport',
      'watch',
    ])
    expect(Object.keys(mount.fileAccelerators)).toEqual(['exactDirectorySpelling'])
    // Physical-byte publication answers to the resource authority. Reachable from
    // a mount, it would be a second, unadmitted way to write the same bytes.
    expect(mount.fileCapabilities).not.toHaveProperty('resourcePublication')
    expect(mount.fileCapabilities).not.toHaveProperty('packagePublication')
    expect(mount.fileCapabilities).not.toHaveProperty('strictPublication')
  })

  it('grants the resource authority its own facets and nothing the note store owns', () => {
    const adapter = resourceAuthorityAdapterOf(
      { id: 'notes', prefix: '' },
      createLocalFsFiles(mkroot('authority-view')),
    )

    expect(Object.keys(adapter.capabilities).sort()).toEqual([
      'claimedRemoval',
      'packagePublication',
      'resourceExport',
      'resourceObservation',
      'resourcePublication',
      'strictPublication',
    ])
    // Moving a folder or rewriting a note is the store's business; the authority
    // owns bytes and admission, and cannot name either operation.
    expect(adapter.capabilities).not.toHaveProperty('directoryNoReplaceMove')
    expect(adapter.capabilities).not.toHaveProperty('conditionalFileMutation')
    expect(adapter.capabilities).not.toHaveProperty('watch')
  })

  it('keeps ordinary distinct-target moves available without entry identity', async () => {
    const root = mkroot('no-identity')

    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'note.md'), '---\ntitle: Note\n---\n\nbody')
    // The one thing `sameEntry` decides is the case/NFC-only exception. A medium
    // that cannot answer it must still move a note, and a folder, between two
    // pathnames that are plainly different.
    const store = storeOn(
      withFacets(createLocalFsFiles(root), { capabilities: { entryIdentity: undefined } }),
    )

    try {
      await store.list()
      const moved = await store.write({ originalId: 'docs/note.md', title: 'Renamed' })

      expect(moved.filePath).toBe('docs/renamed.md')
      await store.move({ id: 'docs', destinationPath: 'archive', isDirectory: true })
      expect((await store.list()).map((note) => note.filePath)).toEqual(['archive/renamed.md'])
    } finally {
      await store.stop()
    }
  })
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
