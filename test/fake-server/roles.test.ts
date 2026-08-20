import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { encodeAbilityLocator } from '@notarium/core'
import { buildCaseWorld, caseToFixture } from '../cases'
import { createApp, type Fixture } from './app.js'

type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } }

const contentText = (rpc: Rpc): string =>
  ((rpc.result?.content as Array<{ text?: string }> | undefined) ?? [])
    .map((entry) => entry.text ?? '')
    .join('\n')

describe('role catalog → Add → effective → active walking skeleton', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createApp(
      caseToFixture(buildCaseWorld('agent-roles', { now: '2099-08-05T12:00:00.000Z' })),
      // Authentication semantics have their own production-stack suite. Keep this
      // role journey focused on authorization/scope behavior instead of paying
      // several sequential scrypt verifications in the lean CI budget.
      { passwordVerifier: () => Promise.resolve(true) },
    )
  })

  afterEach(async () => {
    if (app) {
      await app.close()
    }
  })

  const login = async (username: string, password: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password },
    })
    expect(response.statusCode).toBe(200)
    return (response.headers['set-cookie'] as string).split(';')[0]
  }

  it('exposes catalog-only, owned-idle, and selected-session states without conflating them', async () => {
    const catalogUser = await login('fresh', 'fresh')
    const bob = await login('bob', 'bob')
    const maya = await login('maya', 'maya')

    const catalogOnly = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles',
      headers: { cookie: catalogUser },
    })
    expect(catalogOnly.statusCode).toBe(200)
    expect(catalogOnly.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          name: 'grooming',
          source: 'catalog',
          locator: expect.objectContaining({ source: 'catalog', kind: 'role' }),
        }),
        expect.objectContaining({
          name: 'research',
          source: 'system',
          enabled: true,
          locator: expect.objectContaining({ source: 'system', kind: 'role' }),
        }),
      ]),
      filteredTotal: 2,
      activeRole: null,
    })
    const catalogRoleLocator = catalogOnly
      .json()
      .items.find(
        (item: { name: string; source: string }) =>
          item.name === 'grooming' && item.source === 'catalog',
      ).locator
    const catalogDetail = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(catalogRoleLocator)}`,
      headers: { cookie: catalogUser },
    })
    expect(catalogDetail.statusCode).toBe(200)
    expect(catalogDetail.json()).toMatchObject({
      ability: { name: 'grooming', source: 'catalog' },
      truncated: false,
    })
    expect(catalogDetail.json().ability.instructions).toContain('Establish the underlying pain')

    const idle = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles',
      headers: { cookie: bob },
    })
    expect(idle.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ name: 'grooming', source: 'catalog' }),
        expect.objectContaining({
          name: 'grooming',
          source: 'owned',
          origin: 'catalog',
          noteId: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/),
          locator: expect.objectContaining({
            source: 'owned',
            kind: 'role',
            location: expect.objectContaining({ scope: 'personal' }),
          }),
        }),
      ]),
      activeRole: null,
    })
    const idleOwned = idle.json().items.find((item: { source: string }) => item.source === 'owned')
    expect(idleOwned.locator.location.scope).toBe('personal')
    const skills = await app.inject({
      method: 'GET',
      url: '/api/me/agent-skills',
      headers: { cookie: bob },
    })
    expect(skills.statusCode, skills.body).toBe(200)
    expect(skills.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ name: 'grooming-evidence', source: 'catalog' }),
        expect.objectContaining({
          name: 'grooming-evidence',
          source: 'owned',
          origin: 'catalog',
          locator: expect.objectContaining({
            source: 'owned',
            kind: 'skill',
            location: expect.objectContaining({ scope: 'personal' }),
          }),
        }),
      ]),
      projects: [],
    })
    const catalogSkill = skills
      .json()
      .items.find((item: { source: string }) => item.source === 'catalog')
    const ownedSkill = skills
      .json()
      .items.find((item: { source: string }) => item.source === 'owned')
    expect(catalogSkill).not.toHaveProperty('noteId')
    expect(ownedSkill.noteId).toMatch(/^[A-Za-z0-9_-]{12}$/)
    const skillDetail = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(catalogSkill.locator)}`,
      headers: { cookie: bob },
    })
    expect(skillDetail.statusCode, skillDetail.body).toBe(200)
    expect(skillDetail.json()).toMatchObject({
      ability: { name: 'grooming-evidence', source: 'catalog' },
      truncated: false,
    })
    expect(skillDetail.json().ability.instructions).toContain('Read the current product contract')
    // The kind is part of the ADDRESS, not a hint: the grooming role's package read
    // as a skill is not a package that exists.
    const roleAsSkill = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encodeAbilityLocator({ ...catalogRoleLocator, kind: 'skill' })}`,
      headers: { cookie: bob },
    })
    expect(roleAsSkill.statusCode).toBe(404)
    const ownedDetail = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(idleOwned.locator)}`,
      headers: { cookie: bob },
    })
    expect(ownedDetail.statusCode, ownedDetail.body).toBe(200)
    expect(ownedDetail.json()).toMatchObject({
      ability: {
        name: 'grooming',
        source: 'owned',
        origin: 'catalog',
        locator: { location: { scope: 'personal' } },
      },
      // The fork carries the template's linked skill, resolved to a package that is
      // actually reachable from this placement.
      health: {
        healthy: true,
        attachments: [{ attachment: { label: 'grooming-evidence' }, health: 'healthy' }],
      },
    })

    // Personal is one owner's Space, and an exact locator naming it does not become
    // readable just because the caller can spell it.
    const someoneElsesPersonal = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(idleOwned.locator)}`,
      headers: { cookie: catalogUser },
    })
    expect(someoneElsesPersonal.statusCode).toBe(404)

    const active = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles',
      headers: { cookie: maya },
    })
    // One role, one item (#309 V18). Maya's `research` exists at four placements, but
    // a project version is an override of the base it shares a name with inside that
    // Space — so the listing shows the two bases and hangs the versions off them.
    // Two identically named cards used to read as a duplicate bug, not as a feature.
    expect(active.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          name: 'research',
          source: 'owned',
          locator: expect.objectContaining({
            location: expect.objectContaining({ scope: 'personal' }),
          }),
          versions: [
            expect.objectContaining({
              locator: expect.objectContaining({
                location: expect.objectContaining({ scope: 'project' }),
              }),
            }),
          ],
        }),
        expect.objectContaining({
          name: 'research',
          source: 'owned',
          locator: expect.objectContaining({
            location: expect.objectContaining({ scope: 'space' }),
          }),
          versions: [
            expect.objectContaining({
              locator: expect.objectContaining({
                location: expect.objectContaining({ scope: 'project' }),
              }),
            }),
          ],
        }),
      ]),
      activeRole: 'research',
    })
    expect(
      active
        .json()
        .items.filter(
          (item: { name: string; source: string; locator: { location?: { scope: string } } }) =>
            item.name === 'research' &&
            item.source === 'owned' &&
            item.locator.location?.scope === 'project',
        ),
    ).toEqual([])
    // A version has no item of its own, so it is reached through the base that owns
    // the name — and it answers on its own exact address.
    const workVersion = active
      .json()
      .items.find(
        (item: { name: string; locator: { location: { scope: string } } }) =>
          item.name === 'research' && item.locator.location.scope === 'personal',
      ).versions[0].locator
    const projectDetail = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(workVersion)}`,
      headers: { cookie: maya },
    })
    expect(projectDetail.statusCode, projectDetail.body).toBe(200)
    expect(projectDetail.json()).toMatchObject({
      ability: { name: 'research', locator: { location: { scope: 'project' } } },
      health: { healthy: true, attachments: [] },
    })
  })

  it('looks up and toggles one exact System ability without exposing Catalog toggles', async () => {
    const cookie = await login('fresh', 'fresh')
    const locator = { source: 'system', kind: 'role', packageId: 'ZME09f9AROG8' } as const
    const encoded = encodeAbilityLocator(locator)
    const detail = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encoded}`,
      headers: { cookie },
    })

    expect(detail.statusCode, detail.body).toBe(200)
    expect(detail.json()).toMatchObject({
      ability: { locator, source: 'system', name: 'research', enabled: true },
      health: { healthy: true },
    })
    const disabled = await app.inject({
      method: 'PUT',
      url: `/api/me/agent-abilities/${encoded}/enabled`,
      headers: { cookie },
      payload: { enabled: false },
    })
    expect(disabled.statusCode, disabled.body).toBe(200)
    expect(disabled.json()).toEqual({ locator, enabled: false })

    const after = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encoded}`,
      headers: { cookie },
    })
    expect(after.json()).toMatchObject({ ability: { enabled: false } })

    const catalog = encodeAbilityLocator({
      source: 'catalog',
      kind: 'role',
      packageId: 'KMVMY5-vK4y1',
    })
    const rejected = await app.inject({
      method: 'PUT',
      url: `/api/me/agent-abilities/${catalog}/enabled`,
      headers: { cookie },
      payload: { enabled: false },
    })
    expect(rejected.statusCode).toBe(400)
  })

  it('refuses every write aimed at a System ability, which owns no document to edit', async () => {
    const cookie = await login('bob', 'bob')
    const inventory = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles',
      headers: { cookie },
    })
    // The locator the product itself hands out, not a hand-written one: read-only has
    // to hold for the address a reader actually holds.
    const locator = inventory
      .json()
      .items.find((item: { source: string }) => item.source === 'system').locator
    const encoded = encodeAbilityLocator(locator)
    const before = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encoded}`,
      headers: { cookie },
    })

    expect(before.statusCode, before.body).toBe(200)
    // The root of the invariant: a System ability is bundled, so it has NO note
    // identity. There is no document for the editor to open and nothing for the note
    // routes to address — which is why the two attempts at the bottom cannot even
    // find a target, let alone change one.
    expect(before.json().ability.noteId).toBeUndefined()

    // Every route that edits an Owned ability, aimed at this System one. Each body is
    // one the schema accepts, so what gets refused is the LOCATOR and not the payload.
    // `PUT .../enabled` is deliberately absent: enabling is the owner's preference
    // about an ability, never a change to the ability, and the test above owns it.
    const writes = [
      {
        what: 'reach',
        method: 'PUT' as const,
        url: `/api/me/agent-abilities/${encoded}/availability`,
        payload: { mode: 'all-projects' },
        status: 400,
        error: 'bad ability locator',
      },
      {
        what: 'project version',
        method: 'POST' as const,
        url: `/api/me/agent-abilities/${encoded}/versions`,
        payload: { projectId: 'project-any' },
        status: 400,
        error: 'bad ability locator',
      },
      {
        what: 'placement',
        method: 'PUT' as const,
        url: `/api/me/agent-abilities/${encoded}/home`,
        payload: { scope: 'space' },
        status: 400,
        error: 'bad ability locator',
      },
      {
        what: 'context set',
        method: 'PUT' as const,
        url: `/api/me/agent-roles/${encoded}/context-sets/any-set`,
        payload: {},
        status: 404,
        error: 'not found',
      },
      {
        what: 'context pin',
        method: 'PUT' as const,
        url: `/api/me/agent-roles/${encoded}/context-pins`,
        payload: { noteId: 'any-note' },
        status: 404,
        error: 'not found',
      },
      {
        what: 'context order',
        method: 'PUT' as const,
        url: `/api/me/agent-roles/${encoded}/context-order`,
        payload: { entries: [] },
        status: 404,
        error: 'not found',
      },
    ]

    for (const write of writes) {
      const response = await app.inject({
        method: write.method,
        url: write.url,
        headers: { cookie },
        payload: write.payload,
      })

      expect([write.what, response.statusCode, response.body]).toEqual([
        write.what,
        write.status,
        JSON.stringify({ error: write.error }),
      ])
    }

    // The document surface, addressed by the only identity a System ability has. The
    // package id is not a note id anywhere, so the route that rewrites an Owned
    // ability's manifest and the one that deletes its package both miss entirely.
    const rewritten = await app.inject({
      method: 'POST',
      url: '/api/note',
      headers: { cookie },
      payload: {
        originalId: locator.packageId,
        versionToken: 'any',
        title: 'Rewritten',
        content: '# Rewritten\n\nrewritten instructions',
      },
    })
    expect(rewritten.statusCode, rewritten.body).toBe(404)
    expect(rewritten.json()).toEqual({ error: 'not found' })

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/note?id=${locator.packageId}`,
      headers: { cookie },
    })
    expect(removed.statusCode, removed.body).toBe(404)
    expect(removed.json()).toEqual({ error: 'not found' })

    const after = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encoded}`,
      headers: { cookie },
    })
    expect(after.statusCode, after.body).toBe(200)
    expect(after.json().ability).toEqual(before.json().ability)
  })

  it('routes an exact Owned locator and never aliases it to a same-name placement', async () => {
    const cookie = await login('maya', 'maya')
    const inventory = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?q=research&source=owned&project=team%2Fother&limit=100',
      headers: { cookie },
    })
    const project = inventory
      .json()
      .projects.find((item: { handle: string }) => item.handle === 'team/other')
    // The version is addressed from its base's `versions`, which is the only place a
    // collapsed listing offers it — and it still carries its own exact locator.
    const locator = inventory
      .json()
      .items.flatMap(
        (item: { versions?: Array<{ projectId: string; locator: unknown }> }) =>
          item.versions ?? [],
      )
      .find((version: { projectId: string }) => version.projectId === project.id).locator
    const encoded = encodeAbilityLocator(locator)

    expect(encoded.length).toBeGreaterThan(100)
    const disabled = await app.inject({
      method: 'PUT',
      url: `/api/me/agent-abilities/${encoded}/enabled`,
      headers: { cookie },
      payload: { enabled: false },
    })
    expect(disabled.statusCode, disabled.body).toBe(200)
    const fallback = await app.inject({
      method: 'GET',
      url: `/api/s/team/projects/${project.id}/agent-context?role=${encoded}`,
      headers: { cookie },
    })
    expect(fallback.statusCode, fallback.body).toBe(200)
    // The PREVIEW door mirrors the agent: a role this reader switched off is not one
    // the agent loads, so it carries no layer here and costs no budget.
    expect(fallback.json().role).toBeUndefined()
    // The subject is ALIASING, not absence — and the door that answers identity must
    // keep naming the exact placement it was handed, never letting the same-name Space
    // role stand in for it.
    const named = await app.inject({
      method: 'GET',
      url: `/api/me/agent-roles/${encoded}/context?project=${encodeURIComponent(project.id)}`,
      headers: { cookie },
    })
    expect(named.statusCode, named.body).toBe(200)
    expect(named.json().role.locator).toEqual(locator)
    expect(named.json().active).toBe(false)
    expect(named.json().inactive).toBe('disabled')
    expect(
      fallback
        .json()
        .roles.some(
          (role: { name: string; scope: string }) =>
            role.name === 'research' && role.scope === 'space',
        ),
    ).toBe(true)

    const restored = await app.inject({
      method: 'PUT',
      url: `/api/me/agent-abilities/${encoded}/enabled`,
      headers: { cookie },
      payload: { enabled: true },
    })
    expect(restored.statusCode, restored.body).toBe(200)
  })

  it('searches, filters, facets, and paginates the complete accessible package collection', async () => {
    const maya = await login('maya', 'maya')
    const first = await app.inject({
      method: 'GET',
      url: '/api/me/agent-skills?q=shared-review&source=owned&limit=1',
      headers: { cookie: maya },
    })

    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({
      items: [
        {
          name: 'shared-review',
          source: 'owned',
          locator: { location: { scope: 'personal' } },
        },
      ],
      filteredTotal: 2,
      nextCursor: expect.any(String),
      facets: {
        source: { catalog: 0, owned: 2 },
        home: { personal: 1, space: 1 },
        availability: { all: 1, selected: 1 },
      },
    })
    const second = await app.inject({
      method: 'GET',
      url: `/api/me/agent-skills?q=shared-review&source=owned&limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: { cookie: maya },
    })
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json()).toMatchObject({
      items: [
        {
          name: 'shared-review',
          source: 'owned',
          locator: { location: { scope: 'space' } },
        },
      ],
      filteredTotal: 2,
      nextCursor: null,
    })
    expect(second.json().items[0].noteId).not.toBe(first.json().items[0].noteId)

    const descriptionSearch = await app.inject({
      method: 'GET',
      url: '/api/me/agent-skills?q=ownership%20handoffs&source=owned',
      headers: { cookie: maya },
    })
    expect(descriptionSearch.statusCode, descriptionSearch.body).toBe(200)
    expect(descriptionSearch.json()).toMatchObject({
      items: [{ name: 'handoff-check', source: 'owned' }],
      filteredTotal: 1,
    })

    const selectedSpaceSkills = await app.inject({
      method: 'GET',
      url: '/api/me/agent-skills?source=owned&home=space&availability=selected&limit=100',
      headers: { cookie: maya },
    })
    expect(selectedSpaceSkills.statusCode, selectedSpaceSkills.body).toBe(200)
    expect(selectedSpaceSkills.json().items.map((item: { name: string }) => item.name)).toEqual([
      'coder',
      'release-check',
      'shared-review',
    ])

    const wrongFilter = await app.inject({
      method: 'GET',
      url: `/api/me/agent-skills?q=release&source=owned&limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: { cookie: maya },
    })
    expect(wrongFilter.statusCode).toBe(400)

    const rootProject = await app.inject({
      method: 'GET',
      url: '/api/me/agent-skills?source=owned&project=team&limit=100',
      headers: { cookie: maya },
    })
    const otherProject = await app.inject({
      method: 'GET',
      url: '/api/me/agent-skills?source=owned&project=team%2Fother&limit=100',
      headers: { cookie: maya },
    })
    expect(rootProject.statusCode, rootProject.body).toBe(200)
    expect(otherProject.statusCode, otherProject.body).toBe(200)
    expect(rootProject.json().items.map((item: { name: string }) => item.name)).not.toContain(
      'release-check',
    )
    expect(otherProject.json().items.map((item: { name: string }) => item.name)).toContain(
      'release-check',
    )
    const selectedProjects = await Promise.all(
      ['alpha', 'beta', 'gamma'].map((project) =>
        app.inject({
          method: 'GET',
          url: `/api/me/agent-skills?source=owned&project=team%2F${project}&limit=100`,
          headers: { cookie: maya },
        }),
      ),
    )
    expect(
      selectedProjects.map((response) =>
        response.json().items.some((item: { name: string }) => item.name === 'coder'),
      ),
    ).toEqual([true, true, false])

    const roleFirst = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?q=research&source=owned&project=team%2Fother&limit=1',
      headers: { cookie: maya },
    })
    expect(roleFirst.statusCode, roleFirst.body).toBe(200)
    const roleSecond = await app.inject({
      method: 'GET',
      url: `/api/me/agent-roles?q=research&source=owned&project=team%2Fother&limit=1&cursor=${encodeURIComponent(roleFirst.json().nextCursor)}`,
      headers: { cookie: maya },
    })
    expect(roleSecond.statusCode, roleSecond.body).toBe(200)
    // Two roles reach team/other, not three placements: Maya's Personal `research`
    // (Personal spans her projects) and the Team base, whose project version lives
    // there. `filteredTotal` counts roles, so it agrees with the cards on screen.
    expect(roleFirst.json()).toMatchObject({ filteredTotal: 2, nextCursor: expect.any(String) })
    expect(roleSecond.json()).toMatchObject({ filteredTotal: 2, nextCursor: null })
    expect(
      new Set(
        [...roleFirst.json().items, ...roleSecond.json().items].map(
          (item: { noteId: string }) => item.noteId,
        ),
      ).size,
    ).toBe(2)
    // Availability is now a Role setting too, so `selected` means a narrowed BASE —
    // not the project fork it used to stand in for.
    const selectedSpaceRole = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&home=space&availability=selected&project=team%2Falpha',
      headers: { cookie: maya },
    })
    expect(selectedSpaceRole.statusCode, selectedSpaceRole.body).toBe(200)
    expect(selectedSpaceRole.json()).toMatchObject({
      items: [
        {
          name: 'launch-review',
          locator: { location: { scope: 'space' } },
          availability: { mode: 'selected-projects' },
        },
      ],
      filteredTotal: 1,
    })
    const unreachedProject = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&q=launch-review&project=team%2Fgamma',
      headers: { cookie: maya },
    })
    expect(unreachedProject.json()).toMatchObject({ items: [], filteredTotal: 0 })

    const robin = await login('robin', 'robin')
    const reader = await app.inject({
      method: 'GET',
      url: '/api/me/agent-skills?source=owned&limit=100',
      headers: { cookie: robin },
    })
    expect(reader.statusCode, reader.body).toBe(200)
    expect(
      reader
        .json()
        .facets.projects.map(({ project }: { project: { handle: string } }) => project.handle),
    ).toEqual(['team', 'team/alpha', 'team/beta', 'team/gamma', 'team/other'])
    expect(
      reader
        .json()
        .items.every(
          (item: { locator: { location?: { scope: string } } }) =>
            item.locator.location?.scope === 'space',
        ),
    ).toBe(true)
  })

  it('scopes exact ability inventory by stable Space id and binds cursors to that Space', async () => {
    const maya = await login('maya', 'maya')
    const spaceResponse = await app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { cookie: maya },
    })
    const team = spaceResponse
      .json()
      .spaces.find((space: { slug: string }) => space.slug === 'team')

    const first = await app.inject({
      method: 'GET',
      url: `/api/me/agent-roles?spaceId=${encodeURIComponent(team.id)}&limit=1`,
      headers: { cookie: maya },
    })

    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().items[0]).toMatchObject({
      locator: { kind: 'role' },
      source: expect.stringMatching(/^(system|catalog|owned)$/),
    })
    expect(first.json().nextCursor).toEqual(expect.any(String))

    const owned = await app.inject({
      method: 'GET',
      url: `/api/me/agent-roles?spaceId=${encodeURIComponent(team.id)}&source=owned&limit=100`,
      headers: { cookie: maya },
    })

    expect(owned.statusCode, owned.body).toBe(200)
    expect(owned.json().items.length).toBeGreaterThan(0)
    expect(
      owned
        .json()
        .items.every(
          (item: { locator: { source: string; location?: { scope: string; spaceId: string } } }) =>
            item.locator.source === 'owned' &&
            (item.locator.location?.scope === 'personal' ||
              item.locator.location?.spaceId === team.id),
        ),
    ).toBe(true)

    const replayedOutsideSpace = await app.inject({
      method: 'GET',
      url: `/api/me/agent-roles?limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: { cookie: maya },
    })
    expect(replayedOutsideSpace.statusCode).toBe(400)
  })

  describe('adding a catalog role and activating it over MCP', () => {
    /** The state every case below starts from: one Personal copy of the catalog
     *  template plus a project copy of the same name. Both are ordinary Add calls,
     *  asserted on their own in the first case. */
    const addGrooming = async (): Promise<string> => {
      const cookie = await login('sergey', 'sergey')

      for (const payload of [
        { name: 'grooming', scope: 'personal' },
        { name: 'grooming', scope: 'project', project: 'main' },
      ]) {
        const added = await app.inject({
          method: 'POST',
          url: '/api/me/agent-roles',
          headers: { cookie },
          payload,
        })
        expect(added.statusCode, added.body).toBe(201)
      }

      return cookie
    }

    /** A read-scoped PAT over the real HTTP surface — the gateway is a transport, not
     *  an injectable route. */
    const mcpCaller = async (cookie: string) => {
      const tokenResponse = await app.inject({
        method: 'POST',
        url: '/api/me/tokens',
        headers: { cookie },
        payload: { name: 'roles', scope: 'read' },
      })
      expect(tokenResponse.statusCode).toBe(201)
      const bearer = tokenResponse.json().token as string
      await app.listen({ port: 0, host: '127.0.0.1' })
      const port = (app.server.address() as AddressInfo).port

      return async (name: string, args: Record<string, unknown>): Promise<Rpc> => {
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        })
        return (await response.json()) as Rpc
      }
    }

    it('copies a catalog template into an exact Personal package without its address', async () => {
      const cookie = await login('sergey', 'sergey')
      const add = await app.inject({
        method: 'POST',
        url: '/api/me/agent-roles',
        headers: { cookie },
        payload: { name: 'grooming', scope: 'personal' },
      })
      expect(add.statusCode).toBe(201)
      expect(add.json()).toMatchObject({
        role: {
          name: 'grooming',
          scope: 'personal',
          origin: 'catalog:KMVMY5-vK4y1',
          noteId: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/),
        },
      })
      expect(add.json().role).not.toHaveProperty('packageId')
      expect(add.json().role).not.toHaveProperty('space')
    })

    it('refuses a second copy at one placement and an unknown template', async () => {
      const cookie = await login('sergey', 'sergey')
      await app.inject({
        method: 'POST',
        url: '/api/me/agent-roles',
        headers: { cookie },
        payload: { name: 'grooming', scope: 'personal' },
      })
      const duplicate = await app.inject({
        method: 'POST',
        url: '/api/me/agent-roles',
        headers: { cookie },
        payload: { name: 'grooming', scope: 'personal' },
      })
      expect(duplicate.statusCode).toBe(409)
      expect(duplicate.json()).toMatchObject({ reason: 'role_exists' })
      const unknown = await app.inject({
        method: 'POST',
        url: '/api/me/agent-roles',
        headers: { cookie },
        payload: { name: 'missing-role', scope: 'personal' },
      })
      expect(unknown.statusCode).toBe(404)
    })

    it('takes the same name again in a project, because a placement is its address', async () => {
      const cookie = await login('sergey', 'sergey')
      await app.inject({
        method: 'POST',
        url: '/api/me/agent-roles',
        headers: { cookie },
        payload: { name: 'grooming', scope: 'personal' },
      })
      // A template this project cannot reach is still not addable there.
      const projectAdd = await app.inject({
        method: 'POST',
        url: '/api/me/agent-roles',
        headers: { cookie },
        payload: { name: 'research', scope: 'project', project: 'main' },
      })
      expect(projectAdd.statusCode).toBe(404)
      const sameNameProjectAdd = await app.inject({
        method: 'POST',
        url: '/api/me/agent-roles',
        headers: { cookie },
        payload: { name: 'grooming', scope: 'project', project: 'main' },
      })
      expect(sameNameProjectAdd.statusCode).toBe(201)
    })

    it('pages the added roles and never lists the catalog', async () => {
      const call = await mcpCaller(await addGrooming())
      const firstRoles = await call('list_roles', { project: 'main', limit: 1 })

      // Three effective roles, not two: the two Added placements plus the shipping
      // System `research`, which is effective without an Add and pages after them.
      expect(firstRoles.result?.structuredContent).toEqual({
        roles: [expect.objectContaining({ name: 'grooming', scope: 'project' })],
        total: 3,
        nextCursor: '1',
      })
      expect(
        (firstRoles.result?.structuredContent as { roles: Array<{ scope: string }> }).roles.some(
          ({ scope }) => scope === 'catalog',
        ),
      ).toBe(false)

      const nextRoles = await call('list_roles', { project: 'main', limit: 1, cursor: '1' })
      expect(nextRoles.result?.structuredContent).toEqual({
        roles: [expect.objectContaining({ name: 'release-reviewer', scope: 'personal' })],
        total: 3,
        nextCursor: '2',
      })
      // Paging still ENDS — one page later. The System role is the tail of the same
      // list and names its SOURCE where an Owned role names its placement.
      const lastRoles = await call('list_roles', { project: 'main', limit: 1, cursor: '2' })
      expect(lastRoles.result?.structuredContent).toEqual({
        roles: [expect.objectContaining({ name: 'research', source: 'system' })],
        total: 3,
      })
    })

    it('refuses to bootstrap with an unavailable role and opens no session for it', async () => {
      const call = await mcpCaller(await addGrooming())
      // A role that exists in the world but not in THIS caller's scope: `launch-review`
      // is a Space role in `team`, which sergey is no member of. `research` no longer
      // serves as the unavailable name — it ships as System and answers everywhere.
      const unavailableBootstrap = await call('start_session', {
        role: 'launch-review',
        session: { name: 'must-not-be-created' },
      })

      expect(unavailableBootstrap.result?.isError).toBe(true)
      expect(JSON.stringify(unavailableBootstrap.result?.content)).toContain(
        'available roles: grooming',
      )
      const opened = await call('start_session', { role: 'grooming' })
      const recent = (
        opened.result?.structuredContent as { recentSessions?: Array<{ name: string }> }
      ).recentSessions
      expect(recent?.map((entry) => entry.name) ?? []).not.toContain('must-not-be-created')
    })

    it('activates an added role with its linked skill and repeats idempotently', async () => {
      const call = await mcpCaller(await addGrooming())
      const opened = await call('start_session', { role: 'grooming' })

      expect(opened.result?.isError).not.toBe(true)
      // What this asserts is that both ADDED placements are offered under their own
      // scope. The shipping System role rides the same list and is not the subject.
      expect(opened.result?.structuredContent).toMatchObject({
        roles: expect.arrayContaining([
          expect.objectContaining({ name: 'grooming', source: 'owned', scope: 'personal' }),
          expect.objectContaining({
            name: 'release-reviewer',
            source: 'owned',
            scope: 'personal',
          }),
        ]),
        activeRole: {
          status: 'activated',
          role: { name: 'grooming' },
          skills: [{ name: 'grooming-evidence' }],
        },
      })
      expect(
        (opened.result?.structuredContent as { activeRole: { role: object } }).activeRole.role,
      ).not.toHaveProperty('packageId')
      const session = (opened.result?.structuredContent as { session: { id: string } }).session.id
      const repeated = await call('use_role', { role: 'grooming', session })
      expect(repeated.result?.structuredContent).toMatchObject({
        status: 'already_active',
        role: { name: 'grooming' },
      })
      expect(repeated.result?.structuredContent).toMatchObject({
        instructions: expect.stringContaining('Establish the underlying pain'),
        skills: [{ name: 'grooming-evidence' }],
      })
      expect(contentText(repeated)).toContain('# Active role: grooming')
      expect(contentText(repeated)).toContain('Establish the underlying pain')
      expect(contentText(repeated)).toContain('## Linked skill: grooming-evidence')
    })

    it('prefers the project fork of the same name over the Personal one', async () => {
      const call = await mcpCaller(await addGrooming())
      const opened = await call('start_session', { role: 'grooming' })
      const session = (opened.result?.structuredContent as { session: { id: string } }).session.id
      const projectOverride = await call('use_role', { role: 'grooming', project: 'main', session })

      expect(projectOverride.result?.structuredContent).toMatchObject({
        status: 'activated',
        role: { name: 'grooming', scope: 'project' },
        instructions: expect.stringContaining('Establish the underlying pain'),
        skills: [{ name: 'grooming-evidence' }],
      })
      expect(contentText(projectOverride)).toContain('# Active role: grooming')
      expect(contentText(projectOverride)).toContain('Establish the underlying pain')
    })

    it('never resumes a role implicitly, and refuses one outside the current scope', async () => {
      const call = await mcpCaller(await addGrooming())
      const opened = await call('start_session', { role: 'grooming' })
      const session = (opened.result?.structuredContent as { session: { id: string } }).session.id
      await call('use_role', { role: 'grooming', project: 'main', session })

      const resumed = await call('start_session', { session: { id: session } })
      expect(resumed.result?.structuredContent).not.toHaveProperty('activeRole')
      expect(contentText(resumed)).not.toContain('# Active role: grooming')
      const explicitlyResumed = await call('start_session', {
        session: { id: session },
        role: 'grooming',
      })
      expect(explicitlyResumed.result?.structuredContent).toMatchObject({
        activeRole: {
          status: 'activated',
          instructions: expect.stringContaining('Establish the underlying pain'),
        },
      })
      expect(contentText(explicitlyResumed)).toContain('# Active role: grooming')
      expect(contentText(explicitlyResumed)).toContain('Establish the underlying pain')
      // Out of scope means out of THIS caller's reach: `launch-review` is a real Space
      // role in `team`, which sergey cannot see. `research` is no longer such a name —
      // it ships as a System role and is effective in every context.
      const unavailable = await call('use_role', { role: 'launch-review', session })
      expect(unavailable.result?.isError).toBe(true)
      expect(JSON.stringify(unavailable.result?.content)).toContain('available roles: grooming')
    })

    it('answers an identical repeated search or recall with a pointer, not a rerun', async () => {
      const call = await mcpCaller(await addGrooming())
      const opened = await call('start_session', { role: 'grooming' })
      const session = (opened.result?.structuredContent as { session: { id: string } }).session.id

      const firstSearch = await call('search', { query: 'nothing here', session })
      expect(firstSearch.result?.isError).not.toBe(true)
      const repeatedSearch = await call('search', { query: 'nothing here', session })
      expect(repeatedSearch.result?.isError).toBe(true)
      expect(repeatedSearch.result?.structuredContent).toEqual({ results: [] })
      expect(JSON.stringify(repeatedSearch.result?.content)).toContain(
        'identical search arguments already returned',
      )
      expect(JSON.stringify(repeatedSearch.result?.content)).toContain('get_note')
      // A fresh bootstrap is the explicit "I am starting over" the guard listens for.
      await call('start_session', { session: { id: session } })
      const refreshedSearch = await call('search', { query: 'nothing here', session })
      expect(refreshedSearch.result?.isError).not.toBe(true)

      const firstRecall = await call('recall', { query: 'nothing here', session })
      expect(firstRecall.result?.isError).not.toBe(true)
      const repeatedRecall = await call('recall', { query: 'nothing here', session })
      expect(repeatedRecall.result?.isError).toBe(true)
      expect(repeatedRecall.result?.structuredContent).toEqual({ context: '', sources: [] })
      expect(JSON.stringify(repeatedRecall.result?.content)).toContain('get_note')
    })
  })

  it('keeps Personal roles outside a PAT narrowed to another space in REST and MCP', async () => {
    const cookie = await login('maya', 'maya')
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/me/tokens',
      headers: { cookie },
      payload: { name: 'team-only-roles', scope: 'read', spaces: ['team'] },
    })
    expect(tokenResponse.statusCode, tokenResponse.body).toBe(201)
    const bearer = tokenResponse.json().token as string

    const personal = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&q=research&limit=100',
      headers: { cookie },
    })
    const personalLocator = personal
      .json()
      .items.find(
        (item: { locator: { location: { scope: string } } }) =>
          item.locator.location.scope === 'personal',
      ).locator
    const personalRole = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(personalLocator)}`,
      headers: { authorization: `Bearer ${bearer}` },
    })
    expect(personalRole.statusCode).toBe(404)

    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_roles', arguments: {} },
      }),
    })
    const rpc = (await response.json()) as Rpc
    // The narrowing is about OWNED placements: a PAT scoped to `team` reaches no
    // Personal library. A System role ships with the host and is effective under any
    // principal, so its presence is not the leak this guards — an owned entry is.
    expect(
      (rpc.result?.structuredContent as { roles: Array<{ source: string }> }).roles.filter(
        (role) => role.source === 'owned',
      ),
    ).toEqual([])
  })

  it('adds a catalog skill as an exact owned fork and opens it immediately', async () => {
    const cookie = await login('sergey', 'sergey')
    const added = await app.inject({
      method: 'POST',
      url: '/api/me/agent-skills/catalog',
      headers: { cookie },
      payload: { name: 'grooming-evidence', scope: 'personal' },
    })

    expect(added.statusCode, added.body).toBe(201)
    expect(added.json().skill).toMatchObject({
      name: 'grooming-evidence',
      scope: 'personal',
      origin: 'catalog:LM1Iv2rAWGEQ',
      noteId: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/),
    })

    const opened = await app.inject({
      method: 'GET',
      url: `/api/note?id=${encodeURIComponent(added.json().skill.noteId)}`,
      headers: { cookie },
    })
    expect(opened.statusCode, opened.body).toBe(200)
    expect(opened.json()).toMatchObject({
      agentKind: 'skill',
      documentTitle: 'Evidence for grooming',
    })

    const detail = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(added.json().locator)}`,
      headers: { cookie },
    })
    expect(opened.json().content).toContain('Read the current product contract')
    expect(detail.statusCode, detail.body).toBe(200)
    expect(detail.json().ability.instructions).toContain('Read the current product contract')
    // The authored H1 is the package's TITLE and lives in the body, so it is not part
    // of the instructions an agent is handed.
    expect(detail.json().ability.instructions).not.toContain('# Evidence for grooming')

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/me/agent-skills/catalog',
      headers: { cookie },
      payload: { name: 'grooming-evidence', scope: 'personal' },
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json()).toMatchObject({ reason: 'skill_exists' })
  })

  it('projects renamed, custom-linked, duplicate, and deleted skill seed states', async () => {
    const maya = await login('maya', 'maya')
    const inventory = await app.inject({
      method: 'GET',
      url: '/api/me/agent-skills',
      headers: { cookie: maya },
    })

    expect(inventory.statusCode, inventory.body).toBe(200)
    const owned = inventory
      .json()
      .items.filter((item: { source: string }) => item.source === 'owned')
    expect(owned).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'source-audit',
          locator: expect.objectContaining({
            location: expect.objectContaining({ scope: 'space' }),
          }),
        }),
        expect.objectContaining({
          name: 'handoff-check',
          locator: expect.objectContaining({
            location: expect.objectContaining({ scope: 'personal' }),
          }),
        }),
        expect.objectContaining({
          name: 'grooming-evidence',
          origin: 'catalog',
          locator: expect.objectContaining({
            location: expect.objectContaining({ scope: 'space' }),
          }),
        }),
        expect.objectContaining({
          name: 'coder',
          locator: expect.objectContaining({
            location: expect.objectContaining({ scope: 'space' }),
          }),
        }),
      ]),
    )
    expect(owned.filter((skill: { name: string }) => skill.name === 'shared-review')).toHaveLength(
      2,
    )
    expect(owned.some((skill: { name: string }) => skill.name === 'retired-check')).toBe(false)
    const teamRoles = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&q=research&limit=100',
      headers: { cookie: maya },
    })
    const teamResearch = teamRoles
      .json()
      .items.find(
        (item: { locator: { location: { scope: string } } }) =>
          item.locator.location.scope === 'space',
      ).locator
    const renamedRole = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(teamResearch)}`,
      headers: { cookie: maya },
    })

    expect(renamedRole.statusCode, renamedRole.body).toBe(200)
    // The attachment is an exact package id, so renaming the skill it points at moves
    // the LABEL and keeps the link.
    expect(renamedRole.json().health.attachments).toEqual([
      expect.objectContaining({
        attachment: expect.objectContaining({ label: 'source-audit' }),
        health: 'healthy',
      }),
    ])

    // The deleted package is gone from its placement, not merely hidden from lists.
    const deleted = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&q=retired-captain&limit=100',
      headers: { cookie: maya },
    })
    expect(deleted.json()).toMatchObject({ items: [], filteredTotal: 0 })
  })

  it('seeds a long custom role and keeps the deleted owned role in Trash', async () => {
    const maya = await login('maya', 'maya')
    const inventory = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&q=release-captain',
      headers: { cookie: maya },
    })

    expect(inventory.statusCode, inventory.body).toBe(200)
    expect(inventory.json()).toMatchObject({
      items: [
        {
          name: 'release-captain',
          source: 'owned',
          locator: { location: { scope: 'personal' } },
          noteId: expect.any(String),
        },
      ],
      filteredTotal: 1,
    })
    const opened = await app.inject({
      method: 'GET',
      url: `/api/note?id=${inventory.json().items[0].noteId}`,
      headers: { cookie: maya },
    })
    expect(opened.statusCode, opened.body).toBe(200)
    expect(opened.json().content).toContain('Long-form rehearsal paragraph.')
    expect(opened.json().content.length).toBeGreaterThan(4_000)

    // Searched and read by the HUMAN title the package authored, not by the manifest
    // key: Trash is an ordinary reader's surface, and `retired-captain` is an address.
    const trash = await app.inject({
      method: 'GET',
      url: '/api/s/maya-home/trash?q=Retired%20captain',
      headers: { cookie: maya },
    })
    expect(trash.statusCode, trash.body).toBe(200)
    expect(trash.json()).toMatchObject({
      items: [expect.objectContaining({ title: 'Retired captain', class: 'skill' })],
      total: 1,
    })
  })

  it('creates one Space-owned skill with selected project handles and rejects project ownership', async () => {
    const maya = await login('maya', 'maya')
    const created = await app.inject({
      method: 'POST',
      url: '/api/me/agent-skills',
      headers: { cookie: maya },
      payload: {
        name: 'project-pair-proof',
        description: 'Available only where explicitly selected.',
        instructions: '# Project pair proof\n\nCheck the exact selected projects.',
        scope: 'space',
        space: 'team',
        availability: { mode: 'selected-projects', projects: ['team/other'] },
      },
    })

    expect(created.statusCode, created.body).toBe(201)
    expect(created.json().skill).toMatchObject({
      name: 'project-pair-proof',
      scope: 'space',
      space: 'team',
      availability: { mode: 'selected-projects', projects: ['team/other'] },
    })
    const inventory = await app.inject({
      method: 'GET',
      url: '/api/me/agent-skills',
      headers: { cookie: maya },
    })
    expect(
      inventory
        .json()
        .items.filter(
          (skill: { name: string; source: string }) =>
            skill.source === 'owned' && skill.name === 'project-pair-proof',
        ),
    ).toEqual([
      expect.objectContaining({
        locator: expect.objectContaining({
          location: expect.objectContaining({ scope: 'space' }),
        }),
      }),
    ])

    const opened = await app.inject({
      method: 'GET',
      url: `/api/note?id=${encodeURIComponent(created.json().skill.noteId)}`,
      headers: { cookie: maya },
    })
    expect(opened.statusCode, opened.body).toBe(200)
    expect(opened.json()).toMatchObject({
      title: 'Project pair proof',
      documentTitle: 'Project pair proof',
      content: 'Check the exact selected projects.\n',
      agentKind: 'skill',
      frontmatter: {
        name: 'project-pair-proof',
        description: 'Available only where explicitly selected.',
      },
    })

    const emptySelection = await app.inject({
      method: 'POST',
      url: '/api/me/agent-skills',
      headers: { cookie: maya },
      payload: {
        name: 'empty-selection',
        description: 'Must not silently become unavailable everywhere.',
        instructions: '# Empty selection\n\nPick at least one project.',
        scope: 'space',
        space: 'team',
        availability: { mode: 'selected-projects', projects: [] },
      },
    })
    expect(emptySelection.statusCode).toBe(400)

    const obsolete = await app.inject({
      method: 'POST',
      url: '/api/me/agent-skills',
      headers: { cookie: maya },
      payload: {
        name: 'obsolete-project-copy',
        description: 'Must not create a project-owned package.',
        instructions: '# Obsolete project copy\n\nThis request shape is obsolete.',
        scope: 'project',
        project: 'team/other',
      },
    })
    expect(obsolete.statusCode).toBe(400)
  })

  it('creates a complete owned role package before returning its note identity', async () => {
    const maya = await login('maya', 'maya')
    const created = await app.inject({
      method: 'POST',
      url: '/api/me/agent-roles/custom',
      headers: { cookie: maya },
      payload: {
        name: 'release-captain',
        description: 'Coordinates a release without skipping evidence.',
        instructions: '# Release captain\n\nVerify owners, evidence, and rollback.',
        scope: 'space',
        space: 'team',
      },
    })

    expect(created.statusCode, created.body).toBe(201)
    expect(created.json()).toMatchObject({
      noteId: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/),
      role: {
        name: 'release-captain',
        description: 'Coordinates a release without skipping evidence.',
        scope: 'space',
        space: 'team',
      },
    })

    const opened = await app.inject({
      method: 'GET',
      url: `/api/note?id=${encodeURIComponent(created.json().noteId)}`,
      headers: { cookie: maya },
    })
    expect(opened.statusCode, opened.body).toBe(200)
    expect(opened.json()).toMatchObject({
      title: 'Release captain',
      documentTitle: 'Release captain',
      content: 'Verify owners, evidence, and rollback.\n',
      agentKind: 'role',
      frontmatter: {
        name: 'release-captain',
        description: 'Coordinates a release without skipping evidence.',
      },
    })

    const detail = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(created.json().locator)}`,
      headers: { cookie: maya },
    })
    expect(detail.statusCode, detail.body).toBe(200)
    expect(detail.json()).toMatchObject({
      ability: {
        name: 'release-captain',
        instructions: 'Verify owners, evidence, and rollback.',
        locator: { location: { scope: 'space' } },
      },
      health: { healthy: true, attachments: [] },
    })
  })

  it('publishes an attached Role, edits it through note CAS, and detaches by exact locator', async () => {
    const maya = await login('maya', 'maya')
    const skills = await app.inject({
      method: 'GET',
      url: '/api/me/agent-skills?source=owned&limit=100',
      headers: { cookie: maya },
    })
    expect(skills.statusCode, skills.body).toBe(200)
    const personalSkill = skills
      .json()
      .items.find(
        (item: { locator: { kind: string; location?: { scope: string } } }) =>
          item.locator.kind === 'skill' && item.locator.location?.scope === 'personal',
      )
    expect(personalSkill).toBeDefined()

    const catalogAttachment = await app.inject({
      method: 'POST',
      url: '/api/me/agent-roles/custom',
      headers: { cookie: maya },
      payload: {
        name: 'catalog-link-rejected',
        description: 'Must not publish discovery identity as an executable attachment.',
        instructions: '# Catalog link rejected\n\nThis package must not be written.',
        scope: 'personal',
        attachments: [
          {
            kind: 'exact',
            locator: { source: 'catalog', kind: 'skill', packageId: 'KMVMY5-vK4y1' },
            label: 'grooming-evidence',
          },
        ],
      },
    })
    expect(catalogAttachment.statusCode).toBe(400)

    const attachment = {
      kind: 'exact' as const,
      locator: personalSkill.locator,
      label: personalSkill.name,
    }
    const created = await app.inject({
      method: 'POST',
      url: '/api/me/agent-roles/custom',
      headers: { cookie: maya },
      payload: {
        name: 'routed-reviewer',
        description: 'Proves routed publication and exact attachment persistence.',
        instructions: '# Routed reviewer\n\nUse the attached skill.',
        scope: 'personal',
        attachments: [attachment],
      },
    })
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json()).toMatchObject({
      locator: {
        source: 'owned',
        kind: 'role',
        location: { scope: 'personal' },
      },
      noteId: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/),
      versionToken: expect.any(String),
    })
    const encoded = encodeAbilityLocator(created.json().locator)
    const before = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encoded}`,
      headers: { cookie: maya },
    })
    expect(before.statusCode, before.body).toBe(200)
    expect(before.json()).toMatchObject({
      ability: { name: 'routed-reviewer' },
      health: {
        healthy: true,
        attachments: [{ attachment, health: 'healthy' }],
      },
    })

    const saved = await app.inject({
      method: 'POST',
      url: '/api/note',
      headers: { cookie: maya },
      payload: {
        content: '# Routed reviewer\n\nUpdated through the common note editor.',
        name: 'routed-reviewer',
        description: 'Edited without a parallel package update endpoint.',
        originalId: created.json().noteId,
        versionToken: created.json().versionToken,
        abilityLocator: created.json().locator,
        attachments: [],
      },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()).toMatchObject({
      id: created.json().noteId,
      versionToken: expect.any(String),
    })
    const after = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encoded}`,
      headers: { cookie: maya },
    })
    expect(after.statusCode, after.body).toBe(200)
    expect(after.json()).toMatchObject({
      ability: {
        description: 'Edited without a parallel package update endpoint.',
        instructions: 'Updated through the common note editor.',
      },
      health: { healthy: true, attachments: [] },
    })

    const stale = await app.inject({
      method: 'POST',
      url: '/api/note',
      headers: { cookie: maya },
      payload: {
        content: '# Routed reviewer\n\nA stale overwrite.',
        originalId: created.json().noteId,
        versionToken: created.json().versionToken,
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ reason: 'version_conflict' })
  })

  it('updates Space Skill availability independently from authored content', async () => {
    const maya = await login('maya', 'maya')
    const inventory = await app.inject({
      method: 'GET',
      url: '/api/me/agent-skills?source=owned&home=space&limit=100',
      headers: { cookie: maya },
    })
    expect(inventory.statusCode, inventory.body).toBe(200)
    const skill = inventory
      .json()
      .items.find(
        (item: { locator: { kind: string; location?: { scope: string } } }) =>
          item.locator.kind === 'skill' && item.locator.location?.scope === 'space',
      )
    const project = inventory
      .json()
      .projects.find((item: { handle: string }) => item.handle.startsWith('team'))
    expect(skill).toBeDefined()
    expect(project).toBeDefined()
    const encoded = encodeAbilityLocator(skill.locator)

    const all = await app.inject({
      method: 'PUT',
      url: `/api/me/agent-abilities/${encoded}/availability`,
      headers: { cookie: maya },
      payload: { mode: 'all-projects' },
    })
    expect(all.statusCode, all.body).toBe(200)
    expect(all.json()).toEqual({ locator: skill.locator, availability: { mode: 'all-projects' } })

    const selected = await app.inject({
      method: 'PUT',
      url: `/api/me/agent-abilities/${encoded}/availability`,
      headers: { cookie: maya },
      payload: { mode: 'selected-projects', projectIds: [project.id] },
    })
    expect(selected.statusCode, selected.body).toBe(200)
    expect(selected.json()).toEqual({
      locator: skill.locator,
      availability: { mode: 'selected-projects', projectIds: [project.id] },
    })

    const detail = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encoded}`,
      headers: { cookie: maya },
    })
    expect(detail.json()).toMatchObject({
      ability: { availability: { mode: 'selected-projects', projectIds: [project.id] } },
    })
  })

  it('does not mint a Personal space when the catalog role does not exist', async () => {
    const cookie = await login('fresh', 'fresh')
    const before = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    expect(before.statusCode).toBe(200)
    expect(before.json().personalSpace).toBeNull()

    const missing = await app.inject({
      method: 'POST',
      url: '/api/me/agent-roles',
      headers: { cookie },
      payload: { name: 'missing-role', scope: 'personal' },
    })
    expect(missing.statusCode).toBe(404)

    const after = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    expect(after.statusCode).toBe(200)
    expect(after.json().personalSpace).toBeNull()
  })
  it('forks a Space base into a project version and shows one role, not two', async () => {
    const cookie = await login('maya', 'maya')
    const inventory = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&q=launch-review&limit=100',
      headers: { cookie },
    })
    const base = inventory.json().items[0]
    const gamma = inventory
      .json()
      .projects.find((project: { handle: string }) => project.handle === 'team/gamma')

    expect(base).toMatchObject({ name: 'launch-review', versions: [] })
    const created = await app.inject({
      method: 'POST',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(base.locator)}/versions`,
      headers: { cookie },
      payload: { projectId: gamma.id },
    })
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json()).toMatchObject({
      locator: {
        source: 'owned',
        kind: 'role',
        location: { scope: 'project', projectId: gamma.id },
      },
    })
    // The version has its OWN package address: sharing the base's would make two
    // notes claim one id.
    expect(created.json().locator.packageId).not.toBe(base.locator.packageId)

    const after = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&q=launch-review&limit=100',
      headers: { cookie },
    })
    expect(after.json()).toMatchObject({
      items: [
        {
          name: 'launch-review',
          locator: { location: { scope: 'space' } },
          versions: [{ projectId: gamma.id }],
        },
      ],
      filteredTotal: 1,
    })
    // The version's body starts as a copy of the base and is separately addressable.
    const version = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(created.json().locator)}`,
      headers: { cookie },
    })
    expect(version.statusCode, version.body).toBe(200)
    expect(version.json().ability.instructions).toContain('Check scope, evidence and rollback')

    // The project facet answers "which roles act here", so a version counts even
    // where the base's own reach does not extend: launch-review reaches alpha and
    // beta, and now has its own body in gamma.
    const inGamma = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&q=launch-review&project=team%2Fgamma',
      headers: { cookie },
    })
    expect(inGamma.json()).toMatchObject({ items: [{ name: 'launch-review' }], filteredTotal: 1 })

    // A second version for the same project is a conflict, not a second role.
    const again = await app.inject({
      method: 'POST',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(base.locator)}/versions`,
      headers: { cookie },
      payload: { projectId: gamma.id },
    })
    expect(again.statusCode, again.body).toBe(409)
  })

  it('promotes a version to the Space base without widening its reach', async () => {
    const cookie = await login('maya', 'maya')
    const inventory = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&q=field-guide&limit=100',
      headers: { cookie },
    })
    const version = inventory.json().items[0]
    const other = inventory
      .json()
      .projects.find((project: { handle: string }) => project.handle === 'team/other')

    expect(version).toMatchObject({
      name: 'field-guide',
      locator: { location: { scope: 'project', projectId: other.id } },
    })
    const promoted = await app.inject({
      method: 'PUT',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(version.locator)}/home`,
      headers: { cookie },
      payload: { scope: 'space' },
    })
    expect(promoted.statusCode, promoted.body).toBe(200)
    expect(promoted.json()).toMatchObject({
      // The package keeps its address: everything durable is keyed by it.
      locator: {
        packageId: version.locator.packageId,
        location: { scope: 'space', spaceId: version.locator.location.spaceId },
      },
      // It served one project and says so, instead of quietly reaching all of them.
      availability: { mode: 'selected-projects', projectIds: [other.id] },
    })
    const detail = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(promoted.json().locator)}`,
      headers: { cookie },
    })
    expect(detail.statusCode, detail.body).toBe(200)
    expect(detail.json().ability.instructions).toContain('Work the project surface')
    const gone = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(version.locator)}`,
      headers: { cookie },
    })
    expect(gone.statusCode).toBe(404)
  })

  describe('a promotion carries everything keyed by the placement it leaves', () => {
    /** The one base-less project version in the world: promoting it is the only move
     *  that lands without a name collision. */
    const projectVersionOf = async (cookie: string) => {
      const inventory = await app.inject({
        method: 'GET',
        url: '/api/me/agent-roles?source=owned&q=field-guide&limit=100',
        headers: { cookie },
      })
      expect(inventory.statusCode, inventory.body).toBe(200)
      const version = inventory.json().items[0]
      const other = inventory
        .json()
        .projects.find((project: { handle: string }) => project.handle === 'team/other')

      expect(version).toMatchObject({
        name: 'field-guide',
        locator: { location: { scope: 'project', projectId: other.id } },
      })
      return { locator: version.locator, projectId: other.id as string }
    }

    const promote = async (cookie: string, locator: unknown) => {
      const promoted = await app.inject({
        method: 'PUT',
        url: `/api/me/agent-abilities/${encodeAbilityLocator(locator as never)}/home`,
        headers: { cookie },
        payload: { scope: 'space' },
      })
      expect(promoted.statusCode, promoted.body).toBe(200)
      return promoted.json().locator
    }

    it('carries the role context targets, in the order the owner gave them', async () => {
      const cookie = await login('maya', 'maya')
      const { locator, projectId } = await projectVersionOf(cookie)
      const address = encodeAbilityLocator(locator)
      const set = await app.inject({
        method: 'POST',
        url: '/api/s/team/context-sets',
        headers: { cookie },
        payload: { name: 'Promotion sources' },
      })
      expect(set.statusCode, set.body).toBe(200)
      const setId = set.json().set.id as string

      for (const request of [
        { method: 'PUT' as const, url: `/api/me/agent-roles/${address}/context-sets/${setId}` },
        {
          method: 'PUT' as const,
          url: `/api/me/agent-roles/${address}/context-pins`,
          payload: { space: 'team', noteId: 'fake-other-reference' },
        },
        {
          method: 'PUT' as const,
          url: `/api/me/agent-roles/${address}/context-order`,
          // Pin first, set second — the reverse of the order the two facets would
          // fall into on their own, so the overlay is visible in the answer.
          payload: {
            entries: [
              { kind: 'pin', ref: 'fake-other-reference' },
              { kind: 'set', ref: setId },
            ],
          },
        },
      ]) {
        const response = await app.inject({ headers: { cookie }, ...request })
        expect(response.statusCode, response.body).toBe(200)
      }

      const moved = await promote(cookie, locator)
      const context = await app.inject({
        method: 'GET',
        url: `/api/s/team/projects/${projectId}/agent-context?role=${encodeAbilityLocator(moved)}`,
        headers: { cookie },
      })
      expect(context.statusCode, context.body).toBe(200)
      // Attached to the project placement, read back at the Space one: pins, sets and
      // the order overlay are keyed by the address the package just left.
      expect(context.json().role).toMatchObject({
        pins: [expect.objectContaining({ noteId: 'fake-other-reference', order: 0 })],
        sets: [expect.objectContaining({ id: setId, order: 1 })],
      })
    })

    it('carries the owner disable, so a promoted role does not switch itself back on', async () => {
      const cookie = await login('maya', 'maya')
      const { locator } = await projectVersionOf(cookie)
      const disabled = await app.inject({
        method: 'PUT',
        url: `/api/me/agent-abilities/${encodeAbilityLocator(locator)}/enabled`,
        headers: { cookie },
        payload: { enabled: false },
      })
      expect(disabled.statusCode, disabled.body).toBe(200)

      const moved = await promote(cookie, locator)
      const detail = await app.inject({
        method: 'GET',
        url: `/api/me/agent-abilities/${encodeAbilityLocator(moved)}`,
        headers: { cookie },
      })
      expect(detail.statusCode, detail.body).toBe(200)
      expect(detail.json().ability).toMatchObject({ enabled: false })
    })

    it('carries a live episode, so an exact resume follows the role instead of dropping it', async () => {
      const cookie = await login('maya', 'maya')
      const tokenResponse = await app.inject({
        method: 'POST',
        url: '/api/me/tokens',
        headers: { cookie },
        payload: { name: 'placement', scope: 'read' },
      })
      expect(tokenResponse.statusCode).toBe(201)
      const bearer = tokenResponse.json().token as string
      await app.listen({ port: 0, host: '127.0.0.1' })
      const port = (app.server.address() as AddressInfo).port

      const call = async (name: string, args: Record<string, unknown>): Promise<Rpc> => {
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        })
        return (await response.json()) as Rpc
      }

      const { locator } = await projectVersionOf(cookie)
      const opened = await call('start_session', { project: 'team/other' })
      const session = (opened.result?.structuredContent as { session: { id: string } }).session.id
      const activated = await call('use_role', {
        role: 'field-guide',
        project: 'team/other',
        session,
      })
      expect(activated.result?.structuredContent).toMatchObject({
        status: 'activated',
        role: { name: 'field-guide', scope: 'project' },
      })

      await promote(cookie, locator)
      // Exact resume is fail-closed, so an episode left on the old locator silently
      // drops back to base mode instead of following the role it selected.
      const resumed = await call('start_session', {
        session: { id: session },
        project: 'team/other',
      })
      expect(resumed.result?.structuredContent).toMatchObject({
        activeRole: { role: { name: 'field-guide', scope: 'space' } },
      })
    })
  })

  it('refuses a promotion the Space already has the name for, and leaves it in place', async () => {
    const cookie = await login('maya', 'maya')
    const inventory = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&q=research&limit=100',
      headers: { cookie },
    })
    const other = inventory
      .json()
      .projects.find((project: { handle: string }) => project.handle === 'team/other')
    const teamBase = inventory
      .json()
      .items.find((item: { versions?: Array<{ projectId: string }> }) =>
        item.versions?.some((entry) => entry.projectId === other.id),
      )
    const version = teamBase.versions.find(
      (entry: { projectId: string }) => entry.projectId === other.id,
    ).locator

    const refused = await app.inject({
      method: 'PUT',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(version)}/home`,
      headers: { cookie },
      payload: { scope: 'space' },
    })
    expect(refused.statusCode, refused.body).toBe(409)
    // Nothing moved: a base and its version legally share a name, so an occupied
    // destination is the ordinary case rather than a corrupt state to recover from.
    const still = await app.inject({
      method: 'GET',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(version)}`,
      headers: { cookie },
    })
    expect(still.statusCode, still.body).toBe(200)
  })

  /** The third reason the identity door can give, and until now the only one with no
   *  arc anywhere: replacing `out-of-reach` with `disabled` left 2027 tests green while
   *  the drift answered 400 on a real user path. Reach is a question about a project,
   *  so it is asked with one. */
  it('names a Space role narrowed away from a project, and says it is out of reach', async () => {
    const cookie = await login('maya', 'maya')
    const inventory = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&q=launch-review&limit=100',
      headers: { cookie },
    })
    const base = inventory.json().items[0]
    const encoded = encodeAbilityLocator(base.locator)
    const projects = inventory.json().projects as Array<{ handle: string; id: string }>
    const alpha = projects.find((project) => project.handle === 'team/alpha')!
    const beta = projects.find((project) => project.handle === 'team/beta')!
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/me/agent-abilities/${encoded}/availability`,
          headers: { cookie },
          payload: { mode: 'selected-projects', projectIds: [alpha.id] },
        })
      ).statusCode,
    ).toBe(200)

    const inReach = await app.inject({
      method: 'GET',
      url: `/api/me/agent-roles/${encoded}/context?project=${encodeURIComponent(alpha.id)}`,
      headers: { cookie },
    })
    const outOfReach = await app.inject({
      method: 'GET',
      url: `/api/me/agent-roles/${encoded}/context?project=${encodeURIComponent(beta.id)}`,
      headers: { cookie },
    })

    expect(inReach.statusCode, inReach.body).toBe(200)
    expect(inReach.json().active).toBe(true)
    expect(inReach.json().inactive).toBeUndefined()
    // Still NAMED where it does not reach — the role is the same role, and its shared
    // context is still this member's to configure. Only the verdict changes.
    expect(outOfReach.statusCode, outOfReach.body).toBe(200)
    expect(outOfReach.json().role.locator).toEqual(base.locator)
    expect(outOfReach.json().active).toBe(false)
    expect(outOfReach.json().inactive).toBe('out-of-reach')
    // …and the OTHER half of the same question: a Space placement asked about from
    // Personal is not in that chain at all. Answering only the narrowing half called
    // such a role live, while the preview door — which filters on scope before it even
    // asks — had already dropped it, so the two doors disagreed and the page had to
    // reconcile them itself.
    const fromPersonal = await app.inject({
      method: 'GET',
      url: `/api/me/agent-roles/${encoded}/context`,
      headers: { cookie },
    })

    expect(fromPersonal.statusCode, fromPersonal.body).toBe(200)
    expect(fromPersonal.json().role.locator).toEqual(base.locator)
    expect(fromPersonal.json().active).toBe(false)
    expect(fromPersonal.json().inactive).toBe('out-of-reach')
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/me/agent-abilities/${encoded}/availability`,
          headers: { cookie },
          payload: { mode: 'all-projects' },
        })
      ).statusCode,
    ).toBe(200)
  })

  it('narrows a Space role reach through the shared availability endpoint', async () => {
    const cookie = await login('maya', 'maya')
    const inventory = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&q=launch-review&limit=100',
      headers: { cookie },
    })
    const base = inventory.json().items[0]
    const alpha = inventory
      .json()
      .projects.find((project: { handle: string }) => project.handle === 'team/alpha')

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/me/agent-abilities/${encodeAbilityLocator(base.locator)}/availability`,
      headers: { cookie },
      payload: { mode: 'selected-projects', projectIds: [alpha.id] },
    })
    expect(updated.statusCode, updated.body).toBe(200)
    const beta = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&q=launch-review&project=team%2Fbeta',
      headers: { cookie },
    })
    expect(beta.json()).toMatchObject({ items: [], filteredTotal: 0 })
  })
})

