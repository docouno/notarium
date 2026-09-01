import { expect, it } from 'vitest'
import { providerDisclosureOf } from '@notarium/server'

import { createInMemoryProviderPersistence } from './providers'

it('serializes a late provider offer behind the same Space purge boundary', async () => {
  let spaceLive = true
  const providers = createInMemoryProviderPersistence({
    spaceIsLive: async () => spaceLive,
  })
  await providers.providerResources.create(
    {
      id: 'resource-a',
      owner: 'alice',
      name: 'Resource',
      wire: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      headers: {},
      allowPrivateNetwork: false,
      models: [
        {
          name: 'model-a',
          capabilities: ['completion'],
          dimensions: null,
          statusByCapability: { completion: 'available' },
        },
      ],
      defaultModel: null,
      credentialId: null,
      consentEpoch: 0,
      runtimeEpoch: 0,
      disabledAt: null,
      lastCheck: {},
      firstByteTimeoutMs: 30_000,
      callTimeoutMs: 300_000,
    },
    null,
  )
  let purgeEntered!: () => void
  let releasePurge!: () => void
  const entered = new Promise<void>((resolve) => {
    purgeEntered = resolve
  })
  const release = new Promise<void>((resolve) => {
    releasePurge = resolve
  })
  const purge = providers.coordinator.run(async () => {
    providers.purgeSpaceInsideCoordinator('space-a')
    purgeEntered()
    await release
    spaceLive = false
  })

  await entered
  const lateOffer = providers.offerProviderAttachment(
    {
      id: 'attachment-a',
      resourceId: 'resource-a',
      targetKind: 'space',
      targetId: 'space-a',
      targetSpace: 'space-a',
      state: 'pending',
      resourceEpoch: null,
      credentialEpoch: null,
      disclosure: null,
      createdAt: '2026-08-23T00:00:00.000Z',
      expiresAt: '2026-09-06T00:00:00.000Z',
    },
    providerDisclosureOf,
  )
  releasePurge()
  await purge

  await expect(lateOffer).resolves.toEqual({ status: 'target-gone' })
  await expect(providers.providerAttachments.listForSpace('space-a')).resolves.toEqual([])
})
