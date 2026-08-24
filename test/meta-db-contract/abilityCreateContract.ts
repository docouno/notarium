import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DOCUMENT_STATE_FORMAT, sha256Hex, SPACE_LIFECYCLE_PHASE } from '@notarium/core'

import type { MetaDb } from '../../packages/server/src/services/metaDb/types'

type Host = Pick<
  MetaDb,
  | 'abilityCreate'
  | 'abilityAvailability'
  | 'causalOutbox'
  | 'identity'
  | 'revisions'
  | 'spaceLifecycle'
  | 'spaces'
>

const SPACE = 'space-main'
const AT = '2026-08-22T12:00:00.000Z'

const acceptance = (over: Record<string, unknown> = {}) => ({
  id: 'ability-operation-one',
  actorDigest: 'actor-digest',
  idempotencyDigest: 'idempotency-digest',
  requestFingerprint: 'request-fingerprint',
  space: SPACE,
  packageId: 'PackageId001',
  noteId: 'RegistryNote1',
  targetPath: '.notarium/skills/PackageId001/SKILL.md',
  availabilityRequired: true,
  stageBinding: 'stage-binding',
  preparedEvidence: '{"version":1}',
  identity: {
    id: 'RegistryNote1',
    filePath: '.notarium/skills/PackageId001/SKILL.md',
    space: SPACE,
    createdAt: AT,
    materialized: false,
    deletedAt: null,
    addressRevision: 1,
    legacyNameAliases: [],
  },
  availability: { mode: 'all-projects' as const },
  createdAt: AT,
  ...over,
})