// The inventory scans a BOUNDED number of locations, so a workspace wide enough to
// exhaust that bound is the only world in which the scoped query means anything: it
// is the difference between reaching the Space you are looking at and not.
const GLOBAL_LOCATION_CAP = 128
const FILLER_SPACES = GLOBAL_LOCATION_CAP + 1
const TARGET_ROLES = 25
const SESSIONS = 31

const scopedWorld = (): Fixture => {
  const spaces = [
    { slug: 'maya-home', displayName: 'Maya personal', notes: [] },
    ...Array.from({ length: FILLER_SPACES }, (_, index) => ({
      slug: `fill-${String(index).padStart(3, '0')}`,
      displayName: `Filler ${index}`,
      notes: [],
    })),
    // Last, so a global scan spends its whole budget before it gets here.
    { slug: 'target', displayName: 'Target', notes: [] },
  ]

  return {
    now: '2099-08-05T12:00:00.000Z',
    spaces,
    auth: {
      users: [
        { username: 'maya', password: 'maya', displayName: 'Maya', personalSpace: 'maya-home' },
      ],
      members: spaces.map((space) => ({
        space: space.slug,
        username: 'maya',
        role: 'owner' as const,
      })),
    },
    agentRoles: Array.from({ length: TARGET_ROLES }, (_, index) => ({
      source: 'custom' as const,
      name: `scoped-role-${String(index + 1).padStart(2, '0')}`,
      description: `Role ${index + 1} of the target Space.`,
      instructions: `# Scoped role ${index + 1}\n\nActs inside the target Space.`,
      target: { kind: 'space' as const, space: 'target' },
    })),
    agentSessions: Array.from({ length: SESSIONS }, (_, index) => ({
      id: `ses_scoped${String(index + 1).padStart(6, '0')}`,
      owner: 'maya',
      name: `Session ${index + 1}`,
      named: true,
      parentId: null,
      createdAt: `2099-08-0${1 + (index % 4)}T00:00:00.000Z`,
      // Descending, so "Session 31" is the oldest and sits behind the first page.
      lastSeenAt: new Date(Date.UTC(2099, 7, 5, 0, 0, SESSIONS - index)).toISOString(),
      calls: 1,
      role: null,
      roleLocator: null,
      roleContextProjectId: null,
    })),
  }
}

