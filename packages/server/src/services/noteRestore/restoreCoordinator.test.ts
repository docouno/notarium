import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  analyzeDocumentState,
  bindStorageOwnerProof,
  DOCUMENT_ROLE,
  type DocumentState,
  documentStateVersionToken,
  encodeDocumentState,
  type LOGICAL_NOTE_STATE_FORMAT,
  RESTORE_OPERATION_PHASE,
  type RestoreOperationPersistence,
  type RestoreTerminalPersistence,
  REVISION_KIND,
  sha256Hex,
  SPACE_LIFECYCLE_PHASE,
} from '@notarium/core'
import { createLocalFsFiles, SpaceResourceAuthority } from '@notarium/engine'

import { type Principal, SYSTEM_PRINCIPAL } from '../authz'
import { InstallationReplayKey, ReplayKeyring } from '../installationReplayKey'
import { createMetaDb, type MetaDb } from '../metaDb'
import type { SpaceManager } from '../spaces'
import { RestoreCoordinator } from './restoreCoordinator'

const roots: string[] = []
const NOTE_ID = '550e8400-e29b-41d4-a716-446655440000'
const CREATED_AT = '2026-08-11T00:00:00.000Z'

const unsafeHistoricalState = (): DocumentState => {
  const source = new TextEncoder().encode(
    `---\nnotarium-id: &owner ${NOTE_ID}\ncopy: *owner\ntitle: Unsafe\n---\nbody\n`,
  )
  const ownerProof = bindStorageOwnerProof({
    source,
    owners: [{ key: 'notarium-id', ownership: 'value' }],
    evidence: { kind: 'mutation-receipt', id: 'anchored-owner' },
  })

  return analyzeDocumentState({ source, pathFallbackTitle: 'note', ownerProof })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const proxiedMetaDb = (metaDb: MetaDb, facets: Partial<MetaDb>): MetaDb =>
  new Proxy(metaDb, {
    get: (target, property, receiver) => {
      if (property in facets) {
        return facets[property as keyof MetaDb]
      }

      return Reflect.get(target, property, receiver)
    },
  })

const proxiedAuthority = (
  authority: SpaceResourceAuthority,
  publish: SpaceResourceAuthority['publishStrictAdmitted'],
): SpaceResourceAuthority =>
  new Proxy(authority, {
    get: (target, property, receiver) => {
      if (property === 'publishStrictAdmitted') {
        return publish
      }
      const value = Reflect.get(target, property, receiver) as unknown

      return typeof value === 'function' ? value.bind(target) : value
    },
  })

type FixtureOptions = {
  mode?: 'history' | 'trash'
  targetPath?: string
  resourcePrefix?: string
  sourceState?: DocumentState
  sourceRecord?: {
    content: string | Uint8Array | null
    stateFormat: typeof LOGICAL_NOTE_STATE_FORMAT | null
    title: string
    tags?: string[]
    slug?: string | null
  }
  currentState?: DocumentState
  sourceClass?: string | null
  currentClass?: string | null
}

const fixture = async (options: FixtureOptions = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-restore-coordinator-'))
  roots.push(root)
  const metaDb = createMetaDb(`sqlite:${join(root, 'meta.db')}`)
  const replayKey = new InstallationReplayKey({
    persistence: metaDb.installationGeneration,
    keyring: new ReplayKeyring(join(root, 'replay-keys')),
    topology: 'canonical-local',
  })
  const notesDir = join(root, 'notes')
  await mkdir(notesDir, { recursive: true })
  const resourcePrefix = options.resourcePrefix ?? ''
  const resourceRoot = resourcePrefix ? join(notesDir, resourcePrefix) : notesDir
  await mkdir(resourceRoot, { recursive: true })
  const files = createLocalFsFiles(resourceRoot)
  const authority = new SpaceResourceAuthority('space-a', [
    { id: 'notes', prefix: resourcePrefix, files, physicalRoot: resourceRoot },
  ])
  const noteId = NOTE_ID
  const trashMode = options.mode === 'trash'
  const targetPath = options.targetPath ?? 'note.md'
  const sourceState =
    options.sourceState ??
    analyzeDocumentState({
      source: new TextEncoder().encode('---\ntitle: Historical\n---\nold body\n'),
      pathFallbackTitle: 'note',
    })
  const currentState =
    options.currentState ??
    analyzeDocumentState({
      source: new TextEncoder().encode('---\ntitle: Current\n---\nnew body\n'),
      pathFallbackTitle: 'note',
    })
  const sourceBlob = options.sourceRecord
    ? options.sourceRecord.content
    : encodeDocumentState(sourceState)
  const currentBlob = encodeDocumentState(currentState)

  await metaDb.spaceLifecycle.ensure('space-a', SPACE_LIFECYCLE_PHASE.active, CREATED_AT)
  await metaDb.identity.claimMany([
    {
      id: noteId,
      addressRevision: 1,
      filePath: targetPath,
      space: 'space-a',
      createdAt: CREATED_AT,
      materialized: false,
      deletedAt: trashMode ? '2026-08-11T00:02:00.000Z' : null,
    },
  ])
  const sourceRevision = await metaDb.revisions.append(
    {
      noteId,
      space: 'space-a',
      baseRevisionId: null,
      expectedHeadRevisionId: null,
      theirRevisionId: null,
      sourceRevisionId: null,
      kind: trashMode ? REVISION_KIND.delete : REVISION_KIND.external,
      entryRole: trashMode ? 'change' : 'baseline',
      principal: 'ui',
      contentHash: sourceBlob == null ? null : await sha256Hex(sourceBlob),
      semanticFingerprint: options.sourceRecord ? null : sourceState.semanticFingerprint,
      stateFormat: options.sourceRecord ? options.sourceRecord.stateFormat : sourceState.format,
      title: options.sourceRecord?.title ?? 'Historical',
      class: options.sourceClass ?? 'user-doc',
      slug: options.sourceRecord?.slug ?? null,
      tags: options.sourceRecord?.tags ?? [],
      createdAt: CREATED_AT,
      charsAdded: null,
      charsRemoved: null,
    },
    sourceBlob,
  )

  if (!trashMode) {
    await metaDb.revisions.append(
      {
        noteId,
        space: 'space-a',
        baseRevisionId: sourceRevision.id,
        expectedHeadRevisionId: sourceRevision.id,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: REVISION_KIND.write,
        entryRole: 'change',
        principal: 'ui',
        contentHash: await sha256Hex(currentBlob),
        semanticFingerprint: currentState.semanticFingerprint,
        stateFormat: currentState.format,
        title: 'Current',
        class: options.currentClass ?? options.sourceClass ?? 'user-doc',
        slug: null,
        tags: [],
        createdAt: '2026-08-11T00:01:00.000Z',
        charsAdded: null,
        charsRemoved: null,
      },
      currentBlob,
    )
    await mkdir(dirname(join(notesDir, targetPath)), { recursive: true })
    await writeFile(join(notesDir, targetPath), currentState.source)
  }
  const spaces = {
    reconcileCausalProjection: async () => {},
    resumeLifecycle: async () => {},
  } as unknown as SpaceManager
  const command = {
    mode: 'history' as const,
    principal: SYSTEM_PRINCIPAL,
    noteId,
    revisionId: sourceRevision.id,
    versionToken: documentStateVersionToken(currentState),
    idempotencyKey: 'one-command',
  }
  const trashCommand = {
    mode: 'trash' as const,
    principal: SYSTEM_PRINCIPAL,
    space: 'space-a',
    noteId,
    revisionId: sourceRevision.id,
    idempotencyKey: 'one-command',
  }
  const coordinator = (
    selectedMetaDb: MetaDb = metaDb,
    selectedAuthority: SpaceResourceAuthority = authority,
    selectedSpaces: SpaceManager = spaces,
  ) =>
    new RestoreCoordinator({
      metaDb: selectedMetaDb,
      replayKey,
      spaces: selectedSpaces,
      authorityForSpace: async () => selectedAuthority,
      onError: () => {},
    })

  return {
    metaDb,
    authority,
    noteId,
    targetPath,
    sourceState,
    currentState,
    sourceRevision,
    command,
    trashCommand,
    coordinator,
  }
}

describe('RestoreCoordinator recovery seams', () => {
  it('returns a resumable staged operation when admission is busy after acceptance', async () => {
    const f = await fixture()
    const busyAuthority = new Proxy(f.authority, {
      get: (target, property, receiver) => {
        if (property === 'admitResource') {
          return async () => {
            throw new Error('resource admission is busy')
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown

        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const pending = await f.coordinator(f.metaDb, busyAuthority).execute(f.command)

    if (pending.status !== 'pending') {
      throw new Error(`expected accepted busy operation, got ${pending.status}`)
    }
    expect(pending.phase).toBe('staged')
    const resumed = await f.coordinator().execute(f.command)
    expect(resumed).toMatchObject({ status: 'succeeded', operationId: pending.operationId })
    await f.metaDb.close()
  })

  it('pins hard purge from acceptance until the operation is terminal', async () => {
    const f = await fixture()
    const busyAuthority = new Proxy(f.authority, {
      get: (target, property, receiver) => {
        if (property === 'admitResource') {
          return async () => {
            throw new Error('hold accepted restore')
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown

        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const pending = await f.coordinator(f.metaDb, busyAuthority).execute(f.command)

    expect(pending).toMatchObject({ status: 'pending', phase: 'staged' })
    await expect(f.metaDb.purgeSpace('space-a')).rejects.toThrow(/blocked by restore operation/)
    expect(await f.metaDb.spaceLifecycle.get('space-a')).toMatchObject({
      phase: SPACE_LIFECYCLE_PHASE.active,
    })
    expect(await f.coordinator().execute(f.command)).toMatchObject({ status: 'succeeded' })
    await f.metaDb.close()
  })

  it('resumes a durable stage after prepare persistence crashed', async () => {
    const f = await fixture()
    const base = f.metaDb.restoreOperations
    let crash = true
    const operations: RestoreOperationPersistence = {
      ...base,
      transition: async (input) => {
        if (crash && input.phase === RESTORE_OPERATION_PHASE.prepared) {
          crash = false
          throw new Error('crash after stage')
        }

        return base.transition(input)
      },
    }
    const first = await f
      .coordinator(proxiedMetaDb(f.metaDb, { restoreOperations: operations }))
      .execute(f.command)

    expect(first).toMatchObject({ status: 'pending', phase: 'staged' })
    expect(await readFile(join(roots[0], 'notes', f.targetPath), 'utf8')).toContain('new body')
    const resumed = await f.coordinator().execute(f.command)

    expect(resumed).toMatchObject({ status: 'succeeded', noteId: f.noteId })
    const revisions = await f.metaDb.revisions.listByNote('space-a', f.noteId, {
      offset: 0,
      limit: 20,
    })
    expect(
      revisions.items.filter((revision) => revision.kind === REVISION_KIND.restore),
    ).toHaveLength(1)
    await f.metaDb.close()
  })

  it('adopts an already-published strict receipt after the process died', async () => {
    const f = await fixture()
    let crash = true
    const authority = proxiedAuthority(f.authority, async (request) => {
      const result = await f.authority.publishStrictAdmitted(request)

      if (crash) {
        crash = false
        throw new Error('crash after physical publication')
      }

      return result
    })
    const first = await f.coordinator(f.metaDb, authority).execute(f.command)

    expect(first).toMatchObject({ status: 'pending', phase: 'prepared' })
    expect(await readFile(join(roots[0], 'notes', f.targetPath), 'utf8')).toContain('old body')
    const resumed = await f.coordinator().execute(f.command)

    expect(resumed).toMatchObject({ status: 'succeeded', noteId: f.noteId })
    const revisions = await f.metaDb.revisions.listByNote('space-a', f.noteId, {
      offset: 0,
      limit: 20,
    })
    expect(
      revisions.items.filter((revision) => revision.kind === REVISION_KIND.restore),
    ).toHaveLength(1)
    await f.metaDb.close()
  })

  it('does not overwrite an external writer that wins after staging', async () => {
    const f = await fixture()
    const foreign = 'foreign writer won\n'
    const authority = proxiedAuthority(f.authority, async (request) => {
      await writeFile(join(roots[0], 'notes', f.targetPath), foreign)

      return f.authority.publishStrictAdmitted(request)
    })
    const result = await f.coordinator(f.metaDb, authority).execute(f.command)

    expect(result).toMatchObject({ status: 'conflict', reason: 'physical-target-changed' })
    expect(await readFile(join(roots[0], 'notes', f.targetPath), 'utf8')).toBe(foreign)
    const revisions = await f.metaDb.revisions.listByNote('space-a', f.noteId, {
      offset: 0,
      limit: 20,
    })
    expect(
      revisions.items.filter((revision) => revision.kind === REVISION_KIND.restore),
    ).toHaveLength(0)
    await f.metaDb.close()
  })

  it('rereads a committed terminal result when the commit acknowledgement was lost', async () => {
    const f = await fixture()
    const base = f.metaDb.restoreTerminal
    let crash = true
    const terminal: RestoreTerminalPersistence = {
      ...base,
      commit: async (input) => {
        const result = await base.commit(input)

        if (crash) {
          crash = false
          throw new Error('lost terminal acknowledgement')
        }

        return result
      },
    }
    const result = await f
      .coordinator(proxiedMetaDb(f.metaDb, { restoreTerminal: terminal }))
      .execute(f.command)

    expect(result).toMatchObject({ status: 'succeeded', noteId: f.noteId })
    const revisions = await f.metaDb.revisions.listByNote('space-a', f.noteId, {
      offset: 0,
      limit: 20,
    })
    expect(
      revisions.items.filter((revision) => revision.kind === REVISION_KIND.restore),
    ).toHaveLength(1)
    await f.metaDb.close()
  })

  it('rereads a finalized terminal result when the final acknowledgement was lost', async () => {
    const f = await fixture()
    const base = f.metaDb.restoreTerminal
    let crash = true
    const terminal: RestoreTerminalPersistence = {
      ...base,
      finalize: async (input) => {
        const result = await base.finalize(input)

        if (crash) {
          crash = false
          throw new Error('lost final acknowledgement')
        }

        return result
      },
    }
    const result = await f
      .coordinator(proxiedMetaDb(f.metaDb, { restoreTerminal: terminal }))
      .execute(f.command)

    expect(result).toMatchObject({ status: 'succeeded', noteId: f.noteId })
    if (result.status !== 'succeeded') {
      throw new Error(`expected succeeded restore, got ${result.status}`)
    }
    expect(await f.metaDb.restoreOperations.get(result.operationId)).toMatchObject({
      phase: RESTORE_OPERATION_PHASE.succeeded,
    })
    await f.metaDb.close()
  })

  it('finalizes the accepted restore and reconciles a pathname replacement during commit', async () => {
    const f = await fixture()
    const base = f.metaDb.restoreTerminal
    const foreign = 'foreign bytes during DB commit\n'
    const terminal: RestoreTerminalPersistence = {
      ...base,
      commit: async (input) => {
        const result = await base.commit(input)

        await writeFile(join(roots[0], 'notes', f.targetPath), foreign)
        return result
      },
    }
    let reconciledSource: string | null = null
    const spaces = {
      reconcileCausalProjection: async () => {
        reconciledSource = await readFile(join(roots[0], 'notes', f.targetPath), 'utf8')
      },
      resumeLifecycle: async () => {},
    } as unknown as SpaceManager
    const result = await f
      .coordinator(proxiedMetaDb(f.metaDb, { restoreTerminal: terminal }), f.authority, spaces)
      .execute(f.command)

    expect(result).toMatchObject({ status: 'succeeded', noteId: f.noteId })
    if (result.status !== 'succeeded') {
      throw new Error(`expected succeeded restore, got ${result.status}`)
    }
    expect(await readFile(join(roots[0], 'notes', f.targetPath), 'utf8')).toBe(foreign)
    expect(reconciledSource).toBe(foreign)
    expect(await f.metaDb.restoreOperations.get(result.operationId)).toMatchObject({
      phase: RESTORE_OPERATION_PHASE.succeeded,
    })
    expect(await f.metaDb.causalOutbox.pending('test-replica', 10)).toEqual([
      expect.objectContaining({ operationId: result.operationId }),
    ])
    await expect(f.coordinator().execute(f.command)).resolves.toMatchObject({
      status: 'succeeded',
      operationId: result.operationId,
    })
    await f.metaDb.close()
  })

  it('reconciles a pathname write after physical linearization as a later mutation', async () => {
    const f = await fixture()
    const base = f.metaDb.restoreTerminal
    const foreign = 'foreign bytes after physical linearization\n'
    const terminal: RestoreTerminalPersistence = {
      ...base,
      finalize: async (input) => {
        await writeFile(join(roots[0], 'notes', f.targetPath), foreign)
        return base.finalize(input)
      },
    }
    let reconciledSource: string | null = null
    const spaces = {
      reconcileCausalProjection: async () => {
        reconciledSource = await readFile(join(roots[0], 'notes', f.targetPath), 'utf8')
      },
      resumeLifecycle: async () => {},
    } as unknown as SpaceManager
    const result = await f
      .coordinator(proxiedMetaDb(f.metaDb, { restoreTerminal: terminal }), f.authority, spaces)
      .execute(f.command)

    expect(result).toMatchObject({ status: 'succeeded', noteId: f.noteId })
    if (result.status !== 'succeeded') {
      throw new Error(`expected success, got ${result.status}`)
    }
    expect(reconciledSource).toBe(foreign)
    expect(await f.metaDb.restoreOperations.get(result.operationId)).toMatchObject({
      phase: RESTORE_OPERATION_PHASE.succeeded,
    })
    await f.metaDb.close()
  })

  it('reclaims a successful strict stage while replay remains durable', async () => {
    const f = await fixture()
    const first = await f.coordinator().execute(f.command)

    expect(first).toMatchObject({ status: 'succeeded', noteId: f.noteId })
    await expect(readdir(join(roots[0], 'notes', '.notarium-fs-ops'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(f.coordinator().execute(f.command)).resolves.toEqual(first)
    await f.metaDb.close()
  })

  it('keeps terminal replay successful and retries strict cleanup after a transient failure', async () => {
    const f = await fixture()
    let discards = 0
    const authority = new Proxy(f.authority, {
      get: (target, property, receiver) => {
        if (property === 'discardStrict') {
          return async (...args: Parameters<SpaceResourceAuthority['discardStrict']>) => {
            discards++
            if (discards === 1) {
              throw new Error('cleanup unavailable')
            }

            return target.discardStrict(...args)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown

        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const first = await f.coordinator(f.metaDb, authority).execute(f.command)

    expect(first).toMatchObject({ status: 'succeeded', noteId: f.noteId })
    expect(discards).toBe(1)
    await expect(f.coordinator(f.metaDb, authority).execute(f.command)).resolves.toEqual(first)
    expect(discards).toBe(2)
    await expect(readdir(join(roots[0], 'notes', '.notarium-fs-ops'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await f.metaDb.close()
  })

  it('does not report success when the causal address changes before terminal commit', async () => {
    const f = await fixture()
    const base = f.metaDb.restoreTerminal
    let raced = false
    const terminal: RestoreTerminalPersistence = {
      ...base,
      commit: async (input) => {
        if (!raced) {
          raced = true
          const identity = await f.metaDb.identity.findById?.(f.noteId)

          if (!identity) {
            throw new Error('fixture identity disappeared')
          }
          await f.metaDb.identity.claimMany([{ ...identity, filePath: 'moved-concurrently.md' }])
        }

        return base.commit(input)
      },
    }
    const result = await f
      .coordinator(proxiedMetaDb(f.metaDb, { restoreTerminal: terminal }))
      .execute(f.command)

    if (result.status !== 'pending') {
      throw new Error(`expected a recoverable terminal conflict, got ${result.status}`)
    }
    expect(result.phase).toBe('failed-recoverable')
    const operation = await f.metaDb.restoreOperations.get(result.operationId)
    expect(operation).toMatchObject({
      phase: RESTORE_OPERATION_PHASE.failedRecoverable,
      failureCode: 'terminal-identity',
    })
    await f.metaDb.close()
  })

  it('keeps a committed operation pending until the local projection converges', async () => {
    const f = await fixture()
    let repairAttempts = 0
    const spaces = {
      reconcileCausalProjection: async () => {
        repairAttempts++
        if (repairAttempts === 1) {
          throw new Error('projection is still cold')
        }
      },
      resumeLifecycle: async () => {},
    } as unknown as SpaceManager
    const pending = await f.coordinator(f.metaDb, f.authority, spaces).execute(f.command)

    if (pending.status !== 'pending') {
      throw new Error(`expected projection-pending result, got ${pending.status}`)
    }
    expect(pending.phase).toBe('physical-published')
    const completed = await f.coordinator(f.metaDb, f.authority, spaces).execute(f.command)
    expect(completed).toMatchObject({ status: 'succeeded', operationId: pending.operationId })
    const revisions = await f.metaDb.revisions.listByNote('space-a', f.noteId, {
      offset: 0,
      limit: 20,
    })
    expect(
      revisions.items.filter((revision) => revision.kind === REVISION_KIND.restore),
    ).toHaveLength(1)
    await f.metaDb.close()
  })

  it('resumes an accepted operation through closing and keeps fresh work closed', async () => {
    const f = await fixture()
    const base = f.metaDb.restoreOperations
    let crash = true
    const operations: RestoreOperationPersistence = {
      ...base,
      transition: async (input) => {
        if (crash && input.phase === RESTORE_OPERATION_PHASE.prepared) {
          crash = false
          throw new Error('pause accepted operation')
        }

        return base.transition(input)
      },
    }
    const accepted = await f
      .coordinator(proxiedMetaDb(f.metaDb, { restoreOperations: operations }))
      .execute(f.command)

    if (accepted.status !== 'pending') {
      throw new Error(`expected staged accepted result, got ${accepted.status}`)
    }
    expect(accepted.phase).toBe('staged')
    await f.metaDb.spaceLifecycle.transition({
      space: 'space-a',
      expectedPhases: [SPACE_LIFECYCLE_PHASE.active],
      phase: SPACE_LIFECYCLE_PHASE.closing,
      changedAt: '2026-08-11T00:02:00.000Z',
    })
    const resumed = await f.coordinator().execute(f.command)

    expect(resumed).toMatchObject({ status: 'succeeded', operationId: accepted.operationId })
    const replayed = await f.coordinator().execute(f.command)
    expect(replayed).toEqual(resumed)
    await f.metaDb.spaceLifecycle.transition({
      space: 'space-a',
      expectedPhases: [SPACE_LIFECYCLE_PHASE.closing],
      phase: SPACE_LIFECYCLE_PHASE.archived,
      changedAt: '2026-08-11T00:03:00.000Z',
    })
    expect(await f.coordinator().execute(f.command)).toEqual(resumed)
    const fresh = await f.coordinator().execute({
      ...f.command,
      versionToken: resumed.status === 'succeeded' ? resumed.versionToken : f.command.versionToken,
      idempotencyKey: 'fresh-while-closing',
    })
    expect(fresh).toEqual({ status: 'busy', reason: 'space-not-active' })
    await f.metaDb.close()
  })

  it('fails startup recovery on corrupt durable operation evidence', async () => {
    const f = await fixture()
    const base = f.metaDb.restoreOperations
    const operations: RestoreOperationPersistence = {
      ...base,
      transition: async () => {
        throw new Error('pause before prepared evidence')
      },
    }
    const accepted = await f
      .coordinator(proxiedMetaDb(f.metaDb, { restoreOperations: operations }))
      .execute(f.command)

    if (accepted.status !== 'pending') {
      throw new Error(`expected staged corrupt fixture, got ${accepted.status}`)
    }
    expect(accepted.phase).toBe('staged')
    await base.transition({
      id: accepted.operationId,
      expectedPhases: [RESTORE_OPERATION_PHASE.staged],
      phase: RESTORE_OPERATION_PHASE.staged,
      preparedEvidence: '{broken',
      updatedAt: '2026-08-11T00:02:00.000Z',
    })

    await expect(f.coordinator().recover()).rejects.toThrow(/malformed accepted evidence/)
    await f.metaDb.close()
  })
})

describe('RestoreCoordinator eligibility', () => {
  it('restores exact authored bytes while rebinding proven owner fields', async () => {
    const source = new TextEncoder().encode(
      `---\n# authored comment\nnotarium-id: "${NOTE_ID}" # keep\nnotarium-created: '${CREATED_AT}'\nplugin: &value "café"\ncopy: *value\ntitle: Historical\n---\nold body  \n`,
    )
    const ownerProof = bindStorageOwnerProof({
      source,
      owners: [
        { key: 'notarium-id', ownership: 'value' },
        { key: 'notarium-created', ownership: 'value' },
      ],
      evidence: { kind: 'mutation-receipt', id: 'historical-write' },
    })
    const sourceState = analyzeDocumentState({
      source,
      pathFallbackTitle: 'note',
      ownerProof,
    })
    const f = await fixture({ sourceState })
    const result = await f.coordinator().execute(f.command)

    expect(result).toMatchObject({ status: 'succeeded', noteId: f.noteId })
    expect(await readFile(join(roots[0], 'notes', f.targetPath))).toEqual(Buffer.from(source))
    await f.metaDb.close()
  })

  it.each([
    {
      name: 'an honest content gap',
      reason: 'source-content-unavailable',
      options: {
        sourceRecord: {
          content: null,
          stateFormat: null,
          title: 'Unavailable historical state',
        },
      },
    },
    {
      name: 'opaque bytes',
      reason: 'opaque-source',
      options: {
        sourceState: analyzeDocumentState({
          source: Uint8Array.from([0xff, 0xfe, 0x00]),
          pathFallbackTitle: 'note',
        }),
      },
    },
    {
      name: 'unsafe owner anchor dependencies',
      reason: 'unsafe-source',
      options: { sourceState: unsafeHistoricalState() },
    },
    {
      name: 'a changed path-derived title',
      reason: 'path-fallback-mismatch',
      options: {
        sourceState: analyzeDocumentState({
          source: new TextEncoder().encode('historical body\n'),
          pathFallbackTitle: 'historical-name',
        }),
      },
    },
    {
      name: 'a role conversion',
      reason: 'role-mismatch',
      options: {
        targetPath: 'review/SKILL.md',
        sourceClass: 'skill',
        currentClass: 'skill',
        currentState: analyzeDocumentState({
          source: new TextEncoder().encode(
            '---\nname: review\ndescription: Review changes\n---\nCurrent instructions\n',
          ),
          role: DOCUMENT_ROLE.skillRoot,
          pathFallbackTitle: 'SKILL',
          skillDirectoryName: 'review',
        }),
      },
    },
  ])('rejects $name with stable evidence', async ({ options, reason }) => {
    const f = await fixture(options)
    const rejected = await f.coordinator().execute(f.command)

    expect(rejected).toMatchObject({ status: 'not-restorable', reason })
    const replay = await f.coordinator().execute(f.command)
    expect(replay).toEqual(rejected)
    expect(await readFile(join(roots[0], 'notes', f.targetPath))).toEqual(
      Buffer.from(f.currentState.source),
    )
    await f.metaDb.close()
  })

  it('restores only captured fixed fields from a legacy partial row', async () => {
    const currentState = analyzeDocumentState({
      source: new TextEncoder().encode(
        '---\n# keep current extension\ntitle: Current\ntags: [current]\nslug: current\nplugin: keep-verbatim\n---\ncurrent body\n',
      ),
      pathFallbackTitle: 'note',
    })
    const f = await fixture({
      currentState,
      sourceRecord: {
        content: 'legacy body\n',
        stateFormat: null,
        title: 'Legacy title',
        tags: ['legacy', 'captured'],
        slug: 'legacy-slug',
      },
    })
    const result = await f.coordinator().execute(f.command)

    expect(result).toMatchObject({ status: 'succeeded', noteId: f.noteId })
    const restored = await readFile(join(roots[0], 'notes', f.targetPath), 'utf8')
    expect(restored).toContain('# keep current extension')
    expect(restored).toContain('plugin: keep-verbatim')
    expect(restored).toContain('title: Legacy title')
    expect(restored).toContain('tags: [legacy, captured]')
    expect(restored).toContain('slug: legacy-slug')
    expect(restored).toContain('legacy body')
    await f.metaDb.close()
  })

  it('recreates a deleted note from a legacy partial row with empty captured tags', async () => {
    const f = await fixture({
      mode: 'trash',
      sourceRecord: {
        content: 'legacy trash body\n',
        stateFormat: null,
        title: 'Legacy trash title',
        tags: [],
      },
    })
    const result = await f.coordinator().execute(f.trashCommand)

    expect(result).toMatchObject({ status: 'succeeded', noteId: f.noteId })
    const restored = await readFile(join(roots[0], 'notes', f.targetPath), 'utf8')
    expect(restored).toContain('title: Legacy trash title')
    expect(restored).toContain('tags: []')
    expect(restored).toContain('legacy trash body')
    await f.metaDb.close()
  })

  it('binds replay lookup to the actor without exposing another actor result', async () => {
    const f = await fixture()
    const first = await f.coordinator().execute(f.command)

    if (first.status !== 'succeeded') {
      throw new Error(`expected first actor restore to succeed, got ${first.status}`)
    }
    const writer: Principal = {
      id: 'user:bob',
      username: 'bob',
      admin: false,
      scope: 'write',
      grants: new Map([['space-a', 'writer']]),
      spaces: new Set(['space-a']),
      system: false,
    }
    const otherActor = await f.coordinator().execute({ ...f.command, principal: writer })

    expect(otherActor).toMatchObject({ status: 'conflict', reason: 'version-conflict' })
    expect(otherActor).not.toMatchObject({ operationId: first.operationId })
    const outsider: Principal = {
      ...writer,
      id: 'user:eve',
      username: 'eve',
      grants: new Map(),
      spaces: new Set(),
    }
    expect(await f.coordinator().execute({ ...f.command, principal: outsider })).toEqual({
      status: 'not-found',
    })
    await f.metaDb.close()
  })

  it.each([
    ['mount-relative', 'review/SKILL.md', ''],
    ['space-relative production mount', '.notarium/skills/review/SKILL.md', '.notarium/skills'],
  ])(
    'restores a valid skill root under package-exclusive admission (%s)',
    async (_label, targetPath, resourcePrefix) => {
      const sourceState = analyzeDocumentState({
        source: new TextEncoder().encode(
          '---\nname: review\ndescription: Review changes\n---\nHistorical instructions\n',
        ),
        role: DOCUMENT_ROLE.skillRoot,
        pathFallbackTitle: 'SKILL',
        skillDirectoryName: 'review',
      })
      const currentState = analyzeDocumentState({
        source: new TextEncoder().encode(
          '---\nname: review\ndescription: Review changes\n---\nCurrent instructions\n',
        ),
        role: DOCUMENT_ROLE.skillRoot,
        pathFallbackTitle: 'SKILL',
        skillDirectoryName: 'review',
      })
      const f = await fixture({
        targetPath,
        resourcePrefix,
        sourceState,
        currentState,
        sourceClass: 'skill',
        currentClass: 'skill',
      })
      const result = await f.coordinator().execute(f.command)

      expect(result).toMatchObject({ status: 'succeeded', noteId: f.noteId })
      expect(await readFile(join(roots[0], 'notes', f.targetPath), 'utf8')).toContain(
        'Historical instructions',
      )
      await f.metaDb.close()
    },
  )

  it('requires a current valid skill root before restoring an auxiliary file', async () => {
    const sourceState = analyzeDocumentState({
      source: new TextEncoder().encode('---\ntitle: Guide\n---\nhistorical guide\n'),
      role: DOCUMENT_ROLE.skillAuxiliary,
      pathFallbackTitle: 'guide',
    })
    const currentState = analyzeDocumentState({
      source: new TextEncoder().encode('---\ntitle: Guide\n---\ncurrent guide\n'),
      role: DOCUMENT_ROLE.skillAuxiliary,
      pathFallbackTitle: 'guide',
    })
    const valid = await fixture({
      targetPath: 'review/guide.md',
      sourceState,
      currentState,
      sourceClass: 'skill',
      currentClass: 'skill',
    })
    await writeFile(
      join(roots[0], 'notes', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review changes\n---\nInstructions\n',
    )
    expect(await valid.coordinator().execute(valid.command)).toMatchObject({
      status: 'succeeded',
      noteId: valid.noteId,
    })
    await valid.metaDb.close()

    const invalid = await fixture({
      targetPath: 'review/guide.md',
      sourceState,
      currentState,
      sourceClass: 'skill',
      currentClass: 'skill',
    })
    const invalidPackageToken = documentStateVersionToken(
      analyzeDocumentState({
        source: currentState.source,
        role: DOCUMENT_ROLE.generic,
        pathFallbackTitle: 'guide',
      }),
    )
    expect(
      await invalid
        .coordinator()
        .execute({ ...invalid.command, versionToken: invalidPackageToken }),
    ).toMatchObject({
      status: 'not-restorable',
      reason: 'role-mismatch',
    })
    await invalid.metaDb.close()
  })

  it.each([
    ['nested package resource', 'review/references/guide.md', 'review', ''],
    [
      'nested project-package resource',
      '_projects/project-a/review/references/guide.md',
      '_projects/project-a/review',
      '',
    ],
    [
      'production-mounted package resource',
      '.notarium/skills/review/references/guide.md',
      '.notarium/skills/review',
      '.notarium/skills',
    ],
    [
      'production-mounted project-package resource',
      '.notarium/skills/_projects/project-a/review/references/guide.md',
      '.notarium/skills/_projects/project-a/review',
      '.notarium/skills',
    ],
  ])(
    'restores a %s against its canonical skill root',
    async (_label, targetPath, packagePath, resourcePrefix) => {
      const sourceState = analyzeDocumentState({
        source: new TextEncoder().encode('---\ntitle: Guide\n---\nhistorical guide\n'),
        role: DOCUMENT_ROLE.skillAuxiliary,
        pathFallbackTitle: 'guide',
      })
      const currentState = analyzeDocumentState({
        source: new TextEncoder().encode('---\ntitle: Guide\n---\ncurrent guide\n'),
        role: DOCUMENT_ROLE.skillAuxiliary,
        pathFallbackTitle: 'guide',
      })
      const f = await fixture({
        targetPath,
        resourcePrefix,
        sourceState,
        currentState,
        sourceClass: 'skill',
        currentClass: 'skill',
      })

      await writeFile(
        join(roots[0], 'notes', packagePath, 'SKILL.md'),
        `---\nname: review\ndescription: Review changes\n---\nInstructions\n`,
      )
      expect(await f.coordinator().execute(f.command)).toMatchObject({
        status: 'succeeded',
        noteId: f.noteId,
      })
      expect(await readFile(join(roots[0], 'notes', targetPath), 'utf8')).toContain(
        'historical guide',
      )
      await f.metaDb.close()
    },
  )

  it('holds the canonical package lease while restoring a nested skill resource', async () => {
    const targetPath = 'review/references/guide.md'
    const sourceState = analyzeDocumentState({
      source: new TextEncoder().encode('---\ntitle: Guide\n---\nhistorical guide\n'),
      role: DOCUMENT_ROLE.skillAuxiliary,
      pathFallbackTitle: 'guide',
    })
    const currentState = analyzeDocumentState({
      source: new TextEncoder().encode('---\ntitle: Guide\n---\ncurrent guide\n'),
      role: DOCUMENT_ROLE.skillAuxiliary,
      pathFallbackTitle: 'guide',
    })
    const f = await fixture({
      targetPath,
      sourceState,
      currentState,
      sourceClass: 'skill',
      currentClass: 'skill',
    })

    await writeFile(
      join(roots[0], 'notes', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review changes\n---\nInstructions\n',
    )
    let rivalBlocked = false
    const authority = new Proxy(f.authority, {
      get: (target, property, receiver) => {
        if (property === 'admitPackage') {
          return async (...args: Parameters<SpaceResourceAuthority['admitPackage']>) => {
            const lease = await target.admitPackage(...args)

            if (args[2].startsWith('restore:')) {
              await target
                .admitPackage('review', 'exclusive', 'rival-skill-root-write', {
                  deadlineMs: 5,
                })
                .then(
                  (rival) => rival.settle(),
                  () => {
                    rivalBlocked = true
                  },
                )
            }

            return lease
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown

        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    expect(await f.coordinator(f.metaDb, authority).execute(f.command)).toMatchObject({
      status: 'succeeded',
    })
    expect(rivalBlocked).toBe(true)
    await f.metaDb.close()
  })
})
