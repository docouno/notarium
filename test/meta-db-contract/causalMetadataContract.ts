import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  type CausalOutboxPersistence,
  INSTALLATION_GENERATION_PHASE,
  type InstallationGenerationPersistence,
  type OwnerProofPersistence,
  RESTORE_OPERATION_PHASE,
  type RestoreOperationPersistence,
  type RestoreTerminalPersistence,
  type RevisionPersistence,
  SPACE_LIFECYCLE_PHASE,
  type SpaceLifecyclePersistence,
} from '@notarium/core'

export type CausalMetadataContractFactory = () => Promise<{
  operations: RestoreOperationPersistence
  lifecycle: SpaceLifecyclePersistence
  outbox: CausalOutboxPersistence
  installation: InstallationGenerationPersistence
  ownerProofs: OwnerProofPersistence
  revisions: RevisionPersistence
  terminal: RestoreTerminalPersistence
  setAddress(noteId: string, space: string, revision: number): Promise<void>
  teardown?: () => Promise<void>
}>

const operationInput = {
  id: 'operation-a',
  space: 'space-a',
  noteId: 'note-a',
  endpoint: 'history-restore',
  actorDigest: 'actor-a',
  idempotencyDigest: 'key-a',
  requestFingerprint: 'request-a',
  stageBinding: 'stage-a',
  sourceRevisionId: 'accepted-source-a',
  targetPath: 'accepted-note.md',
  preparedEvidence: '{"kind":"accepted"}',
  createdAt: '2026-08-11T00:00:00.000Z',
}

