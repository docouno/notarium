import { describe, expect, it } from 'vitest'

import {
  InMemoryCausalOutboxPersistence,
  InMemoryInstallationGenerationPersistence,
  InMemoryOwnerProofPersistence,
  InMemoryRestoreOperationPersistence,
  InMemoryRestoreTerminalPersistence,
  InMemoryRevisionPersistence,
  InMemorySpaceLifecyclePersistence,
  RESTORE_OPERATION_PHASE,
  type RevisionInput,
  SPACE_LIFECYCLE_PHASE,
} from '@notarium/core'

import { InMemoryAgentDeltaCursors } from '../fake-server/agentDeltaCursors'
import { InMemoryAgentSessions } from '../fake-server/agentSessions'
import { InMemoryFavorites } from '../fake-server/favorites'
import { InMemoryFolders } from '../fake-server/folders'
import { InMemoryGatewayState } from '../fake-server/gatewayState'
import { InMemoryProjects } from '../fake-server/projects'
import { describeAgentDeltaCursorsContract } from './agentDeltaCursorsContract'
import { describeAgentSessionsContract } from './agentSessionsContract'
import { describeCausalMetadataContract } from './causalMetadataContract'
import { describeFavoritesContract } from './favoritesContract'
import { describeGatewayStateContract } from './gatewayStateContract'
import { describeRevisionPersistenceContract } from './revisionPersistenceContract'

describeGatewayStateContract('in-memory twin', async () => ({
  persistence: new InMemoryGatewayState(),
}))

describeAgentDeltaCursorsContract('in-memory twin', async () => {
  const persistence = new InMemoryAgentDeltaCursors()
  const projects = new InMemoryProjects()
  const folders = new InMemoryFolders(projects)
  const sessions = new InMemoryAgentSessions()
  projects.attachLifecycle(persistence)
  sessions.attachLifecycle(persistence)
  return { persistence, sessions, projects, folders }
})

describeAgentSessionsContract('in-memory twin', async () => ({
  persistence: new InMemoryAgentSessions(),
}))

describeFavoritesContract('in-memory twin', async () => ({ persistence: new InMemoryFavorites() }))

describeRevisionPersistenceContract('in-memory twin', async () => {
  const persistence = new InMemoryRevisionPersistence()
  return {
    persistence,
    quarantine: async (revisionIds) => {
      persistence.quarantineForTest(revisionIds)
    },
  }
})

describeCausalMetadataContract('in-memory twin', async () => {
  const ownerProofs = new InMemoryOwnerProofPersistence()
  const lifecycle = new InMemorySpaceLifecyclePersistence()
  const outbox = new InMemoryCausalOutboxPersistence()
  const revisions = new InMemoryRevisionPersistence()
  const operations = new InMemoryRestoreOperationPersistence(lifecycle, revisions)
  const terminal = new InMemoryRestoreTerminalPersistence({
    operations,
    lifecycle,
    outbox,
    revisions,
    ownerProofs,
  })
  return {
    operations,
    lifecycle,
    outbox,
    revisions,
    terminal,
    installation: new InMemoryInstallationGenerationPersistence(),
    ownerProofs,
    setAddress: async (noteId, space, revision) => {
      ownerProofs.setAddress(noteId, space, revision)
      terminal.setIdentity({
        id: noteId,
        addressRevision: revision,
        filePath: `address-${revision}.md`,
        space,
        createdAt: null,
        materialized: true,
        deletedAt: null,
      })
    },
  }
})