export const describeAbilityCreateContract = (
  name: string,
  factory: () => Promise<{ db: Host; teardown?: () => Promise<void> }>,
): void => {
  describe(`Durable ability create persistence — ${name}`, { timeout: 15_000 }, () => {
    let db: Host
    let teardown: (() => Promise<void>) | undefined

    beforeEach(async () => {
      ;({ db, teardown } = await factory())
      await db.spaces.upsert({
        id: SPACE,
        slug: 'main',
        displayName: 'Main',
        notesDir: 'main',
        aliases: [],
        createdAt: AT,
        archivedAt: null,
        archivedBy: null,
      })
    })

    afterEach(async () => teardown?.())

    it('reserves identity/reach once and binds replay to the request fingerprint', async () => {
      const first = await db.abilityCreate.accept(acceptance())

      expect(first).toMatchObject({ status: 'accepted', operation: { phase: 'accepted' } })
      expect(await db.identity.findById?.('RegistryNote1')).toMatchObject({
        filePath: '.notarium/skills/PackageId001/SKILL.md',
        materialized: false,
      })
      expect(await db.abilityAvailability.get(SPACE, 'PackageId001')).toEqual({
        homeSpace: SPACE,
        packageId: 'PackageId001',
        mode: 'all-projects',
      })
      await expect(db.abilityCreate.accept(acceptance())).resolves.toMatchObject({
        status: 'replayed',
        operation: { id: 'ability-operation-one' },
      })
      await expect(
        db.abilityCreate.accept(acceptance({ requestFingerprint: 'different' })),
      ).resolves.toMatchObject({ status: 'idempotency-conflict' })
      await expect(
        db.abilityCreate.findReplay({
          actorDigest: 'actor-digest',
          idempotencyDigest: 'idempotency-digest',
          requestFingerprint: 'request-fingerprint',
        }),
      ).resolves.toMatchObject({
        status: 'replayed',
        operation: { id: 'ability-operation-one' },
      })
      await expect(
        db.abilityCreate.findReplay({
          actorDigest: 'actor-digest',
          idempotencyDigest: 'idempotency-digest',
          requestFingerprint: 'different',
        }),
      ).resolves.toMatchObject({ status: 'idempotency-conflict' })
    })

    it('arbitrates concurrent replay once and keeps a different fingerprint conflicting', async () => {
      const same = await Promise.all([
        db.abilityCreate.accept(acceptance()),
        db.abilityCreate.accept(
          acceptance({
            id: 'ability-operation-two',
            packageId: 'PackageId002',
            noteId: 'RegistryNote2',
            targetPath: '.notarium/skills/PackageId002/SKILL.md',
            identity: {
              ...acceptance().identity,
              id: 'RegistryNote2',
              filePath: '.notarium/skills/PackageId002/SKILL.md',
            },
          }),
        ),
      ])

      expect(same.map(({ status }) => status).sort()).toEqual(['accepted', 'replayed'])
      const sameOperations = same.flatMap((result) =>
        'operation' in result ? [result.operation.id] : [],
      )
      expect(new Set(sameOperations).size).toBe(1)

      const differentBase = {
        actorDigest: 'other-actor',
        idempotencyDigest: 'other-key',
      }
      const different = await Promise.all([
        db.abilityCreate.accept(
          acceptance({
            ...differentBase,
            id: 'different-operation-one',
            packageId: 'PackageId003',
            noteId: 'RegistryNote3',
            targetPath: '.notarium/skills/PackageId003/SKILL.md',
            identity: {
              ...acceptance().identity,
              id: 'RegistryNote3',
              filePath: '.notarium/skills/PackageId003/SKILL.md',
            },
          }),
        ),
        db.abilityCreate.accept(
          acceptance({
            ...differentBase,
            id: 'different-operation-two',
            requestFingerprint: 'different-request',
            packageId: 'PackageId004',
            noteId: 'RegistryNote4',
            targetPath: '.notarium/skills/PackageId004/SKILL.md',
            identity: {
              ...acceptance().identity,
              id: 'RegistryNote4',
              filePath: '.notarium/skills/PackageId004/SKILL.md',
            },
          }),
        ),
      ])

      expect(different.map(({ status }) => status).sort()).toEqual([
        'accepted',
        'idempotency-conflict',
      ])
    })

    it('commits an accepted operation through closing and replays a lost terminal ACK', async () => {
      const accepted = await db.abilityCreate.accept(acceptance())
      expect(accepted.status).toBe('accepted')
      const physicalReceipt = '{"operationId":"ability-operation-one"}'
      await db.abilityCreate.markPhysical(
        'ability-operation-one',
        '{"version":1}',
        physicalReceipt,
        AT,
      )
      const content = new TextEncoder().encode('encoded skill state')
      const contentHash = await sha256Hex(content)
      const input = {
        operationId: 'ability-operation-one',
        preparedEvidence: '{"version":1}',
        physicalReceipt,
        identity: {
          ...acceptance().identity,
          materialized: true,
        },
        revision: {
          noteId: 'RegistryNote1',
          space: SPACE,
          baseRevisionId: null,
          expectedHeadRevisionId: null,
          theirRevisionId: null,
          sourceRevisionId: null,
          kind: 'write' as const,
          entryRole: 'origin' as const,
          principal: 'pat:agent:one',
          agent: {
            owner: 'alice',
            agent: 'Codex',
            session: { id: 'session-one', name: 'V8', attach: 'declared' as const },
          },
          contentHash,
          semanticFingerprint: 'semantic-fingerprint',
          stateFormat: DOCUMENT_STATE_FORMAT.skill,
          restoreSafety: 'safe' as const,
          title: 'Durable proof',
          class: 'skill',
          slug: null,
          tags: [],
          createdAt: AT,
          charsAdded: 19,
          charsRemoved: 0,
        },
        content,
        ownerProof: {
          sourceHash: await sha256Hex(new TextEncoder().encode('source')),
          proofJson: '{"claims":[]}',
          receiptId: 'ability-operation-one',
        },
        result: {
          packageId: 'PackageId001',
          noteId: 'RegistryNote1',
          versionToken: 'version-one',
        },
        committedAt: AT,
      }
      await db.spaceLifecycle.transition({
        space: SPACE,
        expectedPhases: [SPACE_LIFECYCLE_PHASE.active],
        phase: SPACE_LIFECYCLE_PHASE.closing,
        changedAt: AT,
      })
      await expect(
        db.abilityCreate.accept(
          acceptance({
            id: 'fresh-while-closing',
            actorDigest: 'fresh-actor',
            idempotencyDigest: 'fresh-key',
            packageId: 'PackageId002',
            noteId: 'RegistryNote2',
            targetPath: '.notarium/skills/PackageId002/SKILL.md',
            identity: {
              ...acceptance().identity,
              id: 'RegistryNote2',
              filePath: '.notarium/skills/PackageId002/SKILL.md',
            },
          }),
        ),
      ).rejects.toThrow(/lifecycle|active/i)
      const committed = await db.abilityCreate.commit(input)

      expect(committed).toMatchObject({
        status: 'committed',
        result: {
          packageId: 'PackageId001',
          noteId: 'RegistryNote1',
          versionToken: 'version-one',
          revisionId: expect.any(String),
        },
      })
      expect(await db.identity.findById?.('RegistryNote1')).toMatchObject({ materialized: true })
      const revisions = await db.revisions.listByNote(SPACE, 'RegistryNote1', {
        offset: 0,
        limit: 10,
      })
      expect(revisions.items).toHaveLength(1)
      expect(revisions.items[0]).toMatchObject({
        entryRole: 'origin',
        principal: 'pat:agent:one',
        agent: { owner: 'alice', agent: 'Codex' },
      })
      await expect(db.causalOutbox.pending('ability-contract-replica', 10)).resolves.toEqual([
        expect.objectContaining({
          kind: 'ability-create-committed',
          operationId: 'ability-operation-one',
          resourceId: 'RegistryNote1',
        }),
      ])
      await expect(db.abilityCreate.commit(input)).resolves.toMatchObject({
        status: 'replayed',
        operation: { phase: 'metadata-committed' },
        result: { revisionId: committed.status === 'committed' ? committed.result.revisionId : '' },
      })
      await expect(
        db.abilityCreate.finalize('ability-operation-one', '{"version":1}', physicalReceipt, AT),
      ).resolves.toMatchObject({ phase: 'succeeded' })
      await expect(db.abilityCreate.commit(input)).resolves.toMatchObject({
        status: 'replayed',
        result: { revisionId: committed.status === 'committed' ? committed.result.revisionId : '' },
      })
      expect(
        (await db.revisions.listByNote(SPACE, 'RegistryNote1', { offset: 0, limit: 10 })).items,
      ).toHaveLength(1)
    })

    it('rejects only a pre-physical operation and releases its provisional rows', async () => {
      await db.abilityCreate.accept(acceptance())
      await db.abilityCreate.reject('ability-operation-one', 'physical-conflict', AT)

      expect(await db.abilityCreate.get('ability-operation-one')).toMatchObject({
        phase: 'rejected',
      })
      expect(await db.identity.findById?.('RegistryNote1')).toBeNull()
      expect(await db.abilityAvailability.get(SPACE, 'PackageId001')).toBeNull()
    })

    it('keeps a rejected operation observable without burning its success-only replay key', async () => {
      await db.abilityCreate.accept(acceptance())
      await db.abilityCreate.reject('ability-operation-one', 'ability-name-conflict', AT)

      await expect(
        db.abilityCreate.findReplay({
          actorDigest: 'actor-digest',
          idempotencyDigest: 'idempotency-digest',
          requestFingerprint: 'request-fingerprint',
        }),
      ).resolves.toEqual({ status: 'missing' })
      await expect(
        db.abilityCreate.accept(
          acceptance({
            id: 'ability-operation-two',
            packageId: 'PackageId002',
            noteId: 'RegistryNote2',
            targetPath: '.notarium/skills/PackageId002/SKILL.md',
            identity: {
              ...acceptance().identity,
              id: 'RegistryNote2',
              filePath: '.notarium/skills/PackageId002/SKILL.md',
            },
          }),
        ),
      ).resolves.toMatchObject({
        status: 'accepted',
        operation: { id: 'ability-operation-two' },
      })
      await expect(db.abilityCreate.get('ability-operation-one')).resolves.toMatchObject({
        phase: 'rejected',
        failureCode: 'ability-name-conflict',
      })
    })
  })
}