export const describeCausalMetadataContract = (
  name: string,
  factory: CausalMetadataContractFactory,
): void => {
  describe(`causal metadata contract — ${name}`, { timeout: 15_000 }, () => {
    let facets: Awaited<ReturnType<CausalMetadataContractFactory>>

    beforeEach(async () => {
      facets = await factory()
      await Promise.all([
        facets.operations.init(),
        facets.lifecycle.init(),
        facets.outbox.init(),
        facets.installation.init(),
        facets.ownerProofs.init(),
        facets.revisions.init(),
        facets.terminal.init(),
      ])
      await facets.lifecycle.ensure(
        operationInput.space,
        SPACE_LIFECYCLE_PHASE.active,
        operationInput.createdAt,
      )
      await facets.setAddress(operationInput.noteId, operationInput.space, 1)
    })

    afterEach(async () => {
      await facets.teardown?.()
    })

    it('namespaces replay by actor and preserves durable phase evidence', async () => {
      await expect(facets.operations.accept(operationInput)).resolves.toMatchObject({
        status: 'accepted',
        operation: { id: operationInput.id, phase: RESTORE_OPERATION_PHASE.staged },
      })
      await expect(
        facets.operations.accept({ ...operationInput, id: 'ignored-replay' }),
      ).resolves.toMatchObject({ status: 'replayed', operation: { id: operationInput.id } })
      await expect(
        facets.operations.accept({
          ...operationInput,
          id: 'ignored-conflict',
          requestFingerprint: 'request-changed',
        }),
      ).resolves.toMatchObject({
        status: 'idempotency-conflict',
        operation: { id: operationInput.id },
      })
      await expect(
        facets.operations.accept({
          ...operationInput,
          id: 'operation-b',
          actorDigest: 'actor-b',
        }),
      ).resolves.toMatchObject({ status: 'accepted', operation: { id: 'operation-b' } })

      await expect(
        facets.operations.transition({
          id: operationInput.id,
          expectedPhases: [RESTORE_OPERATION_PHASE.staged],
          phase: RESTORE_OPERATION_PHASE.prepared,
          updatedAt: '2026-08-11T00:01:00.000Z',
          sourceRevisionId: 'source-a',
          expectedHeadRevisionId: 'head-a',
          targetPath: 'note.md',
          preparedEvidence: '{"proof":"prepared"}',
        }),
      ).resolves.toMatchObject({
        status: 'transitioned',
        operation: {
          phase: RESTORE_OPERATION_PHASE.prepared,
          sourceRevisionId: 'source-a',
          expectedHeadRevisionId: 'head-a',
          targetPath: 'note.md',
        },
      })
      await expect(
        facets.operations.transition({
          id: operationInput.id,
          expectedPhases: [RESTORE_OPERATION_PHASE.staged],
          phase: RESTORE_OPERATION_PHASE.succeeded,
          updatedAt: '2026-08-11T00:02:00.000Z',
        }),
      ).resolves.toMatchObject({
        status: 'phase-conflict',
        operation: { phase: RESTORE_OPERATION_PHASE.prepared },
      })
      await expect(
        facets.operations.transition({
          id: operationInput.id,
          expectedPhases: [RESTORE_OPERATION_PHASE.prepared],
          phase: RESTORE_OPERATION_PHASE.failedRecoverable,
          updatedAt: '2026-08-11T00:03:00.000Z',
          failureCode: 'publication-interrupted',
        }),
      ).resolves.toMatchObject({ status: 'transitioned' })

      expect((await facets.operations.listRecoverable()).map(({ id }) => id)).toEqual([
        'operation-a',
        'operation-b',
      ])
      expect(
        await facets.operations.getByReplay('actor-a', operationInput.endpoint, 'key-a'),
      ).toMatchObject({ id: operationInput.id, failureCode: 'publication-interrupted' })
    })

    it('admits deterministic children through a live bulk parent while lifecycle is closing', async () => {
      const parent = {
        ...operationInput,
        id: 'bulk-parent',
        noteId: '@bulk:bulk-parent',
        endpoint: 'trash-restore-many',
        actorDigest: 'bulk-actor',
        idempotencyDigest: 'bulk-key',
        requestFingerprint: 'bulk-request',
        stageBinding: 'bulk-stage',
        sourceRevisionId: 'bulk-roster',
        targetPath: '@bulk',
        preparedEvidence: '{"items":[]}',
      }

      await expect(facets.operations.accept(parent)).resolves.toMatchObject({ status: 'accepted' })
      await facets.lifecycle.transition({
        space: operationInput.space,
        expectedPhases: [SPACE_LIFECYCLE_PHASE.active],
        phase: SPACE_LIFECYCLE_PHASE.closing,
        changedAt: '2026-08-11T00:01:00.000Z',
      })
      await expect(
        facets.operations.accept({
          ...operationInput,
          id: 'bulk-child',
          actorDigest: 'child-actor',
          idempotencyDigest: 'child-key',
          parentOperationId: parent.id,
        }),
      ).resolves.toMatchObject({ status: 'accepted', operation: { id: 'bulk-child' } })
      await expect(
        facets.operations.accept({
          ...operationInput,
          id: 'orphan-child',
          actorDigest: 'orphan-actor',
          idempotencyDigest: 'orphan-key',
          parentOperationId: 'missing-parent',
        }),
      ).rejects.toThrow(/parent|lifecycle/)

      const firstUpdate = await facets.operations.transition({
        id: parent.id,
        expectedPhases: [RESTORE_OPERATION_PHASE.staged],
        expectedPreparedEvidence: parent.preparedEvidence,
        phase: RESTORE_OPERATION_PHASE.staged,
        preparedEvidence: '{"items":["done"]}',
        updatedAt: '2026-08-11T00:02:00.000Z',
      })
      expect(firstUpdate).toMatchObject({ status: 'transitioned' })
      await expect(
        facets.operations.transition({
          id: parent.id,
          expectedPhases: [RESTORE_OPERATION_PHASE.staged],
          expectedPreparedEvidence: parent.preparedEvidence,
          phase: RESTORE_OPERATION_PHASE.staged,
          preparedEvidence: '{"items":["lost-update"]}',
          updatedAt: '2026-08-11T00:03:00.000Z',
        }),
      ).resolves.toMatchObject({
        status: 'phase-conflict',
        operation: { preparedEvidence: '{"items":["done"]}' },
      })
    })

    it('pins every accepted note against permanent purge until terminal', async () => {
      const notes = ['pinned-a', 'pinned-b']

      for (const noteId of notes) {
        await facets.revisions.append(
          {
            noteId,
            space: operationInput.space,
            baseRevisionId: null,
            theirRevisionId: null,
            sourceRevisionId: null,
            kind: 'delete',
            entryRole: 'change',
            principal: 'ui',
            contentHash: `${noteId}-hash`,
            stateFormat: null,
            title: noteId,
            class: 'user-doc',
            slug: null,
            tags: [],
            createdAt: operationInput.createdAt,
            charsAdded: 0,
            charsRemoved: 1,
            expectedHeadRevisionId: null,
          },
          noteId,
        )
      }
      await facets.operations.accept({
        ...operationInput,
        id: 'pinning-operation',
        actorDigest: 'pinning-actor',
        idempotencyDigest: 'pinning-key',
        protectedNoteIds: notes,
      })

      await expect(facets.revisions.purgeNotes(operationInput.space, notes)).resolves.toEqual([])
      await facets.operations.transition({
        id: 'pinning-operation',
        expectedPhases: [RESTORE_OPERATION_PHASE.staged],
        phase: RESTORE_OPERATION_PHASE.rejected,
        updatedAt: '2026-08-11T00:04:00.000Z',
      })
      await expect(facets.revisions.purgeNotes(operationInput.space, notes)).resolves.toEqual(notes)
    })

    it('commits restore terminal metadata and outbox as one replay-safe unit', async () => {
      const source = await facets.revisions.append(
        {
          noteId: operationInput.noteId,
          space: operationInput.space,
          baseRevisionId: null,
          theirRevisionId: null,
          sourceRevisionId: null,
          kind: 'write',
          entryRole: 'origin',
          principal: 'ui',
          contentHash: 'source-hash',
          stateFormat: null,
          title: 'Source',
          class: 'user-doc',
          slug: null,
          tags: [],
          createdAt: operationInput.createdAt,
          charsAdded: 6,
          charsRemoved: 0,
          expectedHeadRevisionId: null,
        },
        'source',
      )
      await facets.operations.accept(operationInput)
      await facets.operations.transition({
        id: operationInput.id,
        expectedPhases: [RESTORE_OPERATION_PHASE.staged],
        phase: RESTORE_OPERATION_PHASE.prepared,
        sourceRevisionId: source.id,
        expectedHeadRevisionId: source.id,
        targetPath: 'address-1.md',
        preparedEvidence: 'prepared-a',
        updatedAt: '2026-08-11T00:01:00.000Z',
      })
      await facets.operations.transition({
        id: operationInput.id,
        expectedPhases: [RESTORE_OPERATION_PHASE.prepared],
        phase: RESTORE_OPERATION_PHASE.physicalPublished,
        physicalReceipt: 'receipt-json-a',
        updatedAt: '2026-08-11T00:02:00.000Z',
      })
      const commit = {
        operationId: operationInput.id,
        sourceRevisionId: source.id,
        expectedHeadRevisionId: source.id,
        targetPath: 'address-1.md',
        preparedEvidence: 'prepared-a',
        physicalReceipt: 'receipt-json-a',
        expectedIdentity: {
          addressRevision: 1,
          filePath: 'address-1.md',
          deletedAt: null,
        },
        identity: {
          id: operationInput.noteId,
          addressRevision: 1,
          filePath: 'address-1.md',
          space: operationInput.space,
          createdAt: operationInput.createdAt,
          materialized: true,
          deletedAt: null,
        },
        revision: {
          noteId: operationInput.noteId,
          space: operationInput.space,
          baseRevisionId: source.id,
          theirRevisionId: null,
          sourceRevisionId: source.id,
          kind: 'restore' as const,
          entryRole: 'change' as const,
          principal: 'user:owner',
          contentHash: 'restored-hash',
          semanticFingerprint: 'restored-fingerprint',
          stateFormat: null,
          title: 'Restored',
          class: 'user-doc',
          slug: null,
          tags: ['restored'],
          createdAt: '2026-08-11T00:03:00.000Z',
          charsAdded: 2,
          charsRemoved: 1,
          expectedHeadRevisionId: source.id,
        },
        content: 'restored',
        proof: {
          expectedProofRevision: null,
          sourceHash: 'physical-hash-a',
          proofJson: '{"owner":"note-a"}',
          receiptId: 'proof-receipt-a',
        },
        result: {
          noteId: operationInput.noteId,
          filePath: 'address-1.md',
          versionToken: 'version-restored',
        },
        outboxKind: 'restore-terminal',
        committedAt: '2026-08-11T00:03:00.000Z',
      }

      const first = await facets.terminal.commit(commit)
      expect(first).toMatchObject({
        status: 'committed',
        operation: { phase: RESTORE_OPERATION_PHASE.metadataCommitted },
        result: { revisionId: expect.any(String), versionToken: 'version-restored' },
      })
      if (first.status === 'conflict') {
        throw new Error(`terminal commit unexpectedly conflicted: ${first.conflict}`)
      }
      await expect(facets.terminal.commit(commit)).resolves.toMatchObject({
        status: 'replayed',
        result: first.result,
      })
      expect(await facets.outbox.pending('contract-replica', 10)).toEqual([])
      await expect(
        facets.terminal.finalize({
          operationId: operationInput.id,
          preparedEvidence: commit.preparedEvidence,
          physicalReceipt: commit.physicalReceipt,
          outboxKind: commit.outboxKind,
          finalizedAt: '2026-08-11T00:04:00.000Z',
        }),
      ).resolves.toMatchObject({
        status: 'committed',
        operation: { phase: RESTORE_OPERATION_PHASE.succeeded },
        result: first.result,
      })
      await expect(
        facets.terminal.finalize({
          operationId: operationInput.id,
          preparedEvidence: commit.preparedEvidence,
          physicalReceipt: commit.physicalReceipt,
          outboxKind: commit.outboxKind,
          finalizedAt: '2026-08-11T00:05:00.000Z',
        }),
      ).resolves.toMatchObject({ status: 'replayed', result: first.result })
      expect(
        (
          await facets.revisions.listByNote(operationInput.space, operationInput.noteId, {
            offset: 0,
            limit: 10,
          })
        ).total,
      ).toBe(2)
      expect(await facets.ownerProofs.get(operationInput.noteId)).toMatchObject({
        addressRevision: 1,
        proofRevision: 1,
        receiptId: 'proof-receipt-a',
      })
      expect(await facets.outbox.pending('contract-replica', 10)).toEqual([
        expect.objectContaining({
          kind: 'restore-terminal',
          operationId: operationInput.id,
          resourceId: operationInput.noteId,
        }),
      ])
    })

    it('advances lifecycle generations and exposes only unfinished sagas', async () => {
      await expect(
        facets.lifecycle.transition({
          space: operationInput.space,
          expectedPhases: [SPACE_LIFECYCLE_PHASE.active],
          phase: SPACE_LIFECYCLE_PHASE.closing,
          changedAt: '2026-08-11T01:00:00.000Z',
          changedBy: 'user:owner',
          cleanupManifest: '{"roots":[]}',
        }),
      ).resolves.toMatchObject({
        status: 'transitioned',
        lifecycle: { generation: 2, phase: SPACE_LIFECYCLE_PHASE.closing },
      })
      await expect(
        facets.lifecycle.transition({
          space: operationInput.space,
          expectedPhases: [SPACE_LIFECYCLE_PHASE.active],
          phase: SPACE_LIFECYCLE_PHASE.archived,
          changedAt: '2026-08-11T01:01:00.000Z',
        }),
      ).resolves.toMatchObject({
        status: 'phase-conflict',
        lifecycle: { generation: 2, phase: SPACE_LIFECYCLE_PHASE.closing },
      })
      expect(await facets.lifecycle.listUnfinished()).toEqual([
        expect.objectContaining({ space: operationInput.space, generation: 2 }),
      ])
    })

    it('keeps outbox acknowledgement monotonic and pending order stable', async () => {
      const first = await facets.outbox.append({
        space: operationInput.space,
        generation: 1,
        kind: 'restore-terminal',
        operationId: operationInput.id,
        resourceId: operationInput.noteId,
        createdAt: '2026-08-11T02:00:00.000Z',
      })
      const second = await facets.outbox.append({
        space: operationInput.space,
        generation: 1,
        kind: 'identity-changed',
        operationId: null,
        resourceId: 'note-b',
        createdAt: '2026-08-11T02:01:00.000Z',
      })

      expect((await facets.outbox.pending('contract-replica', 1)).map(({ id }) => id)).toEqual([
        first.id,
      ])
      await facets.outbox.acknowledge(
        'contract-replica',
        [first.id, first.id],
        '2026-08-11T02:02:00.000Z',
      )
      await facets.outbox.acknowledge('contract-replica', [first.id], '2026-08-11T02:03:00.000Z')
      expect(await facets.outbox.pending('contract-replica', 10)).toEqual([second])
      expect(await facets.outbox.pending('peer-replica', 10)).toEqual([first, second])
      await expect(facets.outbox.pending('contract-replica', -1)).rejects.toThrow(
        /non-negative integer/,
      )
    })

    it('CASes receipt-backed proof against the current address revision', async () => {
      const firstInput = {
        noteId: operationInput.noteId,
        space: operationInput.space,
        addressRevision: 1,
        expectedProofRevision: null,
        sourceHash: 'source-a',
        proofJson: '{"claim":"owner-a"}',
        receiptId: 'receipt-a',
        updatedAt: '2026-08-11T02:30:00.000Z',
      }
      await expect(facets.ownerProofs.adopt(firstInput)).resolves.toMatchObject({
        status: 'adopted',
        binding: { proofRevision: 1 },
      })
      await expect(facets.ownerProofs.adopt(firstInput)).resolves.toMatchObject({
        status: 'replayed',
        binding: { proofRevision: 1 },
      })
      await expect(
        facets.ownerProofs.adopt({ ...firstInput, sourceHash: 'receipt-reuse' }),
      ).resolves.toMatchObject({
        status: 'receipt-conflict',
        binding: { proofRevision: 1, sourceHash: 'source-a' },
      })

      const secondInput = {
        ...firstInput,
        expectedProofRevision: 1,
        sourceHash: 'source-b',
        proofJson: '{"claim":"owner-b"}',
        receiptId: 'receipt-b',
        updatedAt: '2026-08-11T02:31:00.000Z',
      }
      await expect(facets.ownerProofs.adopt(secondInput)).resolves.toMatchObject({
        status: 'adopted',
        binding: { proofRevision: 2 },
      })
      await expect(facets.ownerProofs.adopt(firstInput)).resolves.toMatchObject({
        status: 'replayed',
        binding: { proofRevision: 1, receiptId: 'receipt-a' },
      })
      await expect(
        facets.ownerProofs.adopt({
          ...secondInput,
          receiptId: 'receipt-c',
          sourceHash: 'source-c',
        }),
      ).resolves.toMatchObject({
        status: 'proof-conflict',
        binding: { proofRevision: 2 },
      })

      await facets.setAddress(operationInput.noteId, operationInput.space, 2)
      await expect(
        facets.ownerProofs.adopt({
          ...secondInput,
          expectedProofRevision: 2,
          receiptId: 'receipt-d',
        }),
      ).resolves.toEqual({ status: 'address-conflict', addressRevision: 2 })
      expect(await facets.ownerProofs.get(operationInput.noteId)).toMatchObject({
        proofRevision: 2,
        receiptId: 'receipt-b',
      })
    })

    it('compares the complete installation witness across same-generation phases', async () => {
      const installed = {
        generation: 1,
        phase: INSTALLATION_GENERATION_PHASE.activeInstalled,
        activeKeyId: 'key-1',
        activeHash: 'active-1',
        candidateKeyId: null,
        candidateHash: null,
        changedAt: '2026-08-11T03:00:00.000Z',
      }
      await expect(
        facets.installation.compareAndSet({ expected: null, record: installed }),
      ).resolves.toEqual({ status: 'installed', record: installed })

      const candidate = {
        generation: 2,
        phase: INSTALLATION_GENERATION_PHASE.candidateReady,
        activeKeyId: installed.activeKeyId,
        activeHash: installed.activeHash,
        candidateKeyId: 'key-2',
        candidateHash: 'candidate-2',
        changedAt: '2026-08-11T03:01:00.000Z',
      }
      await expect(
        facets.installation.compareAndSet({ expected: installed, record: candidate }),
      ).resolves.toEqual({ status: 'installed', record: candidate })

      const publishing = {
        ...candidate,
        phase: INSTALLATION_GENERATION_PHASE.publishingActive,
        changedAt: '2026-08-11T03:02:00.000Z',
      }
      await expect(
        facets.installation.compareAndSet({ expected: installed, record: publishing }),
      ).resolves.toEqual({ status: 'generation-conflict', record: candidate })
      await expect(
        facets.installation.compareAndSet({ expected: candidate, record: publishing }),
      ).resolves.toEqual({ status: 'installed', record: publishing })
      expect(await facets.installation.current()).toEqual(publishing)
    })

    it('freezes one stable generation and rejects transitions until release or expiry', async () => {
      const installed = {
        generation: 1,
        phase: INSTALLATION_GENERATION_PHASE.activeInstalled,
        activeKeyId: 'key-1',
        activeHash: 'active-1',
        candidateKeyId: null,
        candidateHash: null,
        changedAt: '2026-08-11T04:00:00.000Z',
      }
      await facets.installation.compareAndSet({ expected: null, record: installed })
      const acquired = await facets.installation.acquireBackupFreeze({
        owner: 'backup-a',
        now: '2026-08-11T04:01:00.000Z',
        expiresAt: '2026-08-11T04:02:00.000Z',
      })

      expect(acquired).toMatchObject({
        status: 'acquired',
        freeze: { generation: 1, keyId: 'key-1', activeHash: 'active-1' },
      })
      await expect(
        facets.installation.compareAndSet({
          expected: installed,
          record: {
            generation: 2,
            phase: INSTALLATION_GENERATION_PHASE.candidateReady,
            activeKeyId: 'key-1',
            activeHash: 'active-1',
            candidateKeyId: 'key-2',
            candidateHash: 'candidate-2',
            changedAt: '2026-08-11T04:01:30.000Z',
          },
        }),
      ).resolves.toMatchObject({ status: 'backup-frozen', freeze: { owner: 'backup-a' } })

      if (acquired.status !== 'acquired') {
        throw new Error('expected backup freeze')
      }
      await expect(
        facets.installation.renewBackupFreeze({
          owner: 'backup-a',
          expected: acquired.freeze,
          now: '2026-08-11T04:01:30.000Z',
          expiresAt: '2026-08-11T04:03:00.000Z',
        }),
      ).resolves.toMatchObject({ status: 'renewed' })
      await facets.installation.releaseBackupFreeze('backup-a')
      await expect(
        facets.installation.acquireBackupFreeze({
          owner: 'backup-b',
          now: '2026-08-11T04:02:00.000Z',
          expiresAt: '2026-08-11T04:03:00.000Z',
        }),
      ).resolves.toMatchObject({ status: 'acquired', freeze: { owner: 'backup-b' } })
      await expect(
        facets.installation.recoverExpiredBackupFreeze('2026-08-11T04:04:00.000Z'),
      ).resolves.toBe(true)
    })
  })
}