describe('in-memory restore terminal integrity parity', () => {
  it('uses only trusted rows for both the source and revision head', async () => {
    const lifecycle = new InMemorySpaceLifecyclePersistence()
    const revisions = new InMemoryRevisionPersistence()
    const operations = new InMemoryRestoreOperationPersistence(lifecycle, revisions)
    const ownerProofs = new InMemoryOwnerProofPersistence()
    const terminal = new InMemoryRestoreTerminalPersistence({
      operations,
      lifecycle,
      revisions,
      ownerProofs,
      outbox: new InMemoryCausalOutboxPersistence(),
    })
    const space = 'integrity-space'
    const at = '2026-08-13T00:00:00.000Z'

    await lifecycle.ensure(space, SPACE_LIFECYCLE_PHASE.active, at)

    const attempt = async (
      suffix: string,
      quarantine: 'source' | 'newer',
    ): Promise<Awaited<ReturnType<typeof terminal.commit>>> => {
      const noteId = `note-${suffix}`
      const operationId = `operation-${suffix}`
      const path = `${suffix}.md`
      const source = await revisions.append(
        {
          noteId,
          space,
          baseRevisionId: null,
          theirRevisionId: null,
          sourceRevisionId: null,
          kind: 'write',
          entryRole: 'origin',
          principal: 'ui',
          contentHash: `source-hash-${suffix}`,
          stateFormat: null,
          title: `Source ${suffix}`,
          class: 'user-doc',
          slug: null,
          tags: [],
          createdAt: at,
          charsAdded: 1,
          charsRemoved: 0,
          expectedHeadRevisionId: null,
        },
        `source ${suffix}`,
      )

      if (quarantine === 'source') {
        revisions.quarantineForTest([source.id])
      } else {
        const { id: sourceId, ...sourceInput } = source
        const newer = await revisions.append(
          {
            ...sourceInput,
            baseRevisionId: sourceId,
            contentHash: `newer-hash-${suffix}`,
            entryRole: 'change',
            expectedHeadRevisionId: sourceId,
          },
          `newer ${suffix}`,
        )
        revisions.quarantineForTest([newer.id])
      }

      terminal.setIdentity({
        id: noteId,
        addressRevision: 1,
        filePath: path,
        space,
        createdAt: null,
        materialized: true,
        deletedAt: null,
      })
      await operations.accept({
        id: operationId,
        space,
        noteId,
        endpoint: 'history-restore',
        actorDigest: `actor-${suffix}`,
        idempotencyDigest: `key-${suffix}`,
        requestFingerprint: `request-${suffix}`,
        stageBinding: `stage-${suffix}`,
        sourceRevisionId: source.id,
        targetPath: path,
        preparedEvidence: `prepared-${suffix}`,
        createdAt: at,
      })
      await operations.transition({
        id: operationId,
        expectedPhases: [RESTORE_OPERATION_PHASE.staged],
        phase: RESTORE_OPERATION_PHASE.prepared,
        sourceRevisionId: source.id,
        expectedHeadRevisionId: source.id,
        targetPath: path,
        preparedEvidence: `prepared-${suffix}`,
        updatedAt: at,
      })
      await operations.transition({
        id: operationId,
        expectedPhases: [RESTORE_OPERATION_PHASE.prepared],
        phase: RESTORE_OPERATION_PHASE.physicalPublished,
        physicalReceipt: `receipt-${suffix}`,
        updatedAt: at,
      })

      return terminal.commit({
        operationId,
        sourceRevisionId: source.id,
        expectedHeadRevisionId: source.id,
        targetPath: path,
        preparedEvidence: `prepared-${suffix}`,
        physicalReceipt: `receipt-${suffix}`,
        expectedIdentity: { addressRevision: 1, filePath: path, deletedAt: null },
        identity: {
          id: noteId,
          addressRevision: 1,
          filePath: path,
          space,
          createdAt: null,
          materialized: true,
          deletedAt: null,
        },
        revision: {
          noteId,
          space,
          baseRevisionId: source.id,
          theirRevisionId: null,
          sourceRevisionId: source.id,
          kind: 'restore',
          entryRole: 'change',
          principal: 'ui',
          contentHash: `restore-hash-${suffix}`,
          semanticFingerprint: `restore-fingerprint-${suffix}`,
          stateFormat: null,
          title: `Restored ${suffix}`,
          class: 'user-doc',
          slug: null,
          tags: [],
          createdAt: at,
          charsAdded: 1,
          charsRemoved: 1,
          expectedHeadRevisionId: source.id,
        },
        content: `restored ${suffix}`,
        proof: {
          expectedProofRevision: null,
          sourceHash: `physical-hash-${suffix}`,
          proofJson: `{"owner":"${noteId}"}`,
          receiptId: operationId,
        },
        result: { noteId, filePath: path, versionToken: `version-${suffix}` },
        outboxKind: 'restore-terminal',
        committedAt: at,
      })
    }

    await expect(attempt('trusted-head', 'newer')).resolves.toMatchObject({ status: 'committed' })
    await expect(attempt('withheld-source', 'source')).resolves.toMatchObject({
      status: 'conflict',
      conflict: 'operation-evidence',
    })
  })

  it('rolls back every facet when commit or finalize fails after a mutation', async () => {
    const lifecycle = new InMemorySpaceLifecyclePersistence()
    const revisions = new InMemoryRevisionPersistence()
    const operations = new InMemoryRestoreOperationPersistence(lifecycle, revisions)
    const ownerProofs = new InMemoryOwnerProofPersistence()
    const outbox = new InMemoryCausalOutboxPersistence()
    const terminal = new InMemoryRestoreTerminalPersistence({
      operations,
      lifecycle,
      revisions,
      ownerProofs,
      outbox,
    })
    const space = 'atomic-space'
    const noteId = 'atomic-note'
    const operationId = 'atomic-operation'
    const path = 'atomic.md'
    const at = '2026-08-13T01:00:00.000Z'

    await lifecycle.ensure(space, SPACE_LIFECYCLE_PHASE.active, at)
    const source = await revisions.append(
      {
        noteId,
        space,
        baseRevisionId: null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: 'delete',
        entryRole: 'change',
        principal: 'ui',
        contentHash: 'atomic-source-hash',
        stateFormat: null,
        title: 'Atomic source',
        class: 'user-doc',
        slug: null,
        tags: [],
        createdAt: at,
        charsAdded: 0,
        charsRemoved: 1,
        expectedHeadRevisionId: null,
      },
      'atomic source',
    )
    terminal.setIdentity({
      id: noteId,
      addressRevision: 1,
      filePath: path,
      space,
      createdAt: null,
      materialized: false,
      deletedAt: at,
    })
    await operations.accept({
      id: operationId,
      space,
      noteId,
      endpoint: 'history-restore',
      actorDigest: 'atomic-actor',
      idempotencyDigest: 'atomic-key',
      requestFingerprint: 'atomic-request',
      stageBinding: 'atomic-stage',
      sourceRevisionId: source.id,
      targetPath: path,
      preparedEvidence: 'atomic-prepared',
      createdAt: at,
    })
    await operations.transition({
      id: operationId,
      expectedPhases: [RESTORE_OPERATION_PHASE.staged],
      phase: RESTORE_OPERATION_PHASE.prepared,
      sourceRevisionId: source.id,
      expectedHeadRevisionId: source.id,
      targetPath: path,
      preparedEvidence: 'atomic-prepared',
      updatedAt: at,
    })
    await operations.transition({
      id: operationId,
      expectedPhases: [RESTORE_OPERATION_PHASE.prepared],
      phase: RESTORE_OPERATION_PHASE.physicalPublished,
      physicalReceipt: 'atomic-receipt',
      updatedAt: at,
    })
    const commit = {
      operationId,
      sourceRevisionId: source.id,
      expectedHeadRevisionId: source.id,
      targetPath: path,
      preparedEvidence: 'atomic-prepared',
      physicalReceipt: 'atomic-receipt',
      expectedIdentity: { addressRevision: 1, filePath: path, deletedAt: at },
      identity: {
        id: noteId,
        addressRevision: 1,
        filePath: path,
        space,
        createdAt: null,
        materialized: true,
        deletedAt: null,
      },
      revision: {
        noteId,
        space,
        baseRevisionId: source.id,
        theirRevisionId: null,
        sourceRevisionId: source.id,
        kind: 'restore' as const,
        entryRole: 'change' as const,
        principal: 'ui',
        contentHash: 'atomic-restore-hash',
        semanticFingerprint: 'atomic-restore-fingerprint',
        stateFormat: null,
        title: 'Atomic restore',
        class: 'user-doc',
        slug: null,
        tags: [],
        createdAt: at,
        charsAdded: 1,
        charsRemoved: 1,
        expectedHeadRevisionId: source.id,
      },
      content: 'atomic restored',
      proof: {
        expectedProofRevision: null,
        sourceHash: 'atomic-physical-hash',
        proofJson: '{"owner":"atomic-note"}',
        receiptId: operationId,
      },
      result: { noteId, filePath: path, versionToken: 'atomic-version' },
      outboxKind: 'restore-terminal',
      committedAt: at,
    }
    const adopt = ownerProofs.adoptForRestoreTerminal.bind(ownerProofs)

    ownerProofs.adoptForRestoreTerminal = (input) => {
      adopt(input)
      throw new Error('transient proof store failure')
    }
    await expect(terminal.commit(commit)).rejects.toThrow('transient proof store failure')
    expect(await operations.get(operationId)).toMatchObject({
      phase: RESTORE_OPERATION_PHASE.physicalPublished,
    })
    expect(await revisions.latestFor(space, noteId)).toMatchObject({ id: source.id })
    expect(await ownerProofs.get(noteId)).toBeNull()

    ownerProofs.adoptForRestoreTerminal = adopt
    const append = revisions.appendForRestoreTerminal.bind(revisions)
    let competingProof: ReturnType<InMemoryOwnerProofPersistence['adopt']> | undefined

    revisions.appendForRestoreTerminal = (revision, content) => {
      const appended = append(revision, content)

      queueMicrotask(() => {
        competingProof = ownerProofs.adopt({
          noteId,
          space,
          expectedProofRevision: null,
          addressRevision: 2,
          sourceHash: 'rival-hash',
          proofJson: '{"owner":"rival"}',
          receiptId: 'rival-receipt',
          updatedAt: at,
        })
      })
      return appended
    }
    await expect(terminal.commit(commit)).resolves.toMatchObject({ status: 'committed' })
    await Promise.resolve()
    await expect(competingProof).resolves.toMatchObject({ status: 'proof-conflict' })
    revisions.appendForRestoreTerminal = append

    const transition = operations.transitionForRestoreTerminal.bind(operations)

    operations.transitionForRestoreTerminal = (input) => {
      const result = transition(input)

      if (input.phase === RESTORE_OPERATION_PHASE.succeeded) {
        throw new Error('transient operation store failure')
      }

      return result
    }
    const finalize = {
      operationId,
      preparedEvidence: 'atomic-prepared',
      physicalReceipt: 'atomic-receipt',
      outboxKind: 'restore-terminal',
      finalizedAt: at,
    }

    await expect(terminal.finalize(finalize)).rejects.toThrow('transient operation store failure')
    expect(await operations.get(operationId)).toMatchObject({
      phase: RESTORE_OPERATION_PHASE.metadataCommitted,
    })
    expect(await outbox.pending('atomic-subscriber', 10)).toEqual([])

    operations.transitionForRestoreTerminal = transition
    await expect(terminal.finalize(finalize)).resolves.toMatchObject({ status: 'committed' })
    expect(await outbox.pending('atomic-subscriber', 10)).toHaveLength(1)
  })
})

describe('in-memory revision test reset', () => {
  it('clear removes terminal fences before the next fake-server seed', async () => {
    const persistence = new InMemoryRevisionPersistence()
    const input: RevisionInput = {
      noteId: 'reseeded-note',
      space: 'reseeded-space',
      baseRevisionId: null,
      theirRevisionId: null,
      sourceRevisionId: null,
      kind: 'write',
      entryRole: 'origin',
      principal: 'ui',
      contentHash: 'reseeded-hash',
      stateFormat: null,
      title: 'Reseeded',
      class: 'user-doc',
      slug: null,
      tags: [],
      createdAt: '2026-07-23T00:00:00.000Z',
      charsAdded: 1,
      charsRemoved: 0,
    }

    await persistence.append(input, 'before reset')
    await persistence.purgeNotes(input.space, [input.noteId])
    await expect(persistence.append(input, 'late')).rejects.toThrow(/permanently purged/)

    persistence.clear()

    await expect(persistence.append(input, 'after reset')).resolves.toMatchObject({
      id: '1',
      noteId: input.noteId,
    })
  })
})
