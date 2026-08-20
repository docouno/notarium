import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createLocalFsFiles,
  type FileObservation,
  type FilePublicationRequest,
  type FileStore,
} from '../files'
import { SpaceResourceAuthorityRegistry } from './registry'
import type * as rootsModule from './roots'
import { preflightResourceRoots } from './roots'
import { SpaceResourceAuthority } from './spaceResourceAuthority'

/** Counts the physical root re-canonicalization — one `lstat` + `realpath` per mount
 *  root — so "the lease path does not pay the check twice" is measured rather than
 *  asserted about the source. */
const rootChecks = vi.hoisted(() => ({ count: 0 }))

vi.mock('./roots', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof rootsModule

  return {
    ...actual,
    assertCanonicalResourceRoot: (
      root: Parameters<typeof actual.assertCanonicalResourceRoot>[0],
    ) => {
      rootChecks.count++
      actual.assertCanonicalResourceRoot(root)
    },
  }
})

const roots: string[] = []

const mkroot = async (): Promise<string> => {
  const root = await fs.mkdtemp(join(tmpdir(), 'notarium-authority-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const present = (value: number, claim = String(value)): FileObservation => ({
  kind: 'present',
  bytes: Uint8Array.of(value),
  claim: { kind: 'present', value: `test:${claim}` },
  mtimeMs: value,
})

const observingStore = (observe: (path: string) => Promise<FileObservation>): FileStore =>
  ({ observe }) as FileStore

/** Public entries that TAKE a lease: the one place the lifecycle question is asked. */
const LEASE_GATES = ['admitResource', 'admitPackage', 'admitSkillPlacement'] as const

/** Public entries the caller enters under its OWN lease. They ask whether they were
 *  admitted, never whether the space is still accepting — the fence drains them. */
const ADMITTED_ENTRIES = [
  'assertSkillManifestNameAvailableAdmitted',
  'observeLinkedAdmitted',
  'observeStrictAdmitted',
  'publishAdmitted',
  'publishPackageIfAbsentAdmitted',
  'publishStrictAdmitted',
] as const

/** Everything else on the prototype: composed entries that reach one of the two
 *  above, pure queries, and the private helpers. Listed so that a NEW method cannot
 *  quietly belong to nothing. */
const NEITHER = [
  'assertAdmissible',
  'assertAdmitted',
  'assertRootsStable',
  'closeAdmission',
  'diagnostics',
  'discardStrict',
  'exportAdapter',
  'inspectStrict',
  'mapStrictHeader',
  'mapStrictPublication',
  'mapStrictReceipt',
  'mapStrictState',
  'observe',
  'observeAdmitted',
  'observeLinked',
  'publish',
  'publishPackageIfAbsent',
  'publishStrict',
  'removeClaimed',
  'reopenAdmission',
  'resourcePathContext',
  'route',
  'stageStrict',
  'supportsRestartDurableStrict',
] as const

/** One call per admitted entry, so "every admitted entry refuses an unadmitted call"
 *  is checked over the entries themselves rather than over a hand-picked three. */
const admittedEntryCalls = (
  authority: SpaceResourceAuthority,
): Record<(typeof ADMITTED_ENTRIES)[number], () => Promise<unknown>> => {
  const absent = { kind: 'absent' as const, value: 'test:absent' }

  return {
    assertSkillManifestNameAvailableAdmitted: () =>
      authority.assertSkillManifestNameAvailableAdmitted('pkg/SKILL.md', Uint8Array.of(1)),
    observeLinkedAdmitted: () =>
      authority.observeLinkedAdmitted('pkg/note.md', 'pkg/SKILL.md', () => true),
    observeStrictAdmitted: () => authority.observeStrictAdmitted('note.md'),
    publishAdmitted: () =>
      authority.publishAdmitted({
        kind: 'put',
        path: 'note.md',
        content: Uint8Array.of(1),
        expected: absent,
      }),
    publishPackageIfAbsentAdmitted: () =>
      authority.publishPackageIfAbsentAdmitted({
        rootPath: 'pkg',
        files: [{ path: 'SKILL.md', content: Uint8Array.of(1) }],
        expectedRoot: absent,
      }),
    publishStrictAdmitted: () =>
      authority.publishStrictAdmitted({ operationId: 'op', binding: 'binding', path: 'note.md' }),
  }
}

describe('SpaceResourceAuthority', () => {
  it('rejects ambiguous topology and non-canonical resource requests', async () => {
    const files = observingStore(async () => present(1))

    expect(() => new SpaceResourceAuthority('  ', [{ id: 'root', prefix: '', files }])).toThrow(
      'space id',
    )
    expect(() => new SpaceResourceAuthority('space', [])).toThrow('at least one adapter')
    expect(
      () =>
        new SpaceResourceAuthority('space', [
          { id: 'duplicate', prefix: '', files },
          { id: 'duplicate', prefix: 'skills', files },
        ]),
    ).toThrow('ids must be unique')
    expect(
      () =>
        new SpaceResourceAuthority('space', [
          { id: 'one', prefix: 'skills', files },
          { id: 'two', prefix: 'skills', files },
        ]),
    ).toThrow('prefixes must be unique')

    const authority = new SpaceResourceAuthority('space', [
      { id: 'skills', prefix: 'skills', files },
    ])

    for (const path of ['', '/note.md', 'note.md/', 'folder\\note.md', 'folder/../note.md']) {
      await expect(authority.observe(path)).rejects.toThrow('not canonical')
    }
    await expect(authority.observe('skills/note.md', { maxBytes: -1 })).rejects.toThrow('maxBytes')
    await expect(authority.observe('skills/note.md', { maxBytes: 1.5 })).rejects.toThrow('maxBytes')
    await expect(authority.observeStrictAdmitted('skills/note.md', -1)).rejects.toThrow('maxBytes')
    await expect(authority.observe('note.md')).rejects.toThrow('no resource adapter owns')
    await expect(authority.observe('skills')).rejects.toThrow('adapter root')
  })

  it('reports missing adapter capabilities instead of fabricating observations or proofs', async () => {
    const incapable = {} as FileStore
    const authority = new SpaceResourceAuthority('space', [
      { id: 'root', prefix: '', files: observingStore(async () => present(1)) },
      { id: 'skills', prefix: 'skills', files: incapable },
    ])
    const absent = { kind: 'absent' as const, value: 'test:absent' }

    await expect(authority.observe('skills/demo/SKILL.md')).rejects.toMatchObject({
      code: 'OBSERVATION_UNAVAILABLE',
    })
    await expect(authority.exportAdapter('missing')[Symbol.asyncIterator]().next()).rejects.toThrow(
      'no resource adapter',
    )
    await expect(
      authority.exportAdapter('skills')[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ code: 'EXPORT_UNAVAILABLE' })
    await expect(
      authority.publish({
        kind: 'put',
        path: 'skills/demo/SKILL.md',
        content: Uint8Array.of(1),
        expected: absent,
      }),
    ).rejects.toMatchObject({ code: 'PUBLICATION_UNAVAILABLE' })
    await expect(
      authority.publish({
        kind: 'move-put',
        sourcePath: 'note.md',
        targetPath: 'skills/demo/SKILL.md',
        content: Uint8Array.of(1),
        expectedSource: { kind: 'present', value: 'test:present' },
        expectedTarget: absent,
      }),
    ).rejects.toThrow('cannot cross resource adapters')
    await expect(
      authority.publishPackageIfAbsent({
        rootPath: 'skills/demo',
        files: [{ path: 'SKILL.md', content: Uint8Array.of(1) }],
        expectedRoot: absent,
      }),
    ).rejects.toMatchObject({ code: 'PACKAGE_PUBLICATION_UNAVAILABLE' })
    await expect(
      authority.stageStrict({
        operationId: 'op',
        binding: 'binding',
        path: 'skills/demo/SKILL.md',
        content: Uint8Array.of(1),
        expected: absent,
      }),
    ).rejects.toMatchObject({ code: 'STRICT_PUBLICATION_UNAVAILABLE' })
    await expect(
      authority.inspectStrict({
        operationId: 'op',
        binding: 'binding',
        path: 'skills/demo/SKILL.md',
      }),
    ).rejects.toMatchObject({ code: 'STRICT_PUBLICATION_UNAVAILABLE' })
    await expect(
      authority.discardStrict({
        operationId: 'op',
        binding: 'binding',
        path: 'skills/demo/SKILL.md',
      }),
    ).resolves.toBe(false)
  })

  it('rejects incomplete adapter proof sets and preserves explicit conflicts', async () => {
    const absent = { kind: 'absent' as const, value: 'test:absent' }
    const conflictStore = {
      publish: async () => ({ status: 'conflict', path: 'note.md', actual: absent }),
      publishPackageIfAbsent: async () => ({ status: 'conflict', path: 'pkg', actual: absent }),
    } as unknown as FileStore
    const conflictAuthority = new SpaceResourceAuthority('space', [
      { id: 'root', prefix: '', files: conflictStore },
    ])

    await expect(
      conflictAuthority.publish({
        kind: 'put',
        path: 'note.md',
        content: Uint8Array.of(1),
        expected: absent,
      }),
    ).resolves.toMatchObject({ status: 'conflict' })
    await expect(
      conflictAuthority.publishPackageIfAbsent({
        rootPath: 'pkg',
        files: [{ path: 'SKILL.md', content: Uint8Array.of(1) }],
        expectedRoot: absent,
      }),
    ).resolves.toMatchObject({ status: 'conflict' })

    const invalidStore = {
      publish: async () => ({
        status: 'published',
        candidateHash: 'a'.repeat(64),
        transitions: [],
      }),
      publishPackageIfAbsent: async () => ({
        status: 'published',
        candidateHash: 'a'.repeat(64),
        transitions: [],
      }),
    } as unknown as FileStore
    const invalidAuthority = new SpaceResourceAuthority('space', [
      { id: 'root', prefix: '', files: invalidStore },
    ])

    await expect(
      invalidAuthority.publish({
        kind: 'put',
        path: 'note.md',
        content: Uint8Array.of(1),
        expected: absent,
      }),
    ).rejects.toThrow('invalid publication proof set')
    await expect(
      invalidAuthority.publishPackageIfAbsent({
        rootPath: 'pkg',
        files: [{ path: 'SKILL.md', content: Uint8Array.of(1) }],
        expectedRoot: absent,
      }),
    ).rejects.toThrow('invalid package proof set')
  })

  it('closes fresh admission only after earlier work drains and reopens explicitly', async () => {
    const authority = new SpaceResourceAuthority('space', [
      { id: 'root', prefix: '', files: observingStore(async () => present(1)) },
    ])
    const active = await authority.admitResource('note.md', 'shared', 'accepted-before-close')
    let closed = false
    const closing = authority.closeAdmission().then(() => {
      closed = true
    })

    await expect(authority.admitResource('other.md', 'shared', 'fresh')).rejects.toMatchObject({
      code: 'SPACE_LIFECYCLE_CLOSED',
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(authority.diagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: 'accepted-before-close', state: 'active' }),
        expect.objectContaining({ owner: 'space-lifecycle-close', state: 'waiting' }),
      ]),
    )

    active.settle()
    await closing
    await expect(
      authority.admitResource('other.md', 'shared', 'still-closed'),
    ).rejects.toMatchObject({ code: 'SPACE_LIFECYCLE_CLOSED' })
    authority.reopenAdmission()
    const reopened = await authority.admitResource('other.md', 'shared', 'restored')
    reopened.settle()
  })

  it('routes through the longest mount prefix and returns an immutable buffered sample', async () => {
    const rootCalls: string[] = []
    const skillCalls: string[] = []
    const source = Uint8Array.of(7)
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        files: observingStore(async (path) => {
          rootCalls.push(path)
          return present(1)
        }),
      },
      {
        id: 'skills',
        prefix: '.notarium/skills',
        files: observingStore(async (path) => {
          skillCalls.push(path)
          return {
            kind: 'present',
            bytes: source,
            claim: { kind: 'present', value: 'skills:one' },
            mtimeMs: 1,
          }
        }),
      },
    ])

    const skill = await authority.observe('.notarium/skills/demo/SKILL.md')
    source[0] = 9
    const note = await authority.observe('note.md')

    expect(authority.resourcePathContext('.notarium/skills/demo/references/guide.md')).toEqual({
      adapterPrefix: '.notarium/skills',
      relativePath: 'demo/references/guide.md',
    })
    expect(skillCalls).toEqual(['demo/SKILL.md'])
    expect(rootCalls).toEqual(['note.md'])
    expect(skill.kind === 'present' ? skill.bytes : null).toEqual(Uint8Array.of(7))
    expect(note).toMatchObject({ spaceId: 'space', adapterId: 'root', path: 'note.md' })
  })

  it('serializes different package ids at the shared skill placement boundary', async () => {
    const authority = new SpaceResourceAuthority('space', [
      { id: 'skills', prefix: '.skills', files: observingStore(async () => present(1)) },
    ])
    const placement = await authority.admitSkillPlacement(
      '.skills/Ab3xK9_qZ12R/SKILL.md',
      'exclusive',
      'rename',
    )

    await expect(
      authority.admitSkillPlacement('.skills/Zy9xW8_vU76Q/SKILL.md', 'exclusive', 'create', {
        deadlineMs: 5,
      }),
    ).rejects.toMatchObject({ code: 'DEADLINE' })
    const otherProject = await authority.admitSkillPlacement(
      '.skills/_projects/cHJvamVjdA/Zy9xW8_vU76Q/SKILL.md',
      'exclusive',
      'other-project',
    )
    otherProject.settle()
    placement.settle()
  })

  it('uses A-target-B claims for linked-resource classification', async () => {
    const calls: string[] = []
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        files: observingStore(async (path) => {
          calls.push(path)
          return path.endsWith('SKILL.md') ? present(2, 'target') : present(1, 'source')
        }),
      },
    ])

    const result = await authority.observeLinked(
      'skills/demo/reference.md',
      'skills/demo/SKILL.md',
      (target) => target.bytes[0] === 2,
    )

    expect(result).not.toBeNull()
    expect(calls).toEqual([
      'skills/demo/reference.md',
      'skills/demo/SKILL.md',
      'skills/demo/reference.md',
    ])
    expect(result?.source.claim.value).toBe('test:source')
  })

  it('fails a linked read closed when the source never produces one stable claim', async () => {
    let sourceVersion = 0
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        files: observingStore(async (path) =>
          path === 'SKILL.md' ? present(9, 'target') : present(1, `source-${sourceVersion++}`),
        ),
      },
    ])

    await expect(
      authority.observeLinked('reference.md', 'SKILL.md', () => true, {
        owner: 'linked-reader',
      }),
    ).rejects.toMatchObject({ code: 'UNSTABLE_OBSERVATION' })
  })

  it('holds a root-package lease until a lazy export iterator is closed', async () => {
    const adapter = {
      async *exportFiles() {
        yield { path: 'demo/SKILL.md', content: Uint8Array.of(1) }
        yield { path: 'demo/asset.bin', content: Uint8Array.of(2) }
      },
    } as unknown as FileStore
    const authority = new SpaceResourceAuthority('space', [
      { id: 'skills', prefix: '.skills', files: adapter },
    ])
    const iterator = authority.exportAdapter('.skills')[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { path: '.skills/demo/SKILL.md', content: Uint8Array.of(1) },
    })
    let packageGranted = false
    const packagePromise = authority
      .admitPackage('.skills/demo', 'exclusive', 'package-replace')
      .then((lease) => {
        packageGranted = true
        return lease
      })

    await Promise.resolve()
    await Promise.resolve()
    expect(packageGranted).toBe(false)
    await iterator.return?.()
    const packageLease = await packagePromise
    expect(packageGranted).toBe(true)
    packageLease.settle()
  })

  it('maps an adapter-owned proof into a mutation receipt and holds exclusive admission', async () => {
    let submittedByte: number | undefined
    let releasePublication!: () => void
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve
    })
    const adapter: FileStore = {
      observe: async () => present(1, 'after'),
      publish: async (request: FilePublicationRequest) => {
        await publicationGate
        submittedByte = request.content[0]
        return {
          status: 'published',
          candidateHash: 'a'.repeat(64),
          transitions: [
            {
              path: request.kind === 'put' ? request.path : request.targetPath,
              before:
                request.kind === 'put'
                  ? request.expected
                  : { kind: 'absent' as const, value: 'test:absent' },
              after: { kind: 'present', value: 'test:after' },
              mtimeMs: 2,
            },
          ],
        }
      },
    } as unknown as FileStore
    const authority = new SpaceResourceAuthority('space', [
      { id: 'skills', prefix: '.notarium/skills', files: adapter },
    ])
    const expected = { kind: 'absent' as const, value: 'test:absent' }
    const source = Uint8Array.of(7)
    const publishing = authority.publish({
      kind: 'put',
      path: '.notarium/skills/demo/SKILL.md',
      content: source,
      expected,
      packagePath: '.notarium/skills/demo',
    })
    await Promise.resolve()
    let observed = false
    const observing = authority
      .observe('.notarium/skills/demo/SKILL.md', {
        packagePath: '.notarium/skills/demo',
      })
      .then(() => {
        observed = true
      })

    source[0] = 9
    await Promise.resolve()
    expect(observed).toBe(false)
    releasePublication()
    const result = await publishing
    await observing

    expect(result).toMatchObject({
      status: 'published',
      receipt: {
        spaceId: 'space',
        adapterId: 'skills',
        restartDurable: false,
        candidateHash: 'a'.repeat(64),
        transitions: [
          {
            path: '.notarium/skills/demo/SKILL.md',
            before: expected,
            after: { kind: 'present', value: 'test:after' },
            mtimeMs: 2,
          },
        ],
      },
    })
    expect(submittedByte).toBe(7)
  })

  it('rejects physical overlap across spaces after resolving symlinks', async () => {
    const parent = await mkroot()
    const vault = join(parent, 'vault')
    const alias = join(parent, 'alias')
    await fs.mkdir(join(vault, 'nested'), { recursive: true })
    await fs.symlink(vault, alias)

    expect(() =>
      preflightResourceRoots([
        { spaceId: 'left', adapterId: 'notes', root: vault },
        { spaceId: 'right', adapterId: 'notes', root: join(alias, 'nested') },
      ]),
    ).toThrow(/overlap across spaces/)
    expect(() =>
      preflightResourceRoots([
        { spaceId: 'same', adapterId: 'notes', root: vault },
        { spaceId: 'same', adapterId: 'skills', root: join(alias, 'nested') },
      ]),
    ).not.toThrow()
  })

  it('rechecks a late-created physical root before admission', async () => {
    const parent = await mkroot()
    const late = join(parent, 'late')
    const elsewhere = await mkroot()
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        physicalRoot: late,
        files: observingStore(async () => present(1)),
      },
    ])
    await fs.symlink(elsewhere, late)

    await expect(authority.observe('note.md')).rejects.toThrow(/changed after preflight/)
  })

  it('keeps one authority across store reopen and rejects cross-space overlap', async () => {
    const root = await mkroot()
    const registry = new SpaceResourceAuthorityRegistry()
    const adapter = (spaceRoot: string) => [
      {
        id: 'root',
        prefix: '',
        physicalRoot: spaceRoot,
        files: observingStore(async () => present(1)),
      },
    ]
    const first = registry.getOrCreate('space-a', adapter(root))
    const reopened = registry.getOrCreate('space-a', adapter(root))

    expect(reopened).toBe(first)
    expect(() => registry.getOrCreate('space-b', adapter(join(root, 'nested')))).toThrow(
      /overlap across spaces/,
    )
  })

  it('returns one aggregate receipt for an atomically installed package', async () => {
    const root = await mkroot()
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'skills',
        prefix: '.skills',
        physicalRoot: root,
        files: createLocalFsFiles(root),
      },
    ])
    const absent = await authority.observe('.skills/demo')

    expect(absent.kind).toBe('absent')
    if (absent.kind !== 'absent') {
      return
    }
    const result = await authority.publishPackageIfAbsent({
      rootPath: '.skills/demo',
      files: [
        { path: 'SKILL.md', content: new TextEncoder().encode('manifest') },
        { path: 'asset.bin', content: Uint8Array.of(0xff) },
      ],
      expectedRoot: absent.claim,
    })

    expect(result).toMatchObject({
      status: 'published',
      receipt: {
        transitions: expect.arrayContaining([
          expect.objectContaining({ path: '.skills/demo' }),
          expect.objectContaining({ path: '.skills/demo/SKILL.md' }),
          expect.objectContaining({ path: '.skills/demo/asset.bin' }),
        ]),
      },
    })
  })

  it('maps both sides of a move-put proof back to canonical resource paths', async () => {
    const root = await mkroot()
    await fs.writeFile(join(root, 'source.md'), 'old')
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'notes',
        prefix: 'notes',
        physicalRoot: root,
        files: createLocalFsFiles(root),
      },
    ])
    const source = await authority.observe('notes/source.md')
    const target = await authority.observe('notes/target.md')

    expect(source.kind).toBe('present')
    expect(target.kind).toBe('absent')
    if (source.kind !== 'present' || target.kind !== 'absent') {
      return
    }
    const result = await authority.publish({
      kind: 'move-put',
      sourcePath: 'notes/source.md',
      targetPath: 'notes/target.md',
      content: new TextEncoder().encode('new'),
      expectedSource: source.claim,
      expectedTarget: target.claim,
    })

    expect(result).toMatchObject({
      status: 'published',
      receipt: {
        transitions: [
          expect.objectContaining({
            path: 'notes/source.md',
            after: expect.objectContaining({ kind: 'absent' }),
          }),
          expect.objectContaining({
            path: 'notes/target.md',
            after: expect.objectContaining({ kind: 'present' }),
          }),
        ],
      },
    })
  })

  it('keeps a staged strict mutation resumable while admission is busy', async () => {
    const root = await mkroot()
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'notes',
        prefix: '',
        physicalRoot: root,
        files: createLocalFsFiles(root),
      },
    ])
    const absent = await authority.observe('note.md')

    expect(absent.kind).toBe('absent')
    if (absent.kind !== 'absent') {
      return
    }
    const staged = await authority.stageStrict({
      operationId: 'restore-op',
      binding: 'request-binding',
      path: 'note.md',
      content: new TextEncoder().encode('restored'),
      expected: absent.claim,
    })

    expect(staged).toMatchObject({
      status: 'accepted',
      state: { status: 'staged', stage: { spaceId: 'space', adapterId: 'notes' } },
    })
    const blocker = await authority.admitResource('note.md', 'shared', 'blocking-reader')

    await expect(
      authority.publishStrict(
        { operationId: 'restore-op', binding: 'request-binding', path: 'note.md' },
        { deadlineMs: 5 },
      ),
    ).rejects.toMatchObject({ code: 'DEADLINE' })
    await expect(
      authority.inspectStrict({
        operationId: 'restore-op',
        binding: 'request-binding',
        path: 'note.md',
      }),
    ).resolves.toMatchObject({ status: 'staged' })
    blocker.settle()
    await authority.closeAdmission()
    await expect(
      authority.publishStrict({
        operationId: 'restore-op',
        binding: 'request-binding',
        path: 'note.md',
      }),
    ).rejects.toMatchObject({ code: 'SPACE_LIFECYCLE_CLOSED' })

    const published = await authority.publishStrict(
      {
        operationId: 'restore-op',
        binding: 'request-binding',
        path: 'note.md',
      },
      { recovery: true },
    )

    expect(published).toMatchObject({
      status: 'published',
      receipt: {
        restartDurable: true,
        spaceId: 'space',
        adapterId: 'notes',
        transitions: [expect.objectContaining({ path: 'note.md' })],
      },
    })
    expect(authority.supportsRestartDurableStrict('note.md')).toBe(true)
  })

  it('distinguishes a missing strict stage from an idempotency binding conflict', async () => {
    const root = await mkroot()
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'notes',
        prefix: '',
        physicalRoot: root,
        files: createLocalFsFiles(root),
      },
    ])
    const absent = await authority.observe('note.md')

    expect(absent.kind).toBe('absent')
    if (absent.kind !== 'absent') {
      return
    }
    await expect(
      authority.publishStrict({ operationId: 'missing', binding: 'request', path: 'note.md' }),
    ).rejects.toMatchObject({ code: 'STRICT_STAGE_MISSING' })
    await authority.stageStrict({
      operationId: 'restore-op',
      binding: 'first-request',
      path: 'note.md',
      content: new TextEncoder().encode('restored'),
      expected: absent.claim,
    })
    await expect(
      authority.stageStrict({
        operationId: 'restore-op',
        binding: 'different-request',
        path: 'note.md',
        content: new TextEncoder().encode('restored'),
        expected: absent.claim,
      }),
    ).resolves.toMatchObject({ status: 'idempotency-conflict' })
  })

  it('reports process-only adapters as not restart durable', () => {
    const authority = new SpaceResourceAuthority('space', [
      { id: 'memory', prefix: '', files: observingStore(async () => present(1)) },
    ])

    expect(authority.supportsRestartDurableStrict('note.md')).toBe(false)
  })

  // ── The lifecycle question has ONE home: the admission gate ──────────────────
  //
  // Round 2 caught `assertLifecycleOpen` wrong in both directions at once, which is
  // what a per-method answer costs. Too wide: `publish` asked at the gate AND again
  // on the way out, so an ordinary save that the drain had already admitted died of
  // the fence it was being waited for. Too narrow: three `*Admitted` entries —
  // publication among them — never asked anything. The four tests below hold the two
  // halves and the classification that keeps a future method from having no home.

  it('finishes a publication the fence is already waiting for', async () => {
    const absent = { kind: 'absent' as const, value: 'test:absent' }
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        files: {
          observe: async () => present(1, 'after'),
          publish: async (request: FilePublicationRequest) => ({
            status: 'published',
            candidateHash: 'a'.repeat(64),
            transitions: [
              {
                path: request.kind === 'put' ? request.path : request.targetPath,
                before: absent,
                after: { kind: 'present' as const, value: 'test:after' },
                mtimeMs: 2,
              },
            ],
          }),
        } as unknown as FileStore,
      },
    ])
    // The publication asks for its lease BEFORE the fence and receives it AFTER —
    // which is precisely the window `closeAdmission` promises to wait through, and
    // precisely the window a second lifecycle check inside `publishAdmitted` kills.
    const blocker = await authority.admitResource('note.md', 'exclusive', 'blocking-writer')
    const publishing = authority.publish({
      kind: 'put',
      path: 'note.md',
      content: Uint8Array.of(7),
      expected: absent,
    })
    const closing = authority.closeAdmission()

    await expect(authority.admitResource('other.md', 'shared', 'fresh')).rejects.toMatchObject({
      code: 'SPACE_LIFECYCLE_CLOSED',
    })
    blocker.settle()
    await expect(publishing).resolves.toMatchObject({ status: 'published' })
    await closing
  })

  it('refuses every admitted entry that reaches a closed space with no lease at all', async () => {
    const authority = new SpaceResourceAuthority('space', [
      { id: 'root', prefix: '', files: observingStore(async () => present(1)) },
    ])

    await authority.closeAdmission()
    for (const [name, call] of Object.entries(admittedEntryCalls(authority))) {
      await expect(call(), name).rejects.toMatchObject({ code: 'SPACE_LIFECYCLE_CLOSED' })
    }
  })

  it('still admits recovery through an admitted entry while the space closes', async () => {
    const absent = { kind: 'absent' as const, value: 'test:absent' }
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        files: {
          observe: async () => present(1, 'after'),
          publish: async (request: FilePublicationRequest) => ({
            status: 'published',
            candidateHash: 'a'.repeat(64),
            transitions: [
              {
                path: request.kind === 'put' ? request.path : request.targetPath,
                before: absent,
                after: { kind: 'present' as const, value: 'test:after' },
                mtimeMs: 2,
              },
            ],
          }),
        } as unknown as FileStore,
      },
    ])

    await authority.closeAdmission()
    // `restoreCoordinator.resume` is exactly this shape: it takes its lease with
    // `allowDuringClosure` and then publishes through an admitted entry. The lease
    // IS the answer; re-asking here would end restore recovery on a closing space.
    const lease = await authority.admitResource('note.md', 'exclusive', 'restore:op', {
      allowDuringClosure: true,
    })

    await expect(
      authority.publishAdmitted({
        kind: 'put',
        path: 'note.md',
        content: Uint8Array.of(7),
        expected: absent,
      }),
    ).resolves.toMatchObject({ status: 'published' })
    await expect(authority.observeStrictAdmitted('note.md')).resolves.toMatchObject({
      kind: 'present',
    })
    lease.settle()
  })

  it('classifies every method of the authority as a gate, an admitted entry or neither', () => {
    // The gate that makes the class impossible to extend blindly: a method added
    // without an answer to "who asks the lifecycle question here" is in none of the
    // three lists and fails BY NAME, and an admitted entry that is not exercised
    // above has no invoker in the table the previous test iterates.
    const declared = [...LEASE_GATES, ...ADMITTED_ENTRIES, ...NEITHER].sort()
    const actual = Object.getOwnPropertyNames(SpaceResourceAuthority.prototype)
      .filter((name) => name !== 'constructor')
      .sort()

    expect(actual).toEqual(declared)
    expect(
      Object.keys(
        admittedEntryCalls(
          new SpaceResourceAuthority('space', [
            { id: 'root', prefix: '', files: observingStore(async () => present(1)) },
          ]),
        ),
      ).sort(),
    ).toEqual([...ADMITTED_ENTRIES].sort())
  })

  it('canonicalizes the mount roots once per lease and never again under them', async () => {
    const root = await mkroot()
    const absent = { kind: 'absent' as const, value: 'test:absent' }
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        physicalRoot: root,
        files: {
          observe: async () => present(1, 'after'),
          publish: async (request: FilePublicationRequest) => ({
            status: 'published',
            candidateHash: 'a'.repeat(64),
            transitions: [
              {
                path: request.kind === 'put' ? request.path : request.targetPath,
                before: absent,
                after: { kind: 'present' as const, value: 'test:after' },
                mtimeMs: 2,
              },
            ],
          }),
        } as unknown as FileStore,
      },
    ])
    const before = rootChecks.count

    await authority.publish({
      kind: 'put',
      path: 'pkg/note.md',
      content: Uint8Array.of(7),
      expected: absent,
      packagePath: 'pkg',
    })

    // Two leases, two checks. The third — one more synchronous `lstat`+`realpath` of
    // every mount root on the way out of every save — is what a lifecycle check
    // inside `publishAdmitted` costs.
    expect(rootChecks.count - before).toBe(2)
  })
})