describe('a workspace wider than one bounded scan', () => {
  let app: FastifyInstance
  let cookie: string
  let targetSpaceId: string

  beforeAll(async () => {
    app = await createApp(scopedWorld(), { passwordVerifier: () => Promise.resolve(true) })
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'maya', password: 'maya' },
    })
    expect(response.statusCode).toBe(200)
    cookie = (response.headers['set-cookie'] as string).split(';')[0]
    const spaces = await app.inject({ method: 'GET', url: '/api/spaces', headers: { cookie } })
    targetSpaceId = spaces
      .json()
      .spaces.find((space: { slug: string }) => space.slug === 'target').id
  })

  afterAll(async () => {
    await app?.close()
  })

  it('a global scan gives up before the last Space and says so', async () => {
    const global = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles?source=owned&limit=100',
      headers: { cookie },
    })

    expect(global.statusCode, global.body).toBe(200)
    // The bound is the point: without it there would be nothing for `spaceId` to fix,
    // and a listing that swallowed it would look identical to a complete one.
    expect(global.json()).toMatchObject({ items: [], truncated: true })
  })

  it('the scoped query reaches the target Space and every role inside it', async () => {
    const scoped = await app.inject({
      method: 'GET',
      url: `/api/me/agent-roles?spaceId=${encodeURIComponent(targetSpaceId)}&source=owned&limit=100`,
      headers: { cookie },
    })

    expect(scoped.statusCode, scoped.body).toBe(200)
    const names = scoped.json().items.map((item: { name: string }) => item.name)
    expect(names).toHaveLength(TARGET_ROLES)
    expect(names).toContain(`scoped-role-${String(TARGET_ROLES).padStart(2, '0')}`)
    expect(
      scoped
        .json()
        .items.every(
          (item: { locator: { location: { spaceId: string } } }) =>
            item.locator.location.spaceId === targetSpaceId,
        ),
    ).toBe(true)
  })

  it('the owner reaches a session past the first page through its cursor', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/api/me/agent-sessions',
      headers: { cookie },
    })

    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().sessions).toHaveLength(30)
    expect(first.json()).toMatchObject({ total: SESSIONS, hasMore: true })
    expect(first.json().sessions.map((session: { name: string }) => session.name)).not.toContain(
      `Session ${SESSIONS}`,
    )
    const next = await app.inject({
      method: 'GET',
      url: `/api/me/agent-sessions?cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: { cookie },
    })
    expect(next.statusCode, next.body).toBe(200)
    expect(next.json().sessions.map((session: { name: string }) => session.name)).toContain(
      `Session ${SESSIONS}`,
    )
  })
})
