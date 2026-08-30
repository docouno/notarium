import { describe, expect, it } from 'vitest'

import { createApp } from '../fake-server/app'
import type { InMemoryProviderPersistence } from '../fake-server/providers'
import { AXIS_IDS } from './axes'
import { buildCaseWorld } from './build'
import { CASES } from './registry'
import { caseToFixture } from './toFixture'

describe('provider seed coverage', () => {
  it('registers an explicit provider axis and both enabled and disabled worlds', () => {
    expect(AXIS_IDS).toContain('providers')
    expect(CASES.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['providers', 'providers-disabled']),
    )
  })

  it('projects every provider state through encrypted fake persistence', async () => {
    const fixture = caseToFixture(buildCaseWorld('providers'))
    let providers: InMemoryProviderPersistence | undefined
    const app = await createApp(fixture, {
      passwordVerifier: () => Promise.resolve(true),
      onProviderPersistence: (value) => {
        providers = value
      },
    })

    try {
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'sergey', password: 'seed-pass' },
      })
      expect(login.statusCode).toBe(200)
      const cookie = (login.headers['set-cookie'] as string).split(';')[0]
      const credentials = await app.inject({
        method: 'GET',
        url: '/api/providers/credentials',
        headers: { cookie },
      })
      expect(credentials.statusCode).toBe(200)
      expect(credentials.json().items).toHaveLength(4)
      expect(credentials.body).not.toContain('seed-provider-value')

      const effective = await app.inject({
        method: 'GET',
        url: '/api/providers/effective',
        headers: { cookie },
      })
      expect(effective.statusCode).toBe(200)
      const invalidity = new Map(
        effective
          .json()
          .items.map((item: { resource: { name: string }; unusableBecause: string | null }) => [
            item.resource.name,
            item.unusableBecause,
          ]),
      )
      expect(invalidity.get('Primary')).toBeNull()
      expect(invalidity.get('Credential disabled')).toBe('credential-disabled')
      expect(invalidity.get('Credential origin mismatch')).toBe('credential-origin-mismatch')
      expect(invalidity.get('Unreadable custom header')).toBe('secret-unreadable')
      expect(invalidity.get('Deactivated owner resource')).toBe('owner-disabled')
      expect(invalidity.get('Archived Space resource')).toBe('space-archived')

      const attachments = await app.inject({
        method: 'GET',
        url: '/api/s/main/providers/attachments',
        headers: { cookie },
      })
      expect(attachments.statusCode).toBe(200)
      const items = attachments.json().items as Array<{
        attachment: { id: string; state: string; createdAt: string; expiresAt: string }
        resource: { name: string }
      }>
      const byName = new Map(items.map((item) => [item.resource.name, item]))
      expect(byName.get('Changed after acceptance')).toMatchObject({
        attachment: { state: 'awaiting-reconsent' },
      })
      const changed = byName.get('Changed after acceptance')!
      const changedDetail = await app.inject({
        method: 'GET',
        url: `/api/providers/attachments/${changed.attachment.id}`,
        headers: { cookie },
      })
      expect(changedDetail.statusCode).toBe(200)
      expect(changedDetail.json()).toMatchObject({ view: { diff: { changed: true } } })
      const pending = byName.get('Offer near expiry')
      expect(pending?.attachment.state).toBe('pending')
      expect(
        Date.parse(pending!.attachment.expiresAt) - Date.parse(pending!.attachment.createdAt),
      ).toBe(5 * 60 * 1000)

      const storedCredentials = await providers!.credentials.list()
      const storedResources = await providers!.providerResources.list()
      expect(storedCredentials.every(({ secret }) => secret.startsWith('v1.ck_'))).toBe(true)
      expect(JSON.stringify(storedCredentials)).not.toContain('seed-provider-value')
      expect(JSON.stringify(storedResources)).not.toContain('seed-provider-header-value')
      expect(
        Object.values(
          storedResources.find(({ name }) => name === 'Unreadable custom header')!.headers,
        ),
      ).toEqual(['v1.ck_000000000000000000000000.AA'])
    } finally {
      await app.close()
    }
  }, 60_000)

  it('seeds encrypted rows without publishing the disabled provider capability', async () => {
    const fixture = caseToFixture(buildCaseWorld('providers-disabled'))
    let providers: InMemoryProviderPersistence | undefined
    const app = await createApp(fixture, {
      passwordVerifier: () => Promise.resolve(true),
      onProviderPersistence: (value) => {
        providers = value
      },
    })

    try {
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'sergey', password: 'seed-pass' },
      })
      const cookie = (login.headers['set-cookie'] as string).split(';')[0]
      const [about, credentials] = await Promise.all([
        app.inject({ method: 'GET', url: '/api/about', headers: { cookie } }),
        app.inject({
          method: 'GET',
          url: '/api/providers/credentials',
          headers: { cookie },
        }),
      ])

      expect(about.json().admin).not.toHaveProperty('providers')
      expect(credentials.statusCode).toBe(404)
      expect(await providers!.credentials.list()).toMatchObject([
        { name: 'Preserved while disabled', secret: expect.stringMatching(/^v1\.ck_/) },
      ])
      expect(await providers!.providerResources.list()).toHaveLength(1)
    } finally {
      await app.close()
    }
  }, 60_000)
})
