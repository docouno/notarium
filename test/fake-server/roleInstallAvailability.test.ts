import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp, type Fixture } from './app.js'

const fixture = (): Fixture => ({
  spaces: [{ slug: 'team', displayName: 'Team', notes: [] }],
  projects: [
    { space: 'team', path: 'live', displayName: 'Live' },
    { space: 'team', path: 'retired', displayName: 'Retired', status: 'archived' },
  ],
})

describe('role install availability project lifecycle', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
  })

  it('keeps an archived reach nameable without offering it as an Add target', async () => {
    app = await createApp(fixture())

    const response = await app.inject({ method: 'GET', url: '/api/me/agent-roles' })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().projects.map((project: { handle: string }) => project.handle)).toEqual([
      'team/live',
      'team/retired',
    ])
    expect(response.json().installAvailability.projects).toEqual({
      'team/live': true,
      'team/retired': false,
    })
  })
})
