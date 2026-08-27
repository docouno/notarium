// The facet contract, run against every adapter shape that has to honour it: the
// real filesystem, a memory adapter that declares the same facets, one that
// declares only some, and one that declares none at all.
//
// The last two are the point. A contract that only ever meets a fully capable
// adapter cannot tell a promise from a coincidence — and the negative bundle is
// how "absent" stays a shape rather than a method that throws.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createLocalFsFiles } from '@notarium/engine'

import { describeFileStoreFacets } from './fileStoreFacets'
import { createMemoryFileStore } from './memoryFileStore'

const MEMORY_CAPABILITIES = [
  'exactRead',
  'resourceExport',
  'conditionalFileMutation',
  'entryIdentity',
  'fileNoReplaceMove',
  'directoryNoReplaceMove',
  'resourceObservation',
  'resourcePublication',
  'claimedRemoval',
  'packagePublication',
  'strictPublication',
  'watch',
] as const

// Physical-incarnation continuity is intentionally LocalFS-only. The memory
// adapter must not fake an inode/claim axis it cannot represent.
const LOCALFS_CAPABILITIES = [...MEMORY_CAPABILITIES, 'conditionalDirectoryMove'] as const

const ALL_ACCELERATORS = ['exactDirectorySpelling'] as const

describeFileStoreFacets(
  'LocalFS',
  {
    capabilities: LOCALFS_CAPABILITIES,
    accelerators: ALL_ACCELERATORS,
    strictRestartDurable: true,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'nt-facets-localfs-'))

    return {
      assembly: createLocalFsFiles(root),
      teardown: () => rm(root, { recursive: true, force: true }),
    }
  },
)

describeFileStoreFacets(
  'a memory adapter declaring every facet',
  {
    capabilities: MEMORY_CAPABILITIES,
    accelerators: ALL_ACCELERATORS,
    strictRestartDurable: false,
  },
  async () => ({
    assembly: createMemoryFileStore({
      exactRead: true,
      resourceExport: true,
      conditionalFileMutation: true,
      entryIdentity: true,
      fileNoReplaceMove: true,
      directoryNoReplaceMove: true,
      resourceObservation: true,
      resourcePublication: true,
      claimedRemoval: true,
      packagePublication: true,
      strictPublication: true,
      watch: true,
      exactDirectorySpelling: true,
    }),
  }),
)

describeFileStoreFacets(
  'a partial memory adapter declaring observation only',
  { capabilities: ['resourceObservation'], accelerators: [] },
  async () => ({
    assembly: createMemoryFileStore({ resourceObservation: true }),
  }),
)

describeFileStoreFacets(
  'an unsupported memory adapter declaring nothing at all',
  { capabilities: [], accelerators: [] },
  async () => ({
    assembly: createMemoryFileStore(),
  }),
)

describe('a partial adapter is partial in its SHAPE', () => {
  it('carries the facets it declared and nothing else', () => {
    const partial = createMemoryFileStore({ resourceObservation: true })

    expect(Object.keys(partial.capabilities)).toEqual(['resourceObservation'])
    expect(partial.accelerators).toEqual({})
    // Not a method that refuses — no method. A caller reads the absence off the
    // object at composition, and never discovers it inside an operation.
    expect(Object.hasOwn(partial.capabilities, 'resourcePublication')).toBe(false)
    expect(Object.hasOwn(partial.capabilities, 'claimedRemoval')).toBe(false)
  })

  it('performs the whole base contract with no capabilities at all', async () => {
    const bare = createMemoryFileStore()

    expect(bare.capabilities).toEqual({})
    await bare.base.write('note.md', 'body')
    await expect(bare.base.read('note.md')).resolves.toBe('body')
  })
})
