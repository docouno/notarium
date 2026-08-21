import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sha256Hex } from '@notarium/core'

import {
  createLocalFsFiles,
  type FileClaim,
  type FileObservation,
  type FilePackagePublicationRequest,
  type FileProofTransition,
  type FilePublicationRequest,
  type FileStrictPublicationResult,
  type FileStrictStageRequest,
  type FileStrictStageState,
} from '../files'
import { SpaceResourceAuthorityRegistry } from './registry'
import type * as rootsModule from './roots'
import { preflightResourceRoots } from './roots'
import { SpaceResourceAuthority } from './spaceResourceAuthority'
import {
  type ResourceAuthorityAdapter,
  resourceAuthorityAdapterOf,
  type ResourceAuthorityFileCapabilities,
  type ResourceAuthorityFileView,
  type ResourcePublicationRequest,
  type ResourceStrictStageRef,
  type ResourceStrictStageRequest,
} from './types'

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

/** The base inventory every adapter owes the authority. An empty tree is a
 *  complete, honest answer — these fixtures test routing and proof handling, not
 *  what a placement happens to contain. */
const emptyInventory: ResourceAuthorityFileView = {
  scan: async () => [],
  read: async () => null,
  dirExists: async () => false,
}

/** One adapter's whole file dependency, spelled as the two fields the type
 *  declares. Written out rather than cast: a cast would let a fixture claim a
 *  facet it does not implement, which is the exact confusion the split removes. */
const adapterFiles = (
  capabilities: ResourceAuthorityFileCapabilities,
  files: ResourceAuthorityFileView = emptyInventory,
): Pick<ResourceAuthorityAdapter, 'files' | 'capabilities'> => ({ files, capabilities })

const observingAdapter = (
  observe: (path: string) => Promise<FileObservation>,
): Pick<ResourceAuthorityAdapter, 'files' | 'capabilities'> =>
  adapterFiles({ resourceObservation: { observe } })

/** Observation plus a publication that always succeeds — the pair the lifecycle
 *  tests need, and nothing else. */
const publishingFiles = (
  absent: FileClaim & { kind: 'absent' },
): Pick<ResourceAuthorityAdapter, 'files' | 'capabilities'> =>
  adapterFiles({
    resourceObservation: { observe: async () => present(1, 'after') },
    resourcePublication: {
      publish: async (request: FilePublicationRequest) => ({
        status: 'published',
        candidateHash: await sha256Hex(request.content),
        transitions: [
          {
            path: request.kind === 'put' ? request.path : request.targetPath,
            before: absent,
            after: { kind: 'present' as const, value: 'test:after' },
            mtimeMs: 2,
          },
        ],
      }),
    },
  })

/** Public entries that TAKE a lease: the one place the lifecycle question is asked. */
const LEASE_GATES = ['admitResource', 'admitPackage', 'admitSkillPlacement'] as const

/** Public entries the caller enters under its OWN lease. They ask whether they were
 *  admitted, never whether the space is still accepting — the fence drains them. */
const ADMITTED_ENTRIES = [
  'assertSkillManifestNameAvailableAdmitted',
  'observeLinkedAdmitted',
  'observeStrictAdmitted',
  'publishAdmitted',
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
  'commitPackageIfAbsentAdmitted',
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
  // A composition QUESTION, answered without touching the medium. The lease
  // belongs to the view it returns, and is taken through `admitSkillPlacement`
  // — already a gate above.
  'packagePublicationFor',
  'publish',
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
    publishStrictAdmitted: () =>
      authority.publishStrictAdmitted({ operationId: 'op', binding: 'binding', path: 'note.md' }),
  }
}

