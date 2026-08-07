import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildCaseWorld, caseToFixture } from '../cases'
import { createApp } from './app.js'

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
      catalog: [{ name: 'grooming' }, { name: 'research' }],
      roles: [],
      activeRole: null,
    })
    const catalogDetail = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles/grooming?scope=catalog',
      headers: { cookie: catalogUser },
    })
    expect(catalogDetail.statusCode).toBe(200)
    expect(catalogDetail.json()).toMatchObject({
      role: { name: 'grooming', scope: 'catalog' },
      skills: [{ name: 'grooming-evidence' }],
      truncated: false,
    })
    expect(catalogDetail.json().role.instructions).toContain('Establish the underlying pain')

    const idle = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles',
      headers: { cookie: bob },
    })
    expect(idle.json()).toMatchObject({
      roles: [{ name: 'grooming', scope: 'personal', origin: 'builtin:grooming' }],
      activeRole: null,
    })
    expect(idle.json().roles[0]).not.toHaveProperty('space')
    const ownedDetail = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles/grooming?scope=personal',
      headers: { cookie: bob },
    })
    expect(ownedDetail.statusCode).toBe(200)
    expect(ownedDetail.json()).toMatchObject({
      role: { name: 'grooming', scope: 'personal', origin: 'builtin:grooming' },
      skills: [{ name: 'grooming-evidence' }],
    })

    const someoneElsesPersonal = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles/grooming?scope=personal',
      headers: { cookie: catalogUser },
    })
    expect(someoneElsesPersonal.statusCode).toBe(404)

    const active = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles',
      headers: { cookie: maya },
    })
    expect(active.json()).toMatchObject({
      roles: expect.arrayContaining([
        expect.objectContaining({ name: 'research', scope: 'personal' }),
        expect.objectContaining({ name: 'research', scope: 'space', space: 'team' }),
        expect.objectContaining({
          name: 'research',
          scope: 'project',
          project: 'team/other',
        }),
        expect.objectContaining({
          name: 'research',
          scope: 'project',
          project: 'maya-home/work',
        }),
      ]),
      activeRole: 'research',
    })
    const projectDetail = await app.inject({
      method: 'GET',
      url: '/api/me/agent-roles/research?scope=project&project=maya-home%2Fwork',
      headers: { cookie: maya },
    })
    expect(projectDetail.statusCode).toBe(200)
    expect(projectDetail.json()).toMatchObject({
      role: { name: 'research', scope: 'project' },
      skills: [{ name: 'research-evidence' }],
    })
  })

  it('copies on Add, rejects an overwrite, and only then lets MCP activate the role', async () => {
    const cookie = await login('sergey', 'sergey')
    const add = await app.inject({
      method: 'POST',
      url: '/api/me/agent-roles',
      headers: { cookie },
      payload: { name: 'grooming', scope: 'personal' },
    })
    expect(add.statusCode).toBe(201)
    expect(add.json()).toMatchObject({
      role: { name: 'grooming', scope: 'personal', origin: 'builtin:grooming' },
    })
    expect(add.json().role).not.toHaveProperty('space')
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
    const projectAdd = await app.inject({
      method: 'POST',
      url: '/api/me/agent-roles',
      headers: { cookie },
      payload: { name: 'research', scope: 'project', project: 'main' },
    })
    expect(projectAdd.statusCode).toBe(201)
    expect(projectAdd.json()).toMatchObject({
      role: { name: 'research', scope: 'project', project: 'main' },
    })
    const sameNameProjectAdd = await app.inject({
      method: 'POST',
      url: '/api/me/agent-roles',
      headers: { cookie },
      payload: { name: 'grooming', scope: 'project', project: 'main' },
    })
    expect(sameNameProjectAdd.statusCode).toBe(201)

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

    const firstRoles = await call('list_roles', { project: 'main', limit: 1 })
    expect(firstRoles.result?.structuredContent).toEqual({
      roles: [expect.objectContaining({ name: 'grooming', scope: 'project' })],
      total: 2,
      nextCursor: '1',
    })
    const secondRoles = await call('list_roles', {
      project: 'main',
      cursor: '1',
      limit: 1,
    })
    expect(secondRoles.result?.structuredContent).toEqual({
      roles: [expect.objectContaining({ name: 'research', scope: 'project' })],
      total: 2,
    })
    expect(
      (secondRoles.result?.structuredContent as { roles: Array<{ scope: string }> }).roles.some(
        ({ scope }) => scope === 'catalog',
      ),
    ).toBe(false)

    const unavailableBootstrap = await call('start_session', {
      role: 'research',
      session: { name: 'must-not-be-created' },
    })
    expect(unavailableBootstrap.result?.isError).toBe(true)
    expect(JSON.stringify(unavailableBootstrap.result?.content)).toContain(
      'available roles: grooming',
    )

    const opened = await call('start_session', { role: 'grooming' })
    expect(opened.result?.isError).not.toBe(true)
    expect(opened.result?.structuredContent).toMatchObject({
      roles: [{ name: 'grooming', scope: 'personal' }],
      activeRole: {
        status: 'activated',
        role: { name: 'grooming' },
        skills: [{ name: 'grooming-evidence' }],
      },
    })
    const recent = (
      opened.result?.structuredContent as { recentSessions?: Array<{ name: string }> }
    ).recentSessions
    expect(recent?.map((entry) => entry.name) ?? []).not.toContain('must-not-be-created')
    const session = (opened.result?.structuredContent as { session: { id: string } }).session.id
    const repeated = await call('use_role', { role: 'grooming', session })
    expect(repeated.result?.structuredContent).toMatchObject({
      status: 'already_active',
      role: { name: 'grooming' },
    })
    expect(repeated.result?.structuredContent).toMatchObject({
      instructions: expect.stringContaining('Grooming'),
      skills: [{ name: 'grooming-evidence' }],
    })
    expect(contentText(repeated)).toContain('# Active role: grooming')
    expect(contentText(repeated)).toContain('Establish the underlying pain')
    expect(contentText(repeated)).toContain('## Linked skill: grooming-evidence')
    const projectOverride = await call('use_role', { role: 'grooming', project: 'main', session })
    expect(projectOverride.result?.structuredContent).toMatchObject({
      status: 'already_active',
      role: { name: 'grooming', scope: 'project' },
      instructions: expect.stringContaining('Grooming'),
      skills: [{ name: 'grooming-evidence' }],
    })
    expect(contentText(projectOverride)).toContain('# Active role: grooming')
    expect(contentText(projectOverride)).toContain('Establish the underlying pain')
    const resumed = await call('start_session', { session: { id: session } })
    expect(resumed.result?.structuredContent).toMatchObject({
      activeRole: {
        status: 'already_active',
        role: { name: 'grooming', scope: 'personal' },
        instructions: expect.stringContaining('Grooming'),
        skills: [{ name: 'grooming-evidence' }],
      },
    })
    expect(contentText(resumed)).toContain('# Active role: grooming')
    expect(contentText(resumed)).toContain('Establish the underlying pain')
    const explicitlyResumed = await call('start_session', {
      session: { id: session },
      role: 'grooming',
    })
    expect(explicitlyResumed.result?.structuredContent).toMatchObject({
      activeRole: {
        status: 'already_active',
        instructions: expect.stringContaining('Grooming'),
      },
    })
    expect(contentText(explicitlyResumed)).toContain('# Active role: grooming')
    expect(contentText(explicitlyResumed)).toContain('Establish the underlying pain')
    const unavailable = await call('use_role', { role: 'research', session })
    expect(unavailable.result?.isError).toBe(true)
    expect(JSON.stringify(unavailable.result?.content)).toContain('available roles: grooming')

    const firstSearch = await call('search', { query: 'nothing here', session })
    expect(firstSearch.result?.isError).not.toBe(true)
    const repeatedSearch = await call('search', { query: 'nothing here', session })
    expect(repeatedSearch.result?.isError).toBe(true)
    expect(repeatedSearch.result?.structuredContent).toEqual({ results: [] })
    expect(JSON.stringify(repeatedSearch.result?.content)).toContain(
      'identical search arguments already returned',
    )
    expect(JSON.stringify(repeatedSearch.result?.content)).toContain('get_note')
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
})
