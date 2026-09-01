import { describe, expect, it } from 'vitest'
import { ActivityGroupsQuerySchema } from '@notarium/contract'
import { CachedStore, REVISION_ENTRY_ROLE, REVISION_KIND } from '@notarium/core'
import { InMemoryStore } from '@notarium/engine-memory'
import { InMemoryRevisionPersistence } from '../../packages/core/src/revisionJournal/inMemoryRevisionPersistence'
import {
  activityCursorScope,
  decodeGroupCursor,
  encodeGroupCursor,
} from '../../packages/server/src/apps/server/routes/activity/helpers/cursors'
import {
  type ActivityGroupProductionSources,
  activityGroupProductionSyntaxFailures,
  auditActivityGroupSections,
  loadActivityGroupProductionSources,
  mutateActivityGroupProductionSource,
} from '../../scripts/activityGroupsSourceAudit'

const injectHistory = (
  source: ActivityGroupProductionSources,
  insertion: string,
): ActivityGroupProductionSources => {
  const history = source['history-surface']
  const at = history.lastIndexOf('}')

  return {
    ...source,
    'history-surface': `${history.slice(0, at)}\n${insertion}\n${history.slice(at)}`,
  }
}

describe('Activity groups faulty strategies', () => {
  it('rejects raw-before-group by retaining a peer displaced from the raw page', async () => {
    const persistence = new InMemoryRevisionPersistence()
    const append = (noteId: string, index: number) =>
      persistence.append(
        {
          noteId,
          space: 'space-a',
          baseRevisionId: null,
          theirRevisionId: null,
          sourceRevisionId: null,
          kind: REVISION_KIND.write,
          entryRole: index === 0 ? REVISION_ENTRY_ROLE.origin : REVISION_ENTRY_ROLE.change,
          principal: 'user:viewer',
          contentHash: null,
          title: noteId,
          class: 'user-doc',
          slug: null,
          tags: [],
          createdAt: new Date(Date.UTC(2026, 7, 30, 0, 0, index)).toISOString(),
          charsAdded: 1,
          charsRemoved: 0,
        },
        null,
      )

    await append('peer', 0)
    for (let index = 1; index <= 10; index++) {
      await append('hot', index)
    }
    const store = new CachedStore({
      inner: new InMemoryStore({
        space: 'space-a',
        notes: [
          { id: 'peer', title: 'Peer', filePath: 'peers/peer.md' },
          { id: 'hot', title: 'Hot', filePath: 'hot/hot.md' },
        ],
      }),
      revisionPersistence: persistence,
      space: 'space-a',
      pollIntervalMs: 0,
    })
    await store.start()

    try {
      const rawPage = await persistence.activityEvents('space-a', { offset: 0, limit: 2 })
      const grouped = await store.activityGroups({ by: 'note', limit: 100 })

      expect(new Set(rawPage.items.map(({ noteId }) => noteId))).toEqual(new Set(['hot']))
      expect(
        new Set(grouped.items.flatMap((item) => ('noteId' in item ? [item.noteId] : []))),
      ).toEqual(new Set(['hot', 'peer']))
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('rejects an eager raw Activity array', () => {
    const source = loadActivityGroupProductionSources()
    const mutated = mutateActivityGroupProductionSource(source, 'eager-raw-array')

    expect(auditActivityGroupSections(source)).toMatchObject({
      rawRevisionMaterializations: 0,
      missingProductionLayers: [],
    })
    expect(activityGroupProductionSyntaxFailures(source)).toEqual([])
    expect(activityGroupProductionSyntaxFailures(mutated)).toEqual([])
    expect(mutated['postgres-driver']).toContain('rows.map((row) => revisionOfRow(row))')
    expect(auditActivityGroupSections(mutated).rawRevisionMaterializations).toBeGreaterThan(0)
  })

  it('rejects query-per-group', () => {
    const source = loadActivityGroupProductionSources()
    const mutated = mutateActivityGroupProductionSource(source, 'query-per-group')

    expect(auditActivityGroupSections(source).queryPerGroup).toBe(0)
    expect(activityGroupProductionSyntaxFailures(mutated)).toEqual([])
    expect(mutated['history-surface']).toContain('forbiddenIndex < forbiddenGroups.length')
    expect(auditActivityGroupSections(mutated).queryPerGroup).toBeGreaterThan(0)
  })

  it('rejects aliased query fanout in while-loop control flow', () => {
    const source = loadActivityGroupProductionSources()
    const mutated = injectHistory(
      source,
      `const forbiddenGroups: unknown[] = []
       const loadForbiddenGroup = this.host.journal.activityGroupsByNote
       let forbiddenIndex = 0
       while (forbiddenIndex < forbiddenGroups.length) {
         await loadForbiddenGroup({} as never)
         forbiddenIndex++
       }`,
    )

    expect(activityGroupProductionSyntaxFailures(mutated)).toEqual([])
    expect(auditActivityGroupSections(mutated).queryPerGroup).toBeGreaterThan(0)
  })

  it('rejects duplicate overview scans', () => {
    const source = loadActivityGroupProductionSources()
    const mutated = mutateActivityGroupProductionSource(source, 'duplicate-scan')

    expect(auditActivityGroupSections(source).duplicateOverviewScans).toBe(0)
    expect(activityGroupProductionSyntaxFailures(mutated)).toEqual([])
    expect(mutated['postgres-driver']).toContain('WITH alternate_actor_states AS')
    expect(auditActivityGroupSections(mutated).duplicateOverviewScans).toBeGreaterThan(0)
  })

  it('keeps a bigint cursor exact', () => {
    const scope = activityCursorScope({ by: 'note' })
    const cursor = encodeGroupCursor(
      { sourceOrdinal: '9007199254740993', key: 'note-a' },
      '9007199254740994',
      'activity-v1',
      'location-v1',
      scope,
    )

    expect(
      decodeGroupCursor(cursor, {
        through: '9007199254740994',
        activityVersion: 'activity-v1',
        locationThrough: 'location-v1',
        scope,
      }),
    ).toEqual({ sourceOrdinal: '9007199254740993', key: 'note-a' })
  })

  it('rejects an unbounded grouped page', () => {
    expect(ActivityGroupsQuerySchema.safeParse({ by: 'note', limit: 101 }).success).toBe(false)
  })
})
