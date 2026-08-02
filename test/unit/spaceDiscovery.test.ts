// #126 re-clone discovery walk: readRootMarker reads a folder's root .notariummeta
// by path (before it has a registry id), and discoverSpaceFolders walks SPACES_ROOT
// for space roots carrying a `space` facet — skipping dot-dirs, non-dirs, excluded
// (config) dirs and facet-less folders. These are the file-truth half of the
// feature that the manager-level fake cannot exercise.

import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  discoverSpaceFolders,
  readRootMarker,
  serializeMarker,
} from '../../packages/server/src/services/projects'

const roots: string[] = []

const freshRoot = async () => {
  const r = await mkdtemp(join(tmpdir(), 'notarium-disc-'))
  roots.push(r)
  return r
}
afterAll(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
})

const spaceMarker = (id: string, slug: string, displayName?: string, aliases?: string[]) =>
  serializeMarker({
    id: 'rootProjAAA01',
    slug,
    ...(displayName ? { displayName } : {}),
    space: { id, slug, ...(aliases ? { aliases } : {}) },
  })

const mkSpaceDir = async (root: string, name: string, marker?: string) => {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  if (marker !== undefined) {
    await writeFile(join(dir, '.notariummeta'), marker, 'utf8')
  }

  return dir
}

describe('readRootMarker (#126)', () => {
  it('returns null when the marker is absent (ENOENT)', async () => {
    const root = await freshRoot()
    const dir = await mkSpaceDir(root, 'empty') // no marker written
    expect(await readRootMarker(dir)).toBeNull()
  })

  it('returns null on malformed JSON (treated as unmarked, fail-closed)', async () => {
    const root = await freshRoot()
    const dir = await mkSpaceDir(root, 'broken', '{ not json')
    expect(await readRootMarker(dir)).toBeNull()
  })

  it('parses a valid marker and exposes the space facet', async () => {
    const root = await freshRoot()
    const dir = await mkSpaceDir(root, 'work', spaceMarker('spaceWorkA01', 'work', 'Work'))
    const m = await readRootMarker(dir)
    expect(m?.space).toEqual({ id: 'spaceWorkA01', slug: 'work' })
    expect(m?.displayName).toBe('Work')
  })
})

describe('discoverSpaceFolders (#126)', () => {
  it('yields only real space roots: skips dot-dirs, non-space folders, files', async () => {
    const root = await freshRoot()
    await mkSpaceDir(root, 'work', spaceMarker('spaceWorkA01', 'work', 'Work'))
    await mkSpaceDir(root, 'docs', spaceMarker('spaceDocsB02', 'docs'))
    await mkSpaceDir(root, '.notarium', spaceMarker('spaceHiddenX', 'hidden')) // dot-dir → skipped
    await mkSpaceDir(root, 'strayfolder') // no marker → skipped
    await mkSpaceDir(root, 'projectonly', serializeMarker({ id: 'projOnlyAA01', slug: 'p' })) // marker w/o space facet → skipped
    await writeFile(join(root, 'loose.md'), '# not a dir', 'utf8') // file → skipped

    const hits = await discoverSpaceFolders(root)
    expect(hits.map((h) => h.notesDir)).toEqual(['docs', 'work']) // sorted, only space roots
    expect(hits.find((h) => h.notesDir === 'work')).toMatchObject({
      facet: { id: 'spaceWorkA01', slug: 'work' },
      displayName: 'Work',
    })
  })

  it('honours the exclude predicate (config dirs adopt via their own path)', async () => {
    const root = await freshRoot()
    const mainDir = await mkSpaceDir(root, 'main', spaceMarker('spaceMainA01', 'main'))
    await mkSpaceDir(root, 'work', spaceMarker('spaceWorkA01', 'work'))
    const excluded = new Set([resolve(mainDir)])
    const hits = await discoverSpaceFolders(root, (abs) => excluded.has(abs))
    expect(hits.map((h) => h.notesDir)).toEqual(['work']) // 'main' excluded
  })

  it('returns [] for a missing SPACES_ROOT (a fresh host), never throws', async () => {
    const hits = await discoverSpaceFolders(join(tmpdir(), 'notarium-does-not-exist-126'))
    expect(hits).toEqual([])
  })

  it('does not follow a symlinked child directory (no escape)', async () => {
    const root = await freshRoot()
    const realSpace = await mkSpaceDir(
      await freshRoot(),
      'outside',
      spaceMarker('spaceOutA001', 'outside'),
    )
    await symlink(realSpace, join(root, 'linked'), 'dir')
    const hits = await discoverSpaceFolders(root)
    expect(hits).toEqual([]) // the symlinked dir is not enumerated as a directory
  })

  it('carries the alias history from the facet', async () => {
    const root = await freshRoot()
    await mkSpaceDir(root, 'work', spaceMarker('spaceWorkA01', 'work', 'Work', ['oldwork']))
    const hits = await discoverSpaceFolders(root)
    expect(hits[0].facet.aliases).toEqual(['oldwork'])
  })
})
