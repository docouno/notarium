import { describe, expect, it } from 'vitest'

import { planCausalBarriers } from './barrierPlanner'
import {
  InMemoryCausalOutboxPersistence,
  InMemoryInstallationGenerationPersistence,
  InMemoryRestoreOperationPersistence,
  InMemorySpaceLifecyclePersistence,
} from './inMemory'
import {
  CAUSAL_BARRIER_KIND,
  INSTALLATION_GENERATION_PHASE,
  RESTORE_OPERATION_PHASE,
  SPACE_LIFECYCLE_PHASE,
} from './types'

describe('causal metadata reference contracts', () => {
  it('deduplicates and orders a complete multi-space barrier plan', () => {
    expect(
      planCausalBarriers([
        { kind: CAUSAL_BARRIER_KIND.blob, space: 'b', key: 'hash' },
        { kind: CAUSAL_BARRIER_KIND.note, space: 'b', key: 'note' },
        { kind: CAUSAL_BARRIER_KIND.spaceLifecycle, space: 'a', key: 'a' },
        { kind: CAUSAL_BARRIER_KIND.note, space: 'b', key: 'note' },
        {
          kind: CAUSAL_BARRIER_KIND.installationGeneration,
          space: null,
          key: 'active',
        },
        { kind: CAUSAL_BARRIER_KIND.spaceLifecycle, space: 'b', key: 'b' },
      ]),
    ).toEqual([
      { kind: CAUSAL_BARRIER_KIND.installationGeneration, space: null, key: 'active' },
      { kind: CAUSAL_BARRIER_KIND.spaceLifecycle, space: 'a', key: 'a' },
      { kind: CAUSAL_BARRIER_KIND.spaceLifecycle, space: 'b', key: 'b' },
      { kind: CAUSAL_BARRIER_KIND.note, space: 'b', key: 'note' },
      { kind: CAUSAL_BARRIER_KIND.blob, space: 'b', key: 'hash' },
    ])
  })

  it('isolates restore replay by actor and rejects a changed fingerprint', async () => {
    const lifecycle = new InMemorySpaceLifecyclePersistence()
    await lifecycle.ensure('space', SPACE_LIFECYCLE_PHASE.active, '2026-08-11T00:00:00.000Z')
    const persistence = new InMemoryRestoreOperationPersistence(lifecycle)
    const input = {
      id: 'operation-a',
      space: 'space',
      noteId: 'note',
      endpoint: 'history-restore',
      actorDigest: 'actor-a',
      idempotencyDigest: 'key-a',
      requestFingerprint: 'fingerprint-a',
      stageBinding: 'stage-a',
      sourceRevisionId: 'source-a',
      targetPath: 'note.md',
      preparedEvidence: '{}',
      createdAt: '2026-08-11T00:00:00.000Z',
    }

    await expect(persistence.accept(input)).resolves.toMatchObject({ status: 'accepted' })
    await expect(persistence.accept({ ...input, id: 'ignored-replay' })).resolves.toMatchObject({
      status: 'replayed',
      operation: { id: 'operation-a' },
    })
    await expect(
      persistence.accept({ ...input, id: 'ignored-conflict', requestFingerprint: 'changed' }),
    ).resolves.toMatchObject({
      status: 'idempotency-conflict',
      operation: { id: 'operation-a' },
    })
    await expect(
      persistence.accept({ ...input, id: 'operation-b', actorDigest: 'actor-b' }),
    ).resolves.toMatchObject({ status: 'accepted', operation: { id: 'operation-b' } })

    await expect(
      persistence.transition({
        id: 'operation-a',
        expectedPhases: [RESTORE_OPERATION_PHASE.staged],
        phase: RESTORE_OPERATION_PHASE.prepared,
        updatedAt: '2026-08-11T00:01:00.000Z',
        expectedHeadRevisionId: 'head-a',
        preparedEvidence: '{}',
      }),
    ).resolves.toMatchObject({
      status: 'transitioned',
      operation: { phase: 'prepared', expectedHeadRevisionId: 'head-a' },
    })
  })

  it('matches durable drivers by rejecting root restore admission outside active lifecycle', async () => {
    const lifecycle = new InMemorySpaceLifecyclePersistence()
    await lifecycle.ensure('space', SPACE_LIFECYCLE_PHASE.archived, '2026-08-11T00:00:00.000Z')
    const persistence = new InMemoryRestoreOperationPersistence(lifecycle)

    await expect(
      persistence.accept({
        id: 'operation-archived',
        space: 'space',
        noteId: 'note',
        endpoint: 'history-restore',
        actorDigest: 'actor',
        idempotencyDigest: 'key',
        requestFingerprint: 'request',
        stageBinding: 'stage',
        sourceRevisionId: 'source',
        targetPath: 'note.md',
        preparedEvidence: '{}',
        protectedNoteIds: ['note'],
        createdAt: '2026-08-11T00:00:00.000Z',
      }),
    ).rejects.toThrow('space lifecycle rejects restore admission')
  })

  it('linearizes in-memory admission with lifecycle closure and replay keys', async () => {
    const lifecycle = new InMemorySpaceLifecyclePersistence()
    await lifecycle.ensure('space', SPACE_LIFECYCLE_PHASE.active, '2026-08-11T00:00:00.000Z')
    const persistence = new InMemoryRestoreOperationPersistence(lifecycle)
    const input = {
      id: 'operation-a',
      space: 'space',
      noteId: 'note',
      endpoint: 'history-restore',
      actorDigest: 'actor',
      idempotencyDigest: 'key',
      requestFingerprint: 'request',
      stageBinding: 'stage',
      sourceRevisionId: 'source',
      targetPath: 'note.md',
      preparedEvidence: '{}',
      createdAt: '2026-08-11T00:00:00.000Z',
    }
    const realGet = lifecycle.get.bind(lifecycle)
    let releaseGet!: () => void
    const getHeld = new Promise<void>((resolve) => {
      releaseGet = resolve
    })
    let enteredGet!: () => void
    const getEntered = new Promise<void>((resolve) => {
      enteredGet = resolve
    })

    lifecycle.get = async (space) => {
      enteredGet()
      await getHeld
      return realGet(space)
    }
    const accepting = persistence.accept(input)
    await getEntered
    let closureSettled = false
    const closing = lifecycle
      .transition({
        space: 'space',
        expectedPhases: [SPACE_LIFECYCLE_PHASE.active],
        phase: SPACE_LIFECYCLE_PHASE.closing,
        changedAt: '2026-08-11T00:01:00.000Z',
      })
      .then((result) => {
        closureSettled = true
        return result
      })

    await Promise.resolve()
    expect(closureSettled).toBe(false)
    releaseGet()
    await expect(accepting).resolves.toMatchObject({ status: 'accepted' })
    await expect(closing).resolves.toMatchObject({ status: 'transitioned' })

    const replayLifecycle = new InMemorySpaceLifecyclePersistence()
    await replayLifecycle.ensure('space', SPACE_LIFECYCLE_PHASE.active, '2026-08-11T00:00:00.000Z')
    const replayPersistence = new InMemoryRestoreOperationPersistence(replayLifecycle)
    const [first, second] = await Promise.all([
      replayPersistence.accept(input),
      replayPersistence.accept({ ...input, id: 'operation-b' }),
    ])

    expect([first.status, second.status].sort()).toEqual(['accepted', 'replayed'])
    expect(first.operation.id).toBe('operation-a')
    expect(second.operation.id).toBe('operation-a')
    expect(await replayPersistence.listRecoverable()).toHaveLength(1)
  })

  it('keeps lifecycle generations, outbox wakeups and installation CAS honest', async () => {
    const lifecycle = new InMemorySpaceLifecyclePersistence()
    const outbox = new InMemoryCausalOutboxPersistence()
    const installation = new InMemoryInstallationGenerationPersistence()

    await lifecycle.ensure('space', SPACE_LIFECYCLE_PHASE.active, '2026-08-11T00:00:00.000Z')
    await expect(
      lifecycle.transition({
        space: 'space',
        expectedPhases: [SPACE_LIFECYCLE_PHASE.active],
        phase: SPACE_LIFECYCLE_PHASE.closing,
        changedAt: '2026-08-11T00:01:00.000Z',
      }),
    ).resolves.toMatchObject({
      status: 'transitioned',
      lifecycle: { generation: 2, phase: 'closing' },
    })
    await outbox.append({
      space: 'space',
      generation: 2,
      kind: 'restore-terminal',
      operationId: 'operation-a',
      resourceId: 'note',
      createdAt: '2026-08-11T00:02:00.000Z',
    })
    expect(await outbox.pending('replica-a', 10)).toHaveLength(1)
    await outbox.acknowledge('replica-a', ['1'], '2026-08-11T00:03:00.000Z')
    expect(await outbox.pending('replica-a', 10)).toEqual([])
    expect(await outbox.pending('replica-b', 10)).toHaveLength(1)

    await expect(
      installation.compareAndSet({
        expected: null,
        record: {
          generation: 1,
          phase: INSTALLATION_GENERATION_PHASE.activeInstalled,
          activeKeyId: 'key-1',
          activeHash: 'hash-1',
          candidateKeyId: null,
          candidateHash: null,
          changedAt: '2026-08-11T00:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({ status: 'installed' })
    await expect(
      installation.compareAndSet({
        expected: null,
        record: {
          generation: 2,
          phase: INSTALLATION_GENERATION_PHASE.candidateReady,
          activeKeyId: 'key-1',
          activeHash: 'hash-1',
          candidateKeyId: 'key-2',
          candidateHash: 'hash-2',
          changedAt: '2026-08-11T00:04:00.000Z',
        },
      }),
    ).resolves.toMatchObject({ status: 'generation-conflict', record: { generation: 1 } })
  })
})