describe('SpaceResourceAuthority', () => {
  it('rejects ambiguous topology and non-canonical resource requests', async () => {
    const files = observingAdapter(async () => present(1))

    expect(() => new SpaceResourceAuthority('  ', [{ id: 'root', prefix: '', ...files }])).toThrow(
      'space id',
    )
    expect(() => new SpaceResourceAuthority('space', [])).toThrow('at least one adapter')
    expect(
      () =>
        new SpaceResourceAuthority('space', [
          { id: 'duplicate', prefix: '', ...files },
          { id: 'duplicate', prefix: 'skills', ...files },
        ]),
    ).toThrow('ids must be unique')
    expect(
      () =>
        new SpaceResourceAuthority('space', [
          { id: 'one', prefix: 'skills', ...files },
          { id: 'two', prefix: 'skills', ...files },
        ]),
    ).toThrow('prefixes must be unique')

    const authority = new SpaceResourceAuthority('space', [
      { id: 'skills', prefix: 'skills', ...files },
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
    const incapable = adapterFiles({})
    const authority = new SpaceResourceAuthority('space', [
      { id: 'root', prefix: '', ...observingAdapter(async () => present(1)) },
      { id: 'skills', prefix: 'skills', ...incapable },
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
    const conflictStore = adapterFiles({
      resourceObservation: {
        observe: async () => ({ kind: 'absent', claim: absent, mtimeMs: null }),
      },
      resourcePublication: {
        publish: async () => ({ status: 'conflict' }),
      },
      packagePublication: {
        publishPackageIfAbsent: async () => ({ status: 'conflict' }),
      },
    })
    const conflictAuthority = new SpaceResourceAuthority('space', [
      { id: 'root', prefix: '', ...conflictStore },
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
      conflictAuthority.packagePublicationFor('', 'test')!.publishIfAbsent({
        rootPath: 'pkg',
        files: [
          {
            path: 'SKILL.md',
            content: new TextEncoder().encode('---\nname: pkg\ndescription: Package.\n---'),
          },
        ],
      }),
    ).resolves.toMatchObject({ status: 'conflict' })

    const invalidStore = adapterFiles({
      resourceObservation: {
        observe: async () => ({ kind: 'absent', claim: absent, mtimeMs: null }),
      },
      resourcePublication: {
        publish: async (request) => ({
          status: 'published',
          candidateHash: await sha256Hex(request.content),
          transitions: [],
        }),
      },
      packagePublication: {
        publishPackageIfAbsent: async () => ({
          status: 'published',
          candidateHash: 'a'.repeat(64),
          transitions: [],
        }),
      },
    })
    const invalidAuthority = new SpaceResourceAuthority('space', [
      { id: 'root', prefix: '', ...invalidStore },
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
      invalidAuthority.packagePublicationFor('', 'test')!.publishIfAbsent({
        rootPath: 'pkg',
        files: [
          {
            path: 'SKILL.md',
            content: new TextEncoder().encode('---\nname: pkg\ndescription: Package.\n---'),
          },
        ],
      }),
    ).rejects.toThrow('invalid package proof set')
  })

  it('closes fresh admission only after earlier work drains and reopens explicitly', async () => {
    const authority = new SpaceResourceAuthority('space', [
      { id: 'root', prefix: '', ...observingAdapter(async () => present(1)) },
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
        ...observingAdapter(async (path) => {
          rootCalls.push(path)
          return present(1)
        }),
      },
      {
        id: 'skills',
        prefix: '.notarium/skills',
        ...observingAdapter(async (path) => {
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
      { id: 'skills', prefix: '.skills', ...observingAdapter(async () => present(1)) },
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
        ...observingAdapter(async (path) => {
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
        ...observingAdapter(async (path) =>
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
    const adapter = adapterFiles({
      resourceExport: {
        async *exportFiles() {
          yield { path: 'demo/SKILL.md', content: Uint8Array.of(1) }
          yield { path: 'demo/asset.bin', content: Uint8Array.of(2) }
        },
      },
    })
    const authority = new SpaceResourceAuthority('space', [
      { id: 'skills', prefix: '.skills', ...adapter },
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
    const adapter = adapterFiles({
      resourceObservation: { observe: async () => present(1, 'after') },
      resourcePublication: {
        publish: async (request: FilePublicationRequest) => {
          await publicationGate
          submittedByte = request.content[0]
          return {
            status: 'published',
            candidateHash: await sha256Hex(request.content),
            transitions: [
              {
                path: request.kind === 'put' ? request.path : request.targetPath,
                before:
                  request.kind === 'put'
                    ? request.expected
                    : { kind: 'absent' as const, value: 'test:absent' },
                after: { kind: 'present' as const, value: 'test:after' },
                mtimeMs: 2,
              },
            ],
          }
        },
      },
    })
    const authority = new SpaceResourceAuthority('space', [
      { id: 'skills', prefix: '.notarium/skills', ...adapter },
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
        candidateHash: await sha256Hex(Uint8Array.of(7)),
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

  it('snapshots observation options before admission and owns the returned sample', async () => {
    const adapterClaim = { kind: 'present' as const, value: 'adapter:original' }
    const adapterBytes = Uint8Array.of(7)
    const adapterObservation: FileObservation = {
      kind: 'present',
      bytes: adapterBytes,
      claim: adapterClaim,
      mtimeMs: 2,
    }
    const observe = vi.fn(async () => adapterObservation)
    const authority = new SpaceResourceAuthority('space', [
      { id: 'root', prefix: '', ...observingAdapter(observe) },
    ])
    const blocker = await authority.admitResource('note.md', 'exclusive', 'blocking-writer')
    const options = { owner: 'immutable-observation', maxBytes: 7 }
    const observing = authority.observe('note.md', options)

    await Promise.resolve()
    expect(authority.diagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'waiting',
          owner: 'immutable-observation',
          path: 'note.md',
        }),
      ]),
    )
    options.maxBytes = 70
    blocker.settle()
    const observation = await observing

    expect(observe).toHaveBeenCalledWith('note.md', { maxBytes: 7 })
    adapterClaim.value = 'adapter:mutated'
    adapterBytes[0] = 9
    expect(observation).toMatchObject({
      kind: 'present',
      bytes: Uint8Array.of(7),
      claim: { kind: 'present', value: 'adapter:original' },
    })
  })

  it('owns an ordinary publication command from lease through adapter proof and receipt', async () => {
    const originalExpected: FileClaim = { kind: 'absent', value: 'original:absent' }
    const originalContent = Uint8Array.of(7)
    const originalPublish = vi.fn(async (submitted: FilePublicationRequest) => {
      expect(submitted).toEqual({
        kind: 'put',
        path: 'note.md',
        content: Uint8Array.of(7),
        expected: { kind: 'absent', value: 'original:absent' },
      })
      if (submitted.kind !== 'put') {
        throw new Error('expected the original put command')
      }

      return {
        status: 'published' as const,
        candidateHash: await sha256Hex(submitted.content),
        transitions: [
          {
            path: submitted.path,
            before: submitted.expected,
            after: { kind: 'present' as const, value: 'original:present' },
            mtimeMs: 2,
          },
        ],
      }
    })
    const mutatedPublish = vi.fn(async () => ({ status: 'conflict' as const }))
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'original',
        prefix: 'original',
        ...adapterFiles({ resourcePublication: { publish: originalPublish } }),
      },
      {
        id: 'mutated',
        prefix: 'mutated',
        ...adapterFiles({ resourcePublication: { publish: mutatedPublish } }),
      },
    ])
    const blocker = await authority.admitResource(
      'original/note.md',
      'exclusive',
      'blocking-writer',
    )
    const request: ResourcePublicationRequest = {
      kind: 'put',
      path: 'original/note.md',
      content: originalContent,
      expected: originalExpected,
    }
    const publishing = authority.publish(request, { owner: 'immutable-command' })

    await Promise.resolve()
    expect(authority.diagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'waiting',
          owner: 'immutable-command',
          path: 'original/note.md',
        }),
      ]),
    )
    originalExpected.kind = 'present'
    originalExpected.value = 'mutated:claim'
    originalContent[0] = 9
    Object.assign(request, {
      kind: 'move-put',
      path: 'mutated/note.md',
      sourcePath: 'mutated/source.md',
      targetPath: 'mutated/target.md',
      content: Uint8Array.of(9),
      expectedSource: { kind: 'present', value: 'mutated:source' },
      expectedTarget: { kind: 'absent', value: 'mutated:target' },
    })
    blocker.settle()

    await expect(publishing).resolves.toMatchObject({
      status: 'published',
      receipt: {
        adapterId: 'original',
        transitions: [
          {
            path: 'original/note.md',
            before: { kind: 'absent', value: 'original:absent' },
            after: { kind: 'present', value: 'original:present' },
          },
        ],
      },
    })
    expect(originalPublish).toHaveBeenCalledTimes(1)
    expect(mutatedPublish).not.toHaveBeenCalled()
  })

  it('keeps the ordinary proof baseline private from the adapter and owns its receipt', async () => {
    const expected = { kind: 'absent' as const, value: 'caller:absent' }
    const content = Uint8Array.of(7)
    let call = 0
    let returnedTransition: FileProofTransition | undefined
    const publish = vi.fn(async (submitted: FilePublicationRequest) => {
      if (submitted.kind !== 'put') {
        throw new Error('expected put')
      }
      call++
      expect(submitted.expected).not.toBe(expected)
      expect(submitted.content).not.toBe(content)

      if (call === 1) {
        submitted.expected.value = 'adapter:forged'

        return {
          status: 'published' as const,
          candidateHash: await sha256Hex(submitted.content),
          transitions: [
            {
              path: submitted.path,
              before: submitted.expected,
              after: { kind: 'present' as const, value: 'adapter:present' },
              mtimeMs: 2,
            },
          ],
        }
      }

      returnedTransition = {
        path: submitted.path,
        before: submitted.expected,
        after: { kind: 'present', value: 'adapter:present' },
        mtimeMs: 2,
      }

      return {
        status: 'published' as const,
        candidateHash: await sha256Hex(submitted.content),
        transitions: [returnedTransition],
      }
    })
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        ...adapterFiles({ resourcePublication: { publish } }),
      },
    ])

    await expect(
      authority.publish({ kind: 'put', path: 'forged.md', content, expected }),
    ).rejects.toThrow('invalid publication proof set')
    expect(expected).toEqual({ kind: 'absent', value: 'caller:absent' })
    expect(content).toEqual(Uint8Array.of(7))

    const result = await authority.publish({ kind: 'put', path: 'safe.md', content, expected })

    expect(result).toMatchObject({
      status: 'published',
      receipt: {
        transitions: [
          {
            path: 'safe.md',
            before: { kind: 'absent', value: 'caller:absent' },
            after: { kind: 'present', value: 'adapter:present' },
          },
        ],
      },
    })
    if (result.status !== 'published' || !returnedTransition) {
      return
    }
    returnedTransition.before.value = 'adapter:mutated-before'
    returnedTransition.after.value = 'adapter:mutated-after'
    expected.value = 'caller:mutated'
    expect(result.receipt.transitions[0]).toMatchObject({
      before: { kind: 'absent', value: 'caller:absent' },
      after: { kind: 'present', value: 'adapter:present' },
    })
  })

  it('rejects an ordinary candidate hash derived from adapter-mutated content', async () => {
    const expected = { kind: 'absent' as const, value: 'test:absent' }
    const content = Uint8Array.of(7)
    const publish = vi.fn(async (submitted: FilePublicationRequest) => {
      if (submitted.kind !== 'put') {
        throw new Error('expected put')
      }
      submitted.content[0] = 9

      return {
        status: 'published' as const,
        candidateHash: await sha256Hex(submitted.content),
        transitions: [
          {
            path: submitted.path,
            before: submitted.expected,
            after: { kind: 'present' as const, value: 'test:present' },
            mtimeMs: 2,
          },
        ],
      }
    })
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        ...adapterFiles({ resourcePublication: { publish } }),
      },
    ])

    await expect(
      authority.publish({ kind: 'put', path: 'note.md', content, expected }),
    ).rejects.toThrow('invalid publication candidate hash')
    expect(publish).toHaveBeenCalledTimes(1)
    expect(content).toEqual(Uint8Array.of(7))
    expect(expected).toEqual({ kind: 'absent', value: 'test:absent' })
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
        ...observingAdapter(async () => present(1)),
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
        ...observingAdapter(async () => present(1)),
      },
    ]
    const first = registry.getOrCreate('space-a', adapter(root))
    const reopened = registry.getOrCreate('space-a', adapter(root))

    expect(reopened).toBe(first)
    expect(() => registry.getOrCreate('space-b', adapter(join(root, 'nested')))).toThrow(
      /overlap across spaces/,
    )
  })

  it('shares one A snapshot across registry roots and authority when getters turn into B', async () => {
    const rootA = await mkroot()
    const rootB = await mkroot()
    const nestedB = join(rootA, 'nested-b')
    await fs.mkdir(nestedB)
    const reads: Record<string, number> = {}

    const next = <Value>(key: string, first: Value, later: Value): Value => {
      reads[key] = (reads[key] ?? 0) + 1
      return reads[key] === 1 ? first : later
    }
    const scanA: ResourceAuthorityFileView['scan'] = vi.fn(async () => [])
    const readA: ResourceAuthorityFileView['read'] = vi.fn(async () => null)
    const dirExistsA: ResourceAuthorityFileView['dirExists'] = vi.fn(async () => false)
    const observeA: NonNullable<
      ResourceAuthorityFileCapabilities['resourceObservation']
    >['observe'] = vi.fn(async () => ({
      kind: 'absent' as const,
      claim: { kind: 'absent' as const, value: 'a:absent' },
      mtimeMs: null,
    }))

    const failB = async (): Promise<never> => {
      throw new Error('B adapter reached')
    }
    const files: ResourceAuthorityFileView = {
      get scan() {
        return next('files.scan', scanA, failB)
      },
      get read() {
        return next('files.read', readA, failB)
      },
      get dirExists() {
        return next('files.dirExists', dirExistsA, failB)
      },
    }
    const observation: NonNullable<ResourceAuthorityFileCapabilities['resourceObservation']> = {
      get observe() {
        return next('resourceObservation.observe', observeA, failB)
      },
    }
    const capabilities: ResourceAuthorityFileCapabilities = {
      get resourceExport() {
        return next('capabilities.resourceExport', undefined, undefined)
      },
      get resourceObservation() {
        return next('capabilities.resourceObservation', observation, { observe: failB })
      },
      get resourcePublication() {
        return next('capabilities.resourcePublication', undefined, undefined)
      },
      get claimedRemoval() {
        return next('capabilities.claimedRemoval', undefined, undefined)
      },
      get packagePublication() {
        return next('capabilities.packagePublication', undefined, undefined)
      },
      get strictPublication() {
        return next('capabilities.strictPublication', undefined, undefined)
      },
    }
    const adapter: ResourceAuthorityAdapter = {
      get id() {
        return next('adapter.id', 'root-a', 'root-b')
      },
      get prefix() {
        return next('adapter.prefix', '', 'b')
      },
      get physicalRoot() {
        return next('adapter.physicalRoot', rootA, rootB)
      },
      get files() {
        return next('adapter.files', files, {
          scan: failB,
          read: failB,
          dirExists: failB,
        })
      },
      get capabilities() {
        return next('adapter.capabilities', capabilities, {
          resourceObservation: { observe: failB },
        })
      },
    }
    const registry = new SpaceResourceAuthorityRegistry()
    const authority = registry.getOrCreate('space-a', [adapter])

    await expect(authority.observe('note.md')).resolves.toMatchObject({
      adapterId: 'root-a',
      claim: { value: 'a:absent' },
    })
    expect(
      registry.getOrCreate('space-a', [
        {
          id: 'root-a',
          prefix: '',
          physicalRoot: rootA,
          files: { scan: scanA, read: readA, dirExists: dirExistsA },
          capabilities: { resourceObservation: { observe: observeA } },
        },
      ]),
    ).toBe(authority)
    expect(() =>
      registry.getOrCreate('space-b', [
        {
          id: 'nested-b',
          prefix: '',
          physicalRoot: nestedB,
          ...observingAdapter(async () => present(1)),
        },
      ]),
    ).toThrow(/overlap across spaces/)
    expect(reads).toEqual({
      'adapter.id': 1,
      'adapter.prefix': 1,
      'adapter.physicalRoot': 1,
      'adapter.files': 1,
      'files.scan': 1,
      'files.read': 1,
      'files.dirExists': 1,
      'adapter.capabilities': 1,
      'capabilities.resourceExport': 1,
      'capabilities.resourceObservation': 1,
      'capabilities.resourcePublication': 1,
      'capabilities.claimedRemoval': 1,
      'capabilities.packagePublication': 1,
      'capabilities.strictPublication': 1,
      'resourceObservation.observe': 1,
    })
  })

  it('snapshots generic registry adapters before routing and root ownership', async () => {
    const rootA = await mkroot()
    const rootB = await mkroot()
    const nestedA = join(rootA, 'nested')
    await fs.mkdir(nestedA)
    const absentA = { kind: 'absent' as const, value: 'a:absent' }
    const manifest = new TextEncoder().encode(
      '---\nname: demo\ndescription: Adapter snapshot.\n---\n',
    )
    const existingManifest = '---\nname: existing\ndescription: Existing package.\n---\n'
    const scanA = vi.fn(async () => [
      { path: 'existing/SKILL.md', mtimeMs: 1, size: 1, birthtimeMs: null },
    ])
    const readA = vi.fn(async () => existingManifest)
    const dirExistsA = vi.fn(async () => false)
    const observeA = vi.fn(async () => ({ kind: 'absent' as const, claim: absentA, mtimeMs: null }))
    const publishA = vi.fn(async (request: FilePublicationRequest) => ({
      status: 'published' as const,
      candidateHash: await sha256Hex(request.content),
      transitions: [
        {
          path: request.kind === 'put' ? request.path : request.targetPath,
          before: request.kind === 'put' ? request.expected : request.expectedTarget,
          after: { kind: 'present' as const, value: 'a:published' },
          mtimeMs: 2,
        },
      ],
    }))
    const publishPackageA = vi.fn(async (request: FilePackagePublicationRequest) => ({
      status: 'published' as const,
      candidateHash: 'a'.repeat(64),
      transitions: [
        {
          path: request.rootPath,
          before: request.expectedRoot,
          after: { kind: 'present' as const, value: 'a:package' },
          mtimeMs: 3,
        },
        ...request.files.map((file) => ({
          path: `${request.rootPath}/${file.path}`,
          before: { kind: 'absent' as const, value: `a:absent:${file.path}` },
          after: { kind: 'present' as const, value: `a:present:${file.path}` },
          mtimeMs: 3,
        })),
      ],
    }))
    const filesA: ResourceAuthorityFileView = {
      scan: scanA,
      read: readA,
      dirExists: dirExistsA,
    }
    const capabilitiesA: ResourceAuthorityFileCapabilities = {
      resourceObservation: { observe: observeA },
      resourcePublication: { publish: publishA },
      packagePublication: { publishPackageIfAbsent: publishPackageA },
    }
    const adapter: ResourceAuthorityAdapter = {
      id: 'root-a',
      prefix: '',
      physicalRoot: rootA,
      files: filesA,
      capabilities: capabilitiesA,
    }
    const registry = new SpaceResourceAuthorityRegistry()
    const authority = registry.getOrCreate('space-a', [adapter])
    const replacement = observingAdapter(async () => ({
      kind: 'absent',
      claim: { kind: 'absent', value: 'b:absent' },
      mtimeMs: null,
    }))
    const filesB: ResourceAuthorityFileView = {
      scan: vi.fn(async () => {
        throw new Error('replacement scan reached')
      }),
      read: vi.fn(async () => {
        throw new Error('replacement read reached')
      }),
      dirExists: vi.fn(async () => {
        throw new Error('replacement dirExists reached')
      }),
    }
    const publishB = vi.fn(async () => {
      throw new Error('replacement publication reached')
    })
    const publishPackageB = vi.fn(async () => {
      throw new Error('replacement package publication reached')
    })
    const capabilitiesB: ResourceAuthorityFileCapabilities = {
      ...replacement.capabilities,
      resourcePublication: { publish: publishB },
      packagePublication: { publishPackageIfAbsent: publishPackageB },
    }

    // Replace both the adapter views and every original method. The authority
    // must retain bound A methods, not follow either live alias to B.
    filesA.scan = filesB.scan
    filesA.read = filesB.read
    filesA.dirExists = filesB.dirExists
    capabilitiesA.resourceObservation!.observe =
      replacement.capabilities.resourceObservation!.observe
    capabilitiesA.resourcePublication!.publish = publishB
    capabilitiesA.packagePublication!.publishPackageIfAbsent = publishPackageB
    adapter.id = 'root-b'
    adapter.prefix = 'replacement'
    adapter.physicalRoot = rootB
    adapter.files = filesB
    adapter.capabilities = capabilitiesB

    await expect(authority.observe('note.md')).resolves.toMatchObject({
      adapterId: 'root-a',
      claim: absentA,
    })
    await expect(
      authority.publish({
        kind: 'put',
        path: 'note.md',
        content: Uint8Array.of(7),
        expected: absentA,
      }),
    ).resolves.toMatchObject({
      status: 'published',
      receipt: { adapterId: 'root-a', transitions: [{ path: 'note.md', before: absentA }] },
    })
    await expect(
      authority.packagePublicationFor('', 'snapshot-test')!.publishIfAbsent({
        rootPath: 'incoming',
        files: [{ path: 'SKILL.md', content: manifest }],
      }),
    ).resolves.toMatchObject({ status: 'published', receipt: { adapterId: 'root-a' } })

    expect(observeA).toHaveBeenCalledTimes(2)
    expect(publishA).toHaveBeenCalledTimes(1)
    expect(publishPackageA).toHaveBeenCalledTimes(1)
    expect(dirExistsA).toHaveBeenCalledTimes(1)
    expect(scanA).toHaveBeenCalledTimes(1)
    expect(readA).toHaveBeenCalledTimes(1)
    expect(publishB).not.toHaveBeenCalled()
    expect(publishPackageB).not.toHaveBeenCalled()
    expect(() =>
      registry.getOrCreate('space-b', [
        {
          id: 'nested',
          prefix: '',
          physicalRoot: nestedA,
          ...observingAdapter(async () => present(1)),
        },
      ]),
    ).toThrow(/overlap across spaces/)
  })

  it('binds owned registrations to one frozen owner and its adapters', async () => {
    const root = await mkroot()
    const registry = new SpaceResourceAuthorityRegistry()
    const adapter = () => [
      {
        id: 'root',
        prefix: '',
        physicalRoot: root,
        ...observingAdapter(async () => present(1)),
      },
    ]
    const owner = Object.freeze({ adaptersForAuthority: adapter })
    const first = registry.getOrCreateOwned({
      spaceId: 'space-a',
      owner,
    })
    const reopened = registry.getOrCreateOwned({
      spaceId: 'space-a',
      owner,
    })

    expect(reopened).toBe(first)
    expect(() =>
      registry.getOrCreateOwned({
        spaceId: 'space-a',
        owner: Object.freeze({ adaptersForAuthority: adapter }),
      }),
    ).toThrow(/owner identity changed/)
    expect(() => registry.getOrCreate('space-a', adapter())).toThrow(/owner identity changed/)
  })

  it('requires one frozen owner on the owned registration path', () => {
    const registry = new SpaceResourceAuthorityRegistry()
    // @ts-expect-error owned registration cannot receive adapters without their owner
    const forgotten = () => registry.getOrCreateOwned({ spaceId: 'space-a', adapters: [] })
    const mutable = () =>
      registry.getOrCreateOwned({
        spaceId: 'space-a',
        owner: { adaptersForAuthority: () => [] },
      })

    expect(forgotten).toBeTypeOf('function')
    expect(mutable).toThrow(/requires a frozen owner/)
  })

  it('returns one aggregate receipt for an atomically installed package', async () => {
    const root = await mkroot()
    const authority = new SpaceResourceAuthority('space', [
      resourceAuthorityAdapterOf(
        { id: 'skills', prefix: '.skills', physicalRoot: root },
        createLocalFsFiles(root),
      ),
    ])
    const view = authority.packagePublicationFor('.skills', 'test')

    expect(view).not.toBeNull()
    const result = await view!.publishIfAbsent({
      rootPath: '.skills/demo',
      files: [
        {
          path: 'SKILL.md',
          content: new TextEncoder().encode('---\nname: demo\ndescription: Demo.\n---'),
        },
        { path: 'asset.bin', content: Uint8Array.of(0xff) },
      ],
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
      resourceAuthorityAdapterOf(
        { id: 'notes', prefix: 'notes', physicalRoot: root },
        createLocalFsFiles(root),
      ),
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

  it('rejects a move-put proof that duplicates the source and omits the target', async () => {
    const expectedSource = { kind: 'present' as const, value: 'test:source' }
    const expectedTarget = { kind: 'absent' as const, value: 'test:target' }
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'notes',
        prefix: '',
        ...adapterFiles({
          resourcePublication: {
            publish: async (request: FilePublicationRequest) => {
              if (request.kind !== 'move-put') {
                throw new Error('expected move-put')
              }

              return {
                status: 'published',
                candidateHash: await sha256Hex(request.content),
                transitions: [
                  {
                    path: request.sourcePath,
                    before: request.expectedSource,
                    after: { kind: 'absent' as const, value: 'test:removed' },
                    mtimeMs: null,
                  },
                  {
                    path: request.sourcePath,
                    before: request.expectedSource,
                    after: { kind: 'absent' as const, value: 'test:removed' },
                    mtimeMs: null,
                  },
                ],
              }
            },
          },
        }),
      },
    ])

    await expect(
      authority.publish({
        kind: 'move-put',
        sourcePath: 'source.md',
        targetPath: 'target.md',
        content: Uint8Array.of(1),
        expectedSource,
        expectedTarget,
      }),
    ).rejects.toThrow('invalid publication proof set')
  })

  it('rejects a package proof that duplicates the root and omits a resource', async () => {
    const absent = { kind: 'absent' as const, value: 'test:absent' }
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'skills',
        prefix: '',
        ...adapterFiles({
          resourceObservation: {
            observe: async () => ({ kind: 'absent', claim: absent, mtimeMs: null }),
          },
          packagePublication: {
            publishPackageIfAbsent: async (request) => ({
              status: 'published',
              candidateHash: 'a'.repeat(64),
              transitions: [
                {
                  path: request.rootPath,
                  before: request.expectedRoot,
                  after: { kind: 'present', value: 'test:package' },
                  mtimeMs: null,
                },
                {
                  path: request.rootPath,
                  before: request.expectedRoot,
                  after: { kind: 'present', value: 'test:package' },
                  mtimeMs: null,
                },
              ],
            }),
          },
        }),
      },
    ])
    const view = authority.packagePublicationFor('', 'invalid-proof')

    expect(view).not.toBeNull()
    await expect(
      view!.publishIfAbsent({
        rootPath: 'demo',
        files: [
          {
            path: 'SKILL.md',
            content: new TextEncoder().encode('---\nname: demo\ndescription: Demo.\n---\n'),
          },
        ],
      }),
    ).rejects.toThrow('invalid package proof set')
  })

  it('keeps a staged strict mutation resumable while admission is busy', async () => {
    const root = await mkroot()
    const authority = new SpaceResourceAuthority('space', [
      resourceAuthorityAdapterOf(
        { id: 'notes', prefix: '', physicalRoot: root },
        createLocalFsFiles(root),
      ),
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

  it('owns a strict stage command while the adapter is pending', async () => {
    let announceStage!: () => void
    let releaseStage!: () => void
    const stageStarted = new Promise<void>((resolve) => {
      announceStage = resolve
    })
    const stageReleased = new Promise<void>((resolve) => {
      releaseStage = resolve
    })
    const stage = vi.fn(async (submitted) => {
      announceStage()
      await stageReleased
      expect(submitted).toEqual({
        operationId: 'original-operation',
        binding: 'original-binding',
        path: 'note.md',
        content: Uint8Array.of(7),
        expected: { kind: 'absent', value: 'original:absent' },
      })

      return {
        status: 'accepted' as const,
        created: true,
        state: {
          status: 'staged' as const,
          stage: {
            operationId: submitted.operationId,
            binding: submitted.binding,
            path: submitted.path,
            expected: submitted.expected,
            candidateHash: await sha256Hex(submitted.content),
          },
        },
      }
    })
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'strict',
        prefix: 'strict',
        ...adapterFiles({
          strictPublication: {
            restartDurable: true,
            stage,
            inspect: async () => ({ status: 'missing' }),
            publish: async () => {
              throw new Error('not used')
            },
            discard: async () => false,
          },
        }),
      },
    ])
    const expected: FileClaim = { kind: 'absent', value: 'original:absent' }
    const content = Uint8Array.of(7)
    const request: ResourceStrictStageRequest = {
      operationId: 'original-operation',
      binding: 'original-binding',
      path: 'strict/note.md',
      content,
      expected,
    }
    const staging = authority.stageStrict(request)

    await stageStarted
    request.operationId = 'mutated-operation'
    request.binding = 'mutated-binding'
    request.path = 'strict/mutated.md'
    content[0] = 9
    expected.kind = 'present'
    expected.value = 'mutated:claim'
    releaseStage()

    await expect(staging).resolves.toMatchObject({
      status: 'accepted',
      state: {
        status: 'staged',
        stage: {
          operationId: 'original-operation',
          binding: 'original-binding',
          path: 'strict/note.md',
          expected: { kind: 'absent', value: 'original:absent' },
        },
      },
    })
    expect(stage).toHaveBeenCalledTimes(1)
  })

  it('rejects a strict stage hash derived from adapter-mutated content', async () => {
    const expected = { kind: 'absent' as const, value: 'test:absent' }
    const content = Uint8Array.of(7)
    const stage = vi.fn(async (submitted: FileStrictStageRequest) => {
      submitted.content[0] = 9

      return {
        status: 'accepted' as const,
        created: true,
        state: {
          status: 'staged' as const,
          stage: {
            operationId: submitted.operationId,
            binding: submitted.binding,
            path: submitted.path,
            expected: submitted.expected,
            candidateHash: await sha256Hex(submitted.content),
          },
        },
      }
    })
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        ...adapterFiles({
          strictPublication: {
            restartDurable: true,
            stage,
            inspect: async () => ({ status: 'missing' }),
            publish: async () => {
              throw new Error('not used')
            },
            discard: async () => false,
          },
        }),
      },
    ])

    await expect(
      authority.stageStrict({
        operationId: 'strict-operation',
        binding: 'strict-binding',
        path: 'note.md',
        content,
        expected,
      }),
    ).rejects.toThrow('invalid strict stage header')
    expect(stage).toHaveBeenCalledTimes(1)
    expect(content).toEqual(Uint8Array.of(7))
    expect(expected).toEqual({ kind: 'absent', value: 'test:absent' })
  })

  it('keeps a later strict receipt bound to the accepted candidate hash', async () => {
    const content = Uint8Array.of(7)
    const expected = { kind: 'absent' as const, value: 'test:absent' }
    const candidateHash = await sha256Hex(content)
    const stage = {
      operationId: 'strict-operation',
      binding: 'strict-binding',
      path: 'note.md',
      expected,
      candidateHash,
    }
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        ...adapterFiles({
          strictPublication: {
            restartDurable: true,
            stage: async () => ({
              status: 'accepted',
              created: true,
              state: { status: 'staged', stage },
            }),
            inspect: async () => ({ status: 'staged', stage }),
            publish: async () => ({
              status: 'published',
              receipt: {
                operationId: stage.operationId,
                binding: stage.binding,
                observationId: 'test:observation',
                semanticEventTime: '2026-08-20T00:00:00.000Z',
                restartDurable: true,
                candidateHash: await sha256Hex(Uint8Array.of(9)),
                transitions: [
                  {
                    path: stage.path,
                    before: stage.expected,
                    after: { kind: 'present', value: 'test:present' },
                    mtimeMs: 2,
                  },
                ],
              },
            }),
            discard: async () => false,
          },
        }),
      },
    ])

    await expect(
      authority.stageStrict({
        operationId: stage.operationId,
        binding: stage.binding,
        path: stage.path,
        content,
        expected,
      }),
    ).resolves.toMatchObject({ status: 'accepted' })
    await expect(
      authority.publishStrict({
        operationId: stage.operationId,
        binding: stage.binding,
        path: stage.path,
      }),
    ).rejects.toThrow('invalid strict publication proof')
  })

  it('owns a strict publish command from lease through adapter proof and receipt', async () => {
    const expected = { kind: 'absent' as const, value: 'original:absent' }
    const stage = {
      operationId: 'original-operation',
      binding: 'original-binding',
      path: 'note.md',
      expected,
      candidateHash: 'a'.repeat(64),
    }
    const inspectOriginal = vi.fn(async () => ({ status: 'staged' as const, stage }))
    const publishOriginal = vi.fn(async () => ({
      status: 'published' as const,
      receipt: {
        operationId: stage.operationId,
        binding: stage.binding,
        observationId: 'original:observation',
        semanticEventTime: '2026-08-20T00:00:00.000Z',
        restartDurable: true as const,
        candidateHash: stage.candidateHash,
        transitions: [
          {
            path: stage.path,
            before: stage.expected,
            after: { kind: 'present' as const, value: 'original:present' },
            mtimeMs: 2,
          },
        ],
      },
    }))
    const mutatedStage = {
      operationId: 'mutated-operation',
      binding: 'mutated-binding',
      path: 'note.md',
      expected: { kind: 'absent' as const, value: 'mutated:absent' },
      candidateHash: 'b'.repeat(64),
    }
    const inspectMutated = vi.fn(async () => ({ status: 'staged' as const, stage: mutatedStage }))
    const publishMutated = vi.fn(async () => ({
      status: 'published' as const,
      receipt: {
        operationId: mutatedStage.operationId,
        binding: mutatedStage.binding,
        observationId: 'mutated:observation',
        semanticEventTime: '2026-08-20T00:00:00.000Z',
        restartDurable: true as const,
        candidateHash: mutatedStage.candidateHash,
        transitions: [
          {
            path: mutatedStage.path,
            before: mutatedStage.expected,
            after: { kind: 'present' as const, value: 'mutated:present' },
            mtimeMs: 2,
          },
        ],
      },
    }))
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'original',
        prefix: 'original',
        ...adapterFiles({
          strictPublication: {
            restartDurable: true,
            stage: async () => ({ status: 'idempotency-conflict' }),
            inspect: inspectOriginal,
            publish: publishOriginal,
            discard: async () => false,
          },
        }),
      },
      {
        id: 'mutated',
        prefix: 'mutated',
        ...adapterFiles({
          strictPublication: {
            restartDurable: true,
            stage: async () => ({ status: 'idempotency-conflict' }),
            inspect: inspectMutated,
            publish: publishMutated,
            discard: async () => false,
          },
        }),
      },
    ])
    const blocker = await authority.admitResource(
      'original/note.md',
      'exclusive',
      'blocking-writer',
    )
    const request: ResourceStrictStageRef = {
      operationId: 'original-operation',
      binding: 'original-binding',
      path: 'original/note.md',
    }
    const publishing = authority.publishStrict(request, { owner: 'immutable-strict-command' })

    await Promise.resolve()
    expect(authority.diagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'waiting',
          owner: 'immutable-strict-command',
          path: 'original/note.md',
        }),
      ]),
    )
    request.operationId = 'mutated-operation'
    request.binding = 'mutated-binding'
    request.path = 'mutated/note.md'
    blocker.settle()

    await expect(publishing).resolves.toMatchObject({
      status: 'published',
      receipt: {
        operationId: 'original-operation',
        binding: 'original-binding',
        adapterId: 'original',
        transitions: [
          {
            path: 'original/note.md',
            before: { kind: 'absent', value: 'original:absent' },
            after: { kind: 'present', value: 'original:present' },
          },
        ],
      },
    })
    expect(inspectOriginal).toHaveBeenCalledWith('original-operation', 'original-binding')
    expect(publishOriginal).toHaveBeenCalledWith('original-operation', 'original-binding')
    expect(inspectMutated).not.toHaveBeenCalled()
    expect(publishMutated).not.toHaveBeenCalled()
  })

  it('keeps strict stage claims private and validates exact adapter headers', async () => {
    const callerExpected = { kind: 'absent' as const, value: 'caller:absent' }
    const callerContent = Uint8Array.of(7)
    const stage = vi.fn(async (submitted: FileStrictStageRequest) => {
      expect(submitted.expected).not.toBe(callerExpected)
      expect(submitted.content).not.toBe(callerContent)
      submitted.expected.value = 'adapter:forged'

      return {
        status: 'accepted' as const,
        created: true,
        state: {
          status: 'staged' as const,
          stage: {
            operationId: submitted.operationId,
            binding: submitted.binding,
            path: submitted.path,
            expected: submitted.expected,
            candidateHash: 'a'.repeat(64),
          },
        },
      }
    })
    const validStage = {
      operationId: 'strict-operation',
      binding: 'strict-binding',
      path: 'note.md',
      expected: { kind: 'absent' as const, value: 'adapter:absent' },
      candidateHash: 'a'.repeat(64),
    }
    let inspected: FileStrictStageState = {
      status: 'staged',
      stage: { ...validStage, binding: 'adapter:forged-binding' },
    }
    let published: FileStrictPublicationResult = {
      status: 'conflict',
      stage: { ...validStage, candidateHash: 'b'.repeat(64) },
    }
    const inspect = vi.fn(async (): Promise<FileStrictStageState> => inspected)
    const publish = vi.fn(async (): Promise<FileStrictPublicationResult> => published)
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        ...adapterFiles({
          strictPublication: {
            restartDurable: true,
            stage,
            inspect,
            publish,
            discard: async () => false,
          },
        }),
      },
    ])

    await expect(
      authority.stageStrict({
        operationId: 'strict-operation',
        binding: 'strict-binding',
        path: 'note.md',
        content: callerContent,
        expected: callerExpected,
      }),
    ).rejects.toThrow('invalid strict stage header')
    expect(callerExpected).toEqual({ kind: 'absent', value: 'caller:absent' })
    expect(callerContent).toEqual(Uint8Array.of(7))

    await expect(
      authority.inspectStrict({
        operationId: 'strict-operation',
        binding: 'strict-binding',
        path: 'note.md',
      }),
    ).rejects.toThrow('invalid strict stage header')

    inspected = { status: 'staged', stage: validStage }
    await expect(
      authority.publishStrict({
        operationId: 'strict-operation',
        binding: 'strict-binding',
        path: 'note.md',
      }),
    ).rejects.toThrow('invalid strict stage header')

    published = { status: 'conflict', stage: validStage }
    await expect(
      authority.publishStrict({
        operationId: 'strict-operation',
        binding: 'strict-binding',
        path: 'note.md',
      }),
    ).resolves.toMatchObject({
      status: 'conflict',
      stage: {
        operationId: 'strict-operation',
        binding: 'strict-binding',
        path: 'note.md',
        expected: { kind: 'absent', value: 'adapter:absent' },
        candidateHash: 'a'.repeat(64),
      },
    })
  })

  it('owns strict headers and receipts returned by an adapter', async () => {
    const adapterExpected = { kind: 'absent' as const, value: 'adapter:absent' }
    const adapterAfter = { kind: 'present' as const, value: 'adapter:present' }
    const adapterStage = {
      operationId: 'strict-operation',
      binding: 'strict-binding',
      path: 'note.md',
      expected: adapterExpected,
      candidateHash: 'a'.repeat(64),
    }
    const adapterReceipt = {
      operationId: 'strict-operation',
      binding: 'strict-binding',
      observationId: 'adapter:observation',
      semanticEventTime: '2026-08-20T00:00:00.000Z',
      restartDurable: true as const,
      candidateHash: 'a'.repeat(64),
      transitions: [
        {
          path: 'note.md',
          before: adapterExpected,
          after: adapterAfter,
          mtimeMs: 2,
        },
      ],
    }
    const adapterState: FileStrictStageState = {
      status: 'published',
      stage: adapterStage,
      receipt: adapterReceipt,
    }
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        ...adapterFiles({
          strictPublication: {
            restartDurable: true,
            stage: async () => ({ status: 'idempotency-conflict' }),
            inspect: async () => adapterState,
            publish: async () => ({ status: 'published', receipt: adapterReceipt }),
            discard: async () => false,
          },
        }),
      },
    ])
    const state = await authority.inspectStrict({
      operationId: 'strict-operation',
      binding: 'strict-binding',
      path: 'note.md',
    })

    expect(state).toMatchObject({
      status: 'published',
      stage: {
        expected: { kind: 'absent', value: 'adapter:absent' },
        candidateHash: 'a'.repeat(64),
      },
      receipt: {
        transitions: [
          {
            before: { kind: 'absent', value: 'adapter:absent' },
            after: { kind: 'present', value: 'adapter:present' },
          },
        ],
      },
    })
    adapterExpected.value = 'adapter:mutated-expected'
    adapterAfter.value = 'adapter:mutated-after'
    adapterStage.candidateHash = 'b'.repeat(64)
    adapterReceipt.candidateHash = 'b'.repeat(64)
    expect(state).toMatchObject({
      status: 'published',
      stage: {
        expected: { kind: 'absent', value: 'adapter:absent' },
        candidateHash: 'a'.repeat(64),
      },
      receipt: {
        candidateHash: 'a'.repeat(64),
        transitions: [
          {
            before: { kind: 'absent', value: 'adapter:absent' },
            after: { kind: 'present', value: 'adapter:present' },
          },
        ],
      },
    })
  })

  it('distinguishes a missing strict stage from an idempotency binding conflict', async () => {
    const root = await mkroot()
    const authority = new SpaceResourceAuthority('space', [
      resourceAuthorityAdapterOf(
        { id: 'notes', prefix: '', physicalRoot: root },
        createLocalFsFiles(root),
      ),
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

  it('hands out no package publication where the prerequisite set is incomplete', () => {
    // Aggregate commit WITHOUT the strict observation its absent claim comes from.
    // Advertised as available, this composition would reach the commit and only
    // then discover it has no claim to publish against.
    const halfCapable = new SpaceResourceAuthority('space', [
      {
        id: 'skills',
        prefix: '.skills',
        ...adapterFiles({
          packagePublication: { publishPackageIfAbsent: async () => ({ status: 'conflict' }) },
        }),
      },
    ])

    expect(halfCapable.packagePublicationFor('.skills', 'audit')).toBeNull()
    // And the mirror: observation without the commit is no publisher either.
    const observationOnly = new SpaceResourceAuthority('space', [
      { id: 'skills', prefix: '.skills', ...observingAdapter(async () => present(1)) },
    ])

    expect(observationOnly.packagePublicationFor('.skills', 'audit')).toBeNull()
  })

  it('rejects non-package roots, duplicate files and invalid paths before storage work', async () => {
    const absent = { kind: 'absent' as const, value: 'test:absent' }
    const observe = vi.fn(async () => ({ kind: 'absent' as const, claim: absent, mtimeMs: null }))
    const commit = vi.fn(async () => ({ status: 'conflict' as const }))
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        ...adapterFiles({
          resourceObservation: { observe },
          packagePublication: { publishPackageIfAbsent: commit },
        }),
      },
    ])
    const view = authority.packagePublicationFor('', 'invalid-package')!
    const manifest = new TextEncoder().encode('---\nname: demo\ndescription: Demo.\n---\n')

    for (const request of [
      {
        rootPath: 'nested/demo',
        files: [{ path: 'SKILL.md', content: manifest }],
      },
      {
        rootPath: 'demo',
        files: [
          { path: 'SKILL.md', content: manifest },
          { path: 'SKILL.md', content: manifest },
        ],
      },
      {
        rootPath: 'demo/../other',
        files: [{ path: 'SKILL.md', content: manifest }],
      },
      {
        rootPath: 'demo',
        files: [
          { path: 'SKILL.md', content: manifest },
          { path: '../asset.bin', content: Uint8Array.of(1) },
        ],
      },
    ]) {
      await expect(view.publishIfAbsent(request)).rejects.toThrow()
    }

    expect(observe).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(authority.diagnostics()).toEqual([])

    await authority.closeAdmission()
    await expect(
      view.publishIfAbsent({
        rootPath: 'demo',
        files: [{ path: 'SKILL.md', content: manifest }],
      }),
    ).rejects.toMatchObject({ code: 'SPACE_LIFECYCLE_CLOSED' })
    expect(observe).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('closes route, observation, name check and commit into one admitted decision', async () => {
    const root = await mkroot()
    const adapter = resourceAuthorityAdapterOf(
      { id: 'skills', prefix: '.skills', physicalRoot: root },
      createLocalFsFiles(root),
    )
    const commit = vi.fn(adapter.capabilities.packagePublication!.publishPackageIfAbsent)

    adapter.capabilities = {
      ...adapter.capabilities,
      packagePublication: { publishPackageIfAbsent: commit },
    }
    const authority = new SpaceResourceAuthority('space', [adapter])
    const view = authority.packagePublicationFor('.skills', 'audit')

    expect(view).not.toBeNull()
    const manifest = new TextEncoder().encode('---\nname: demo\ndescription: Demo.\n---\n\nBody.')
    const published = await view!.publishIfAbsent({
      rootPath: '.skills/demo',
      files: [
        { path: 'SKILL.md', content: manifest },
        { path: 'asset.bin', content: Uint8Array.of(0xff) },
      ],
    })

    // The caller never saw a claim: the absent observation the commit was
    // conditioned on was taken and used inside the same admission.
    expect(published).toMatchObject({ status: 'published' })
    expect(commit).toHaveBeenCalledTimes(1)

    await expect(
      view!.publishIfAbsent({
        rootPath: '.skills/demo/nested',
        files: [{ path: 'SKILL.md', content: manifest }],
      }),
    ).rejects.toThrow('canonical package root')
    expect(commit).toHaveBeenCalledTimes(1)
    await expect(fs.lstat(join(root, 'demo', 'nested'))).rejects.toMatchObject({ code: 'ENOENT' })

    // A second package under a DIFFERENT address but the same manifest name is
    // the placement-wide conflict the name check exists for.
    const beforeConflict = await fs.readdir(root)

    await expect(
      view!.publishIfAbsent({
        rootPath: '.skills/other',
        files: [{ path: 'SKILL.md', content: manifest }],
      }),
    ).rejects.toMatchObject({ code: 'SKILL_NAME_CONFLICT' })
    // Name validation precedes the raw aggregate commit. A conflict neither
    // invokes it nor leaves a package/staging mutation behind.
    expect(commit).toHaveBeenCalledTimes(1)
    await expect(fs.readdir(root)).resolves.toEqual(beforeConflict)
    await expect(fs.lstat(join(root, 'other'))).rejects.toMatchObject({ code: 'ENOENT' })

    const projectView = authority.packagePublicationFor('.skills/_projects/one', 'audit')

    await expect(
      projectView!.publishIfAbsent({
        rootPath: '.skills/_projects/two/demo',
        files: [{ path: 'SKILL.md', content: manifest }],
      }),
    ).rejects.toThrow('outside its publication placement')
    expect(commit).toHaveBeenCalledTimes(1)

    // An occupied root is an ordinary conflict, not an error.
    await expect(
      view!.publishIfAbsent({
        rootPath: '.skills/demo',
        files: [{ path: 'SKILL.md', content: manifest }],
      }),
    ).resolves.toMatchObject({ status: 'conflict' })
  })

  it('serializes concurrent same-name packages across one placement', async () => {
    const root = await mkroot()
    const manifest = new TextEncoder().encode('---\nname: demo\ndescription: Demo.\n---\n')
    const adapter = resourceAuthorityAdapterOf(
      { id: 'skills', prefix: '.skills', physicalRoot: root },
      createLocalFsFiles(root),
    )
    const commitPackage = adapter.capabilities.packagePublication!.publishPackageIfAbsent
    let releaseCommit!: () => void
    let announceCommit!: () => void
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    const commitStarted = new Promise<void>((resolve) => {
      announceCommit = resolve
    })
    const commit = vi.fn(async (...args: Parameters<typeof commitPackage>) => {
      announceCommit()
      await commitReleased

      return commitPackage(...args)
    })

    adapter.capabilities = {
      ...adapter.capabilities,
      packagePublication: { publishPackageIfAbsent: commit },
    }
    const authority = new SpaceResourceAuthority('space', [adapter])
    const view = authority.packagePublicationFor('.skills', 'concurrent-add')

    expect(view).not.toBeNull()
    const first = view!.publishIfAbsent({
      rootPath: '.skills/first',
      files: [{ path: 'SKILL.md', content: manifest }],
    })

    await commitStarted
    const second = view!.publishIfAbsent({
      rootPath: '.skills/second',
      files: [{ path: 'SKILL.md', content: manifest }],
    })

    await Promise.resolve()
    expect(commit).toHaveBeenCalledTimes(1)
    releaseCommit()
    await expect(first).resolves.toMatchObject({ status: 'published' })
    await expect(second).rejects.toMatchObject({ code: 'SKILL_NAME_CONFLICT' })
    expect(commit).toHaveBeenCalledTimes(1)
    await expect(fs.readdir(root)).resolves.toEqual(['first'])
  })

  it('owns package paths and bytes before awaiting the manifest name check', async () => {
    const root = await mkroot()
    await fs.mkdir(join(root, 'taken'))
    await fs.writeFile(
      join(root, 'taken', 'SKILL.md'),
      '---\nname: taken\ndescription: Existing.\n---\n',
    )
    const adapter = resourceAuthorityAdapterOf(
      { id: 'skills', prefix: '.skills', physicalRoot: root },
      createLocalFsFiles(root),
    )
    const scan = adapter.files.scan
    let announceScan!: () => void
    let releaseScan!: () => void
    const scanStarted = new Promise<void>((resolve) => {
      announceScan = resolve
    })
    const scanReleased = new Promise<void>((resolve) => {
      releaseScan = resolve
    })

    adapter.files = {
      ...adapter.files,
      scan: async () => {
        announceScan()
        await scanReleased

        return scan()
      },
    }
    const authority = new SpaceResourceAuthority('space', [adapter])
    const view = authority.packagePublicationFor('.skills', 'immutable-request')!
    const manifest = new TextEncoder().encode('---\nname: safee\ndescription: Candidate.\n---\n')
    const asset = Uint8Array.of(1, 2, 3)
    const request = {
      rootPath: '.skills/safee',
      files: [
        { path: 'SKILL.md', content: manifest },
        { path: 'asset.bin', content: asset },
      ],
    }
    const publishing = view.publishIfAbsent(request)

    await scanStarted
    request.rootPath = '.skills/changed'
    request.files[0].path = 'RENAMED.md'
    request.files[1].path = 'changed.bin'
    manifest.set(new TextEncoder().encode('---\nname: taken\ndescription: Candidate.\n---\n'))
    asset.set([9, 9, 9])
    releaseScan()

    await expect(publishing).resolves.toMatchObject({ status: 'published' })
    await expect(fs.readFile(join(root, 'safee', 'SKILL.md'), 'utf8')).resolves.toContain(
      'name: safee',
    )
    await expect(fs.readFile(join(root, 'safee', 'asset.bin'))).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    )
    await expect(fs.lstat(join(root, 'changed'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(join(root, 'safee', 'RENAMED.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(fs.lstat(join(root, 'safee', 'changed.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('keeps the package root claim private and owns the aggregate receipt', async () => {
    const adapterClaim = { kind: 'absent' as const, value: 'adapter:absent' }
    let call = 0
    let returnedTransitions: FileProofTransition[] | undefined
    const commit = vi.fn(async (request: FilePackagePublicationRequest) => {
      call++
      const transitions: FileProofTransition[] = [
        {
          path: request.rootPath,
          before: request.expectedRoot,
          after: { kind: 'present', value: 'adapter:root' },
          mtimeMs: 2,
        },
        ...request.files.map((file) => ({
          path: `${request.rootPath}/${file.path}`,
          before: { kind: 'absent' as const, value: `adapter:absent:${file.path}` },
          after: { kind: 'present' as const, value: `adapter:present:${file.path}` },
          mtimeMs: 2,
        })),
      ]

      if (call === 1) {
        request.expectedRoot.value = 'adapter:forged-root'

        return {
          status: 'published' as const,
          candidateHash: 'a'.repeat(64),
          transitions,
        }
      }

      returnedTransitions = transitions

      return {
        status: 'published' as const,
        candidateHash: 'b'.repeat(64),
        transitions,
      }
    })
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        ...adapterFiles({
          resourceObservation: {
            observe: async () => ({ kind: 'absent', claim: adapterClaim, mtimeMs: null }),
          },
          packagePublication: { publishPackageIfAbsent: commit },
        }),
      },
    ])
    const view = authority.packagePublicationFor('', 'adapter-boundary')!
    const manifest = (name: string) =>
      new TextEncoder().encode(`---\nname: ${name}\ndescription: Package.\n---\n`)

    await expect(
      view.publishIfAbsent({
        rootPath: 'forged',
        files: [{ path: 'SKILL.md', content: manifest('forged') }],
      }),
    ).rejects.toThrow('invalid package proof set')
    expect(adapterClaim).toEqual({ kind: 'absent', value: 'adapter:absent' })

    const result = await view.publishIfAbsent({
      rootPath: 'safe',
      files: [{ path: 'SKILL.md', content: manifest('safe') }],
    })

    expect(result).toMatchObject({
      status: 'published',
      receipt: {
        transitions: expect.arrayContaining([
          expect.objectContaining({
            path: 'safe',
            before: { kind: 'absent', value: 'adapter:absent' },
          }),
          expect.objectContaining({ path: 'safe/SKILL.md' }),
        ]),
      },
    })
    if (result.status !== 'published' || !returnedTransitions) {
      return
    }
    returnedTransitions[0].before.value = 'adapter:mutated-root'
    returnedTransitions[0].after.value = 'adapter:mutated-present'
    expect(result.receipt.transitions[0]).toMatchObject({
      before: { kind: 'absent', value: 'adapter:absent' },
      after: { kind: 'present', value: 'adapter:root' },
    })
  })

  it('reports process-only adapters as not restart durable', () => {
    const authority = new SpaceResourceAuthority('space', [
      { id: 'memory', prefix: '', ...observingAdapter(async () => present(1)) },
    ])

    expect(authority.supportsRestartDurableStrict('note.md')).toBe(false)
  })

  it('retains claimed-removal admission until the physical operation settles', async () => {
    let announceRemoval!: () => void
    let finishRemoval!: (removed: boolean) => void
    const removalStarted = new Promise<void>((resolve) => {
      announceRemoval = resolve
    })
    const removalResult = new Promise<boolean>((resolve) => {
      finishRemoval = resolve
    })
    const removeIfClaimed = vi.fn(() => {
      announceRemoval()
      return removalResult
    })
    const authority = new SpaceResourceAuthority('space', [
      {
        id: 'root',
        prefix: '',
        ...adapterFiles({ claimedRemoval: { removeIfClaimed } }),
      },
    ])
    const removing = authority.removeClaimed('note.md', 'root:claim', 'expected')

    await removalStarted
    expect(authority.diagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'active',
          mode: 'exclusive',
          owner: 'resource-claim-compensation',
          path: 'note.md',
        }),
      ]),
    )

    const controller = new AbortController()
    let competingGranted = false
    const competing = authority
      .admitResource('note.md', 'exclusive', 'competing-writer', { signal: controller.signal })
      .then((lease) => {
        competingGranted = true
        return lease
      })

    await Promise.resolve()
    expect(competingGranted).toBe(false)
    expect(authority.diagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'waiting',
          owner: 'competing-writer',
          path: 'note.md',
        }),
      ]),
    )
    controller.abort(new Error('cancel competing writer'))
    await expect(competing).rejects.toThrow('cancel competing writer')

    let closed = false
    const closing = authority.closeAdmission().then(() => {
      closed = true
    })

    await Promise.resolve()
    expect(closed).toBe(false)
    finishRemoval(true)
    await expect(removing).resolves.toBe(true)
    await closing
    expect(closed).toBe(true)
    expect(authority.diagnostics()).toEqual([])
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
        ...publishingFiles(absent),
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
      { id: 'root', prefix: '', ...observingAdapter(async () => present(1)) },
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
        ...publishingFiles(absent),
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
            { id: 'root', prefix: '', ...observingAdapter(async () => present(1)) },
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
        ...publishingFiles(absent),
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
