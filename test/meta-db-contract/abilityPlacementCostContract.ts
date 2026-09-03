import { describe, expect, it } from 'vitest'

import { serializeAbilityLocator } from '@notarium/core'

import type {
  AbilityPlacementPersistence,
  AgentSessionsPersistence,
  ContextOrderPersistence,
  ContextSetsPersistence,
  ScopePinsPersistence,
} from '../../packages/server/src/services/metaDb/types'

const packageId = 'AbCdefGhij_1'
const projectLocator = {
  source: 'owned',
  kind: 'role',
  packageId,
  location: { scope: 'project', spaceId: 'space-main', projectId: 'project-a' },
} as const
const fromLocator = serializeAbilityLocator(projectLocator)
const toLocator = serializeAbilityLocator({
  source: 'owned',
  kind: 'role',
  packageId,
  location: { scope: 'space', spaceId: 'space-main' },
})
const move = {
  fromLocator,
  toLocator,
  registryNoteId: 'RegistryNote1',
  manifestNoteId: 'ManifestNote1',
  trail: 'record' as const,
}
const fromTarget = `project:project-a:${packageId}`
const toTarget = `space:space-main:${packageId}`

export type AbilityPlacementCostProbe = {
  abilityPlacement: AbilityPlacementPersistence
  contextSets: ContextSetsPersistence
  scopePins: ScopePinsPersistence
  contextOrder: ContextOrderPersistence
  sessions: AgentSessionsPersistence
  seedUnrelatedTrail(count: number): Promise<void>
  seedSourceRows(count: number): Promise<void>
  explainExactLookup(locator: string): Promise<string>
  resetStatementAudit(): void
  statementAudit(): string[]
  resetPointerAudit(): Promise<void>
  pointerDmlCount(): Promise<number>
  teardown(): Promise<void>
}

export const describeAbilityPlacementCostContract = (
  name: string,
  factory: () => Promise<AbilityPlacementCostProbe>,
  indexPattern: RegExp,
): void => {
  describe(`Ability placement cost contract — ${name}`, () => {
    it('keeps one-hop lookup on the primary-key index with 0 and 1000 unrelated rows', async () => {
      const probe = await factory()

      try {
        const empty = await probe.explainExactLookup(fromLocator)
        await probe.seedUnrelatedTrail(1_000)
        const populated = await probe.explainExactLookup(fromLocator)

        expect(empty).toMatch(indexPattern)
        expect(populated).toMatch(indexPattern)
        expect(`${empty}\n${populated}`).not.toMatch(/Seq Scan|SCAN ability_placement_trail/i)
      } finally {
        await probe.teardown()
      }
    })

    it('touches zero pointer rows on exact replay', async () => {
      const probe = await factory()

      try {
        await probe.seedSourceRows(1)
        await expect(probe.abilityPlacement.moveOwnedRolePlacement(move)).resolves.toBe('applied')
        await probe.resetPointerAudit()
        await expect(probe.abilityPlacement.moveOwnedRolePlacement(move)).resolves.toBe('replayed')
        await expect(probe.pointerDmlCount()).resolves.toBe(0)
      } finally {
        await probe.teardown()
      }
    })

    it('keeps non-Role attach/detach/unpin on three direct statements with no trail work', async () => {
      const probe = await factory()

      try {
        probe.resetStatementAudit()
        await probe.contextSets.attach({
          setId: 'set-cost',
          targetKind: 'project',
          targetId: 'project-a',
          targetSpace: 'space-main',
          createdAt: '2026-09-02T00:00:00.000Z',
        })
        await probe.contextSets.detach('set-cost', 'project', 'project-a', 'space-main')
        await probe.scopePins.removePin('project', 'project-a', 'space-main', 'PinnedNote01')
        const statements = probe.statementAudit()

        expect(statements).toHaveLength(3)
        expect(statements.join('\n')).not.toMatch(/BEGIN|COMMIT|ability_placement_trail/i)
      } finally {
        await probe.teardown()
      }
    })

    it('charges exactly one post-lock trail lookup to each stale Role mutation', async () => {
      const probe = await factory()

      try {
        await probe.abilityPlacement.moveOwnedRolePlacement(move)
        probe.resetStatementAudit()
        const roleTarget = {
          targetKind: 'role' as const,
          targetId: fromTarget,
          targetSpace: 'space-main',
        }

        await probe.contextSets.attach({
          setId: 'set-cost',
          ...roleTarget,
          createdAt: '2026-09-02T00:00:00.000Z',
        })
        await probe.contextSets.detach('set-cost', 'role', fromTarget, 'space-main')
        await probe.scopePins.addPin({
          ...roleTarget,
          noteSpace: 'space-main',
          noteId: 'PinnedNote01',
          createdAt: '2026-09-02T00:00:00.000Z',
        })
        await probe.scopePins.removePin('role', fromTarget, 'space-main', 'PinnedNote01')
        await probe.contextOrder.setOrder('role', fromTarget, 'space-main', [
          { entryKind: 'set', entryRef: 'set-cost' },
        ])
        const selection = {
          name: 'review',
          locator: projectLocator,
          contextProjectId: 'project-a',
        }
        await probe.sessions.setRole('user:cost', 'session-cost', selection)
        await probe.sessions.setRole('user:cost', 'session-cost', selection)
        const statements = probe.statementAudit()
        const trailLookups = statements.filter(
          (statement) =>
            /FROM\s+ability_placement_trail/i.test(statement) &&
            /WHERE\s+from_locator/i.test(statement),
        )

        expect(trailLookups).toHaveLength(7)
        expect(trailLookups.every((statement) => !/LIKE|JOIN/i.test(statement))).toBe(true)
      } finally {
        await probe.teardown()
      }
    })

    it('adds no trail work to current role pointer reads', async () => {
      const probe = await factory()

      try {
        probe.resetStatementAudit()
        await probe.contextSets.setsForTarget('role', toTarget)
        await probe.scopePins.pinsForTarget('role', toTarget)
        await probe.contextOrder.orderForTarget('role', toTarget)
        const statements = probe.statementAudit()

        expect(statements).toHaveLength(3)
        expect(statements.join('\n')).not.toMatch(/ability_placement_trail/i)
      } finally {
        await probe.teardown()
      }
    })

    it('keeps first apply statement-set constant across 0 and 1000 source rows', async () => {
      const traces: string[][] = []

      for (const count of [0, 1_000]) {
        const probe = await factory()

        try {
          await probe.seedSourceRows(count)
          await probe.resetPointerAudit()
          probe.resetStatementAudit()
          await expect(probe.abilityPlacement.moveOwnedRolePlacement(move)).resolves.toBe('applied')
          traces.push(
            probe.statementAudit().map((statement) => statement.replace(/\s+/g, ' ').trim()),
          )
          await expect(probe.pointerDmlCount()).resolves.toBe(count)
        } finally {
          await probe.teardown()
        }
      }

      expect(traces[1]).toEqual(traces[0])
    })
  })
}
