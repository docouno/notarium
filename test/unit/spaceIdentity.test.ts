// provisionSpaceIdentity (#100 phase 4 + #126): resolve-or-mint a space's identity.
// An existing registry row keeps its id; a mint adopts the root marker's `space`
// facet id when a re-clone left one (cross-host continuity), unless that id is
// already held by a different space here (collision → mint fresh).

import { describe, expect, it } from 'vitest'

import type { SpaceRecord } from '../../packages/server/src/services/metaDb'
import { provisionSpaceIdentity } from '../../packages/server/src/services/projects'
import type { SpaceIdentityDeps } from '../../packages/server/src/services/projects'

const fakeSpaces = (seed: SpaceRecord[] = []) => {
  const rows = new Map<string, SpaceRecord>(seed.map((r) => [r.id, { ...r }]))
  return {
    rows,
    persistence: {
      list: async () => [...rows.values()],
      getById: async (id: string) => rows.get(id) ?? null,
      getBySlug: async (slug: string) => [...rows.values()].find((r) => r.slug === slug) ?? null,
      upsert: async (rec: SpaceRecord) => {
        rows.set(rec.id, { ...rec })
      },
    },
  }
}

const deps = (spaces: ReturnType<typeof fakeSpaces>['persistence']): SpaceIdentityDeps =>
  ({ spaces, now: () => new Date('2026-06-26T00:00:00.000Z') }) as unknown as SpaceIdentityDeps

const ID_RE = /^[A-Za-z0-9_-]{12}$/

describe('provisionSpaceIdentity (#100 phase 4 / #126)', () => {
  it('mints a fresh id when no row and no marker facet', async () => {
    const { persistence } = fakeSpaces()
    const rec = await provisionSpaceIdentity(deps(persistence), {
      slug: 'work',
      displayName: 'Work',
    })
    expect(rec.id).toMatch(ID_RE)
    expect(rec.slug).toBe('work')
    expect(rec.aliases).toEqual([])
  })

  it('keeps the existing row id, refreshing only displayName', async () => {
    const { persistence } = fakeSpaces([
      {
        id: 'keepThisId01',
        slug: 'work',
        displayName: 'Old',
        notesDir: 'work',
        aliases: [],
        createdAt: 'x',
        archivedAt: null,
        archivedBy: null,
      },
    ])
    const rec = await provisionSpaceIdentity(deps(persistence), {
      slug: 'work',
      displayName: 'New',
    })
    expect(rec.id).toBe('keepThisId01')
    expect(rec.displayName).toBe('New')
  })

  it('ADOPTS the marker facet id on a fresh mint (#126 cross-host continuity)', async () => {
    const { persistence } = fakeSpaces()
    const rec = await provisionSpaceIdentity(deps(persistence), {
      slug: 'work',
      displayName: 'Work',
      markerFacet: { id: 'origSpaceA01', slug: 'work', aliases: ['oldwork'] },
    })
    expect(rec.id).toBe('origSpaceA01')
    expect(rec.aliases).toEqual(['oldwork'])
  })

  it('folds a divergent marker slug into the alias history (config slug stays current)', async () => {
    const { persistence } = fakeSpaces()
    const rec = await provisionSpaceIdentity(deps(persistence), {
      slug: 'main', // config-authoritative
      displayName: 'Home',
      markerFacet: { id: 'origSpaceB02', slug: 'home', aliases: [] },
    })
    expect(rec.id).toBe('origSpaceB02')
    expect(rec.slug).toBe('main')
    expect(rec.aliases).toContain('home') // the marker's slug keeps resolving
  })

  it('mints FRESH when the marker id is already held by a different space (#126 collision)', async () => {
    const { persistence } = fakeSpaces([
      {
        id: 'takenId00001',
        slug: 'other',
        displayName: 'Other',
        notesDir: 'other',
        aliases: [],
        createdAt: 'x',
        archivedAt: null,
        archivedBy: null,
      },
    ])
    const rec = await provisionSpaceIdentity(deps(persistence), {
      slug: 'work',
      displayName: 'Work',
      markerFacet: { id: 'takenId00001', slug: 'work' },
    })
    expect(rec.id).toMatch(ID_RE)
    expect(rec.id).not.toBe('takenId00001') // didn't steal the held id
  })
})
