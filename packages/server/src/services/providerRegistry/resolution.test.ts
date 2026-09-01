import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ATTACHMENT_STATE,
  CredentialCreateRequestSchema,
  PROVIDER_STATUS,
  ProviderResourceCreateRequestSchema,
} from '@notarium/contract'

import { AGENT_SYSTEM_OWNER } from '../authz'
import { CredentialKeyring, CredentialKeyringService } from '../credentialKeyring'
import type { ProviderAttachmentRecord } from '../metaDb'
import { SqliteMetaDb } from '../metaDb/sqliteMetaDb'
import { providerDisclosureOf } from './attachments'
import { ProviderRegistry } from './providerRegistry'
import { providerRecordInvalidity } from './resolution'

const SPACE = 'space-main'
const OTHER_SPACE = 'space-side'
const NOW = '2026-08-25T00:00:00.000Z'

describe('provider resolution', () => {
  let root: string
  let db: SqliteMetaDb
  let keyringFiles: CredentialKeyring
  let keyring: CredentialKeyringService
  let registry: ProviderRegistry
  let attachments = 0

  const seedUser = (username: string, disabledAt: string | null = null) =>
    db.auth.createUser({
      username,
      displayName: username,
      passwordHash: null,
      admin: false,
      disabledAt,
      createdAt: NOW,
      personalSpace: null,
    })

  const seedSpace = (id: string, archivedAt: string | null = null) =>
    db.spaces.upsert({
      id,
      slug: id,
      displayName: id,
      notesDir: id,
      aliases: [],
      createdAt: NOW,
      archivedAt,
      archivedBy: archivedAt ? 'user:alice' : null,
    })

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'notarium-provider-resolution-'))
    db = new SqliteMetaDb(join(root, 'meta.sqlite'))
    keyringFiles = new CredentialKeyring(join(root, 'keyring'), [])
    keyring = new CredentialKeyringService({
      persistence: db.secretKeyring,
      keyring: keyringFiles,
      ciphertexts: db.providerCiphertexts,
    })
    registry = new ProviderRegistry({
      credentials: db.credentials,
      resources: db.providerResources,
      attachments: db.providerAttachments,
      attachmentLifecycle: db,
      spaces: db.spaces,
      projects: db.projects,
      directory: db.auth,
      keyring,
      privateOrigins: new Set(),
    })
    await keyring.bootstrap()
    await seedUser('alice')
    await seedUser('bob')
    await seedSpace(SPACE)
    await seedSpace(OTHER_SPACE)
    await db.auth.upsertMember(SPACE, 'alice', 'writer', NOW)
    await db.auth.upsertMember(SPACE, 'bob', 'owner', NOW)
    attachments = 0
  })

  afterEach(async () => {
    await db.close()
    rmSync(root, { recursive: true, force: true })
  })

  const createCredential = (owner = 'alice') =>
    registry.createCredential(
      owner,
      CredentialCreateRequestSchema.parse({
        name: 'OpenRouter',
        kind: 'bearer',
        secret: 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        origin: 'https://openrouter.ai',
        injection: { header: '', prefix: 'Bearer ' },
      }),
    )

  const createResource = async (owner = 'alice', over: Record<string, unknown> = {}) =>
    (
      await registry.createResource(
        owner,
        ProviderResourceCreateRequestSchema.parse({
          name: 'Main',
          wire: 'openai-compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
          models: [{ name: 'gpt-4o-mini', capabilities: ['completion'] }],
          ...over,
        }),
      )
    ).resource

  /** Vertical 14 ships the acceptance surface; until then an attachment reaches its
   *  state through the facet, exactly as design/11 says it will be shown on the stand. */
  const attach = (resourceId: string, over: Partial<ProviderAttachmentRecord> = {}) => {
    attachments += 1
    return db.offerProviderAttachment(
      {
        id: `attachment-${attachments}`,
        resourceId,
        targetKind: 'space',
        targetId: SPACE,
        targetSpace: SPACE,
        state: ATTACHMENT_STATE.active,
        resourceEpoch: 0,
        credentialEpoch: null,
        disclosure: null,
        createdAt: NOW,
        expiresAt: '2026-09-08T00:00:00.000Z',
        ...over,
      },
      providerDisclosureOf,
    )
  }

  const forPrincipal = async (owner: string, spaces: readonly string[]) =>
    (
      await registry.resolveForPrincipalPage({
        owner,
        spaces,
        after: null,
        limit: 1_000,
      })
    ).entries
  const forBob = () => forPrincipal('bob', [SPACE])
  const hasForBob = () => registry.hasUsableForPrincipal({ owner: 'bob', spaces: [SPACE] })
  const shapeOf = async (
    entries: Promise<Array<{ record: { id: string }; unusableBecause: unknown }>>,
  ) => (await entries).map((entry) => [entry.record.id, entry.unusableBecause])

  it('separates owning from being granted: the two lists are not the same list', async () => {
    const mine = await createResource('bob')

    await expect(shapeOf(forBob())).resolves.toEqual([[mine.id, null]])
    // The whole point of the scope list: background work cannot reach a personal
    // resource nobody attached, not even its owner's.
    await expect(shapeOf(registry.resolveForScope(SPACE))).resolves.toEqual([])
  })

  it('admits a foreign resource whose attachment is active and whose epochs still match', async () => {
    const resource = await createResource('alice')
    await attach(resource.id)

    await expect(shapeOf(forBob())).resolves.toEqual([[resource.id, null]])
    await expect(hasForBob()).resolves.toBe(true)
    await expect(shapeOf(registry.resolveForScope(SPACE))).resolves.toEqual([[resource.id, null]])
  })

  it('keeps a never-accepted offer out of both lists entirely', async () => {
    const resource = await createResource('alice')
    await attach(resource.id, {
      state: ATTACHMENT_STATE.pending,
      resourceEpoch: null,
      credentialEpoch: null,
    })

    await expect(forBob()).resolves.toEqual([])
    await expect(hasForBob()).resolves.toBe(false)
    await expect(registry.resolveForScope(SPACE)).resolves.toEqual([])
  })

  it('suspends a resource whose attachment awaits reconsent, and says why', async () => {
    const resource = await createResource('alice')
    await attach(resource.id, { state: ATTACHMENT_STATE.awaitingReconsent })

    await expect(shapeOf(forBob())).resolves.toEqual([
      [resource.id, PROVIDER_STATUS.attachmentNotActive],
    ])
    await expect(hasForBob()).resolves.toBe(false)
  })

  it('rechecks the accepted epoch pair on every read, not only at acceptance', async () => {
    const resource = await createResource('alice')
    await attach(resource.id)
    await expect(shapeOf(forBob())).resolves.toEqual([[resource.id, null]])

    // A disclosure-changing edit bumps consentEpoch first, then suspends every active
    // attachment in the same transaction. Resolution still rechecks the pair as the
    // fail-closed backstop, but the durable automaton is now honest too.
    await registry.updateResource('alice', resource.id, {
      baseUrl: 'https://openrouter.ai/api/v2',
    })

    await expect(shapeOf(forBob())).resolves.toEqual([
      [resource.id, PROVIDER_STATUS.attachmentNotActive],
    ])
    await expect(hasForBob()).resolves.toBe(false)
    await expect(db.providerAttachments.get('attachment-1')).resolves.toMatchObject({
      state: ATTACHMENT_STATE.awaitingReconsent,
    })
  })

  it('drops a resource whose credential the owner disabled', async () => {
    const credential = await createCredential()
    const resource = await createResource('alice', { credentialId: credential.id })
    await attach(resource.id, { credentialEpoch: 0 })
    await registry.updateCredential('alice', credential.id, { disabled: true })

    await expect(shapeOf(forBob())).resolves.toEqual([
      [resource.id, PROVIDER_STATUS.credentialDisabled],
    ])
    await expect(hasForBob()).resolves.toBe(false)
  })

  it('drops every resource whose ciphertext the host can no longer read', async () => {
    const credential = await createCredential()
    const withCredential = await createResource('alice', { credentialId: credential.id })
    const headersOnly = await createResource('alice', {
      name: 'Local',
      headers: { 'X-Api-Key': 'sk-local-aaaaaaaaaaaaaaaaaaaaaaaa' },
    })
    await attach(withCredential.id, { credentialEpoch: 0 })
    await attach(headersOnly.id)
    // The disaster this predicate exists for: the keyring went missing under a
    // running process. Both carriers must fail, or the header-only resource would
    // look healthy and send its request unauthenticated.
    rmSync(join(root, 'keyring', 'keys'), { recursive: true, force: true })

    await expect(shapeOf(forBob())).resolves.toEqual([
      [headersOnly.id, PROVIDER_STATUS.secretUnreadable],
      [withCredential.id, PROVIDER_STATUS.secretUnreadable],
    ])
    await expect(hasForBob()).resolves.toBe(false)
  })

  it('names a deactivated owner apart from a record its owner switched off', async () => {
    const off = await createResource('alice', { name: 'Switched off' })
    const live = await createResource('alice', { name: 'Live' })
    await attach(off.id)
    await attach(live.id)
    await registry.updateResource('alice', off.id, { disabled: true })
    await db.auth.updateUser('alice', { disabledAt: NOW })

    await expect(shapeOf(forBob())).resolves.toEqual([
      [live.id, PROVIDER_STATUS.ownerDisabled],
      [off.id, PROVIDER_STATUS.disabled],
    ])
    await expect(hasForBob()).resolves.toBe(false)
  })

  it('returns a reactivated owner resources without a second acceptance', async () => {
    const credential = await createCredential()
    const resource = await createResource('alice', { credentialId: credential.id })
    await attach(resource.id, { credentialEpoch: 0 })
    await db.auth.updateUser('alice', { disabledAt: NOW })
    await expect(shapeOf(forBob())).resolves.toEqual([[resource.id, PROVIDER_STATUS.ownerDisabled]])

    await db.auth.updateUser('alice', { disabledAt: null })

    // Nothing durable was touched by either half of the round trip.
    await expect(shapeOf(forBob())).resolves.toEqual([[resource.id, null]])
    await expect(db.credentials.get(credential.id)).resolves.toMatchObject({ disabledAt: null })
    await expect(db.providerAttachments.get('attachment-1')).resolves.toMatchObject({
      state: ATTACHMENT_STATE.active,
      resourceEpoch: 0,
    })
  })

  it('derives an archived Space instead of cascading into its attachment rows', async () => {
    const resource = await createResource('alice')
    await attach(resource.id)
    await seedSpace(SPACE, NOW)

    await expect(shapeOf(forBob())).resolves.toEqual([[resource.id, PROVIDER_STATUS.spaceArchived]])
    await expect(hasForBob()).resolves.toBe(false)
    await expect(db.providerAttachments.get('attachment-1')).resolves.toMatchObject({
      state: ATTACHMENT_STATE.active,
    })

    await seedSpace(SPACE, null)
    await expect(shapeOf(forBob())).resolves.toEqual([[resource.id, null]])
    await expect(hasForBob()).resolves.toBe(true)
  })

  it('refuses a resource whose owner is no longer a member of the target Space', async () => {
    const resource = await createResource('alice')
    await attach(resource.id)
    // The cascade removes such rows; this is the backstop for the row it missed.
    await db.auth.removeMember(SPACE, 'alice')

    await expect(shapeOf(forBob())).resolves.toEqual([
      [resource.id, PROVIDER_STATUS.attachmentNotActive],
    ])
    await expect(hasForBob()).resolves.toBe(false)
  })

  it('lets a project attachment grant the Space the project lives in', async () => {
    const resource = await createResource('alice')
    await attach(resource.id, { targetKind: 'project', targetId: 'project-a' })

    await expect(shapeOf(forBob())).resolves.toEqual([[resource.id, null]])
  })

  it('keeps an exhausted quota a status of the record, never a reason to hide it', async () => {
    const resource = await createResource('alice')
    await attach(resource.id)
    await db.providerResources.recordLastCheck({
      resourceId: resource.id,
      capability: 'completion',
      lastCheck: {
        status: PROVIDER_STATUS.quotaExhausted,
        checkedAt: NOW,
        diagnostic: null,
        credentialProven: true,
      },
      measurement: null,
      expectedRuntimeEpoch: 0,
      expectedCredentialId: null,
      expectedCredentialRuntimeEpoch: null,
    })

    await expect(shapeOf(forBob())).resolves.toEqual([[resource.id, null]])
  })

  it('answers an empty list rather than an error when nothing is configured', async () => {
    await expect(forBob()).resolves.toEqual([])
    await expect(registry.resolveForScope(SPACE)).resolves.toEqual([])
  })

  it('lets one intact grant outweigh a broken one for the same resource', async () => {
    const resource = await createResource('alice')
    await db.auth.upsertMember(OTHER_SPACE, 'alice', 'writer', NOW)
    await db.auth.upsertMember(OTHER_SPACE, 'bob', 'reader', NOW)
    await attach(resource.id, { state: ATTACHMENT_STATE.awaitingReconsent })
    await attach(resource.id, {
      targetId: OTHER_SPACE,
      targetSpace: OTHER_SPACE,
    })

    await expect(shapeOf(forPrincipal('bob', [SPACE, OTHER_SPACE]))).resolves.toEqual([
      [resource.id, null],
    ])
  })

  it('drops the attachments of a deleted resource without touching its credential', async () => {
    const credential = await createCredential()
    const resource = await createResource('alice', { credentialId: credential.id })
    await attach(resource.id, { credentialEpoch: 0 })
    await registry.deleteResource('alice', resource.id)

    await expect(db.providerAttachments.listForSpace(SPACE)).resolves.toEqual([])
    await expect(db.credentials.get(credential.id)).resolves.toMatchObject({ id: credential.id })
    await expect(forBob()).resolves.toEqual([])
  })

  it('treats the authless host owner key as the instance, not as a missing person', async () => {
    // `@system` has no account row and no membership row anywhere, by construction:
    // in AUTH_MODE=none neither table has any. Reading it as corruption would make
    // every resource on such a host unusable.
    const resource = await createResource(AGENT_SYSTEM_OWNER)
    await attach(resource.id)

    await expect(shapeOf(registry.resolveForScope(SPACE))).resolves.toEqual([[resource.id, null]])
    await expect(db.auth.getUser(AGENT_SYSTEM_OWNER)).resolves.toBeNull()
    await expect(db.auth.grantsFor(AGENT_SYSTEM_OWNER)).resolves.toEqual([])
  })

  it('asks the keyring nothing when there is nothing to judge', async () => {
    // A promise created on a path that never awaits it is a process fault, not a
    // wasted read: a keyring that throws would leave an unhandled rejection behind
    // a route that already answered 200.
    const unhandled: unknown[] = []
    const capture = (reason: unknown) => unhandled.push(reason)
    let reads = 0
    const failing = new ProviderRegistry({
      credentials: db.credentials,
      resources: db.providerResources,
      attachments: db.providerAttachments,
      attachmentLifecycle: db,
      spaces: db.spaces,
      projects: db.projects,
      directory: db.auth,
      keyring: {
        ...keyring,
        readableKeyIds: async () => {
          reads += 1
          throw new Error('credential keyring contains an unrecognized key file')
        },
      } as unknown as CredentialKeyringService,
      privateOrigins: new Set(),
    })
    process.on('unhandledRejection', capture)

    try {
      await expect(
        failing.resolveForPrincipalPage({ owner: 'bob', spaces: [SPACE], after: null, limit: 100 }),
      ).resolves.toMatchObject({ entries: [] })
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      process.off('unhandledRejection', capture)
    }

    expect(reads).toBe(0)
    expect(unhandled).toEqual([])
  })

  it('asks the whole grant set once however many Spaces the owner is attached to', async () => {
    const resource = await createResource('alice')
    await db.auth.upsertMember(OTHER_SPACE, 'alice', 'writer', NOW)
    await db.auth.upsertMember(OTHER_SPACE, 'bob', 'reader', NOW)
    await attach(resource.id, { state: ATTACHMENT_STATE.awaitingReconsent })
    await attach(resource.id, { targetId: OTHER_SPACE, targetSpace: OTHER_SPACE })
    let grantReads = 0
    const counted = new ProviderRegistry({
      credentials: db.credentials,
      resources: db.providerResources,
      attachments: db.providerAttachments,
      attachmentLifecycle: db,
      spaces: db.spaces,
      projects: db.projects,
      directory: {
        getUser: (username: string) => db.auth.getUser(username),
        grantsFor: (username: string) => {
          grantReads += 1
          return db.auth.grantsFor(username)
        },
      },
      keyring,
      privateOrigins: new Set(),
    })

    const page = await counted.resolveForPrincipalPage({
      owner: 'bob',
      spaces: [SPACE, OTHER_SPACE],
      after: null,
      limit: 100,
    })
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]?.record.id).toBe(resource.id)
    expect(grantReads).toBe(1)
  })

  it('hydrates a large effective read through one batch per persistence facet', async () => {
    const credential = await createCredential()
    const first = await createResource('alice', { name: 'First', credentialId: credential.id })
    const second = await createResource('alice', { name: 'Second', credentialId: credential.id })
    await db.auth.upsertMember(OTHER_SPACE, 'alice', 'writer', NOW)
    await db.auth.upsertMember(OTHER_SPACE, 'bob', 'reader', NOW)
    await attach(first.id, { credentialEpoch: 0 })
    await attach(second.id, {
      targetId: OTHER_SPACE,
      targetSpace: OTHER_SPACE,
      credentialEpoch: 0,
    })
    const calls = {
      attachments: vi.fn(db.providerAttachments.listForResourcesInSpaces),
      resources: vi.fn(db.providerResources.getMany),
      credentials: vi.fn(db.credentials.getMany),
      spaces: vi.fn(db.spaces.getMany),
      users: vi.fn(db.auth.getUsers),
      grants: vi.fn(db.auth.grantsForUsers),
      keys: vi.fn((requiredKeyIds: ReadonlySet<string>) => keyring.readableKeyIds(requiredKeyIds)),
    }

    const noSingleRead = async (): Promise<never> => {
      throw new Error('resolution regressed to a row-wise read')
    }
    const counted = new ProviderRegistry({
      credentials: {
        ...db.credentials,
        get: noSingleRead,
        getMany: calls.credentials,
      },
      resources: {
        ...db.providerResources,
        get: noSingleRead,
        getMany: calls.resources,
      },
      attachments: {
        ...db.providerAttachments,
        listForSpace: noSingleRead,
        listForSpaces: noSingleRead,
        listForResourcesInSpaces: calls.attachments,
      },
      attachmentLifecycle: db,
      spaces: {
        ...db.spaces,
        getById: noSingleRead,
        getMany: calls.spaces,
      },
      projects: db.projects,
      directory: {
        getUser: noSingleRead,
        grantsFor: noSingleRead,
        getUsers: calls.users,
        grantsForUsers: calls.grants,
      },
      keyring: {
        readableKeyIds: calls.keys,
      } as unknown as CredentialKeyringService,
      privateOrigins: new Set(),
    })

    await expect(
      counted
        .resolveForPrincipalPage({
          owner: 'bob',
          spaces: [SPACE, OTHER_SPACE],
          after: null,
          limit: 100,
        })
        .then(({ entries }) => entries),
    ).resolves.toHaveLength(2)
    expect(
      Object.fromEntries(
        Object.entries(calls).map(([name, call]) => [name, call.mock.calls.length]),
      ),
    ).toEqual({
      attachments: 1,
      resources: 1,
      credentials: 1,
      spaces: 1,
      users: 1,
      grants: 1,
      keys: 1,
    })
    const activeKeyId = (await db.secretKeyring.active())[0].keyId
    expect(calls.keys).toHaveBeenCalledWith(new Set([activeKeyId]))
  })

  it('resolves one consented id without scanning an inventory page', async () => {
    const credential = await createCredential()
    const resource = await createResource('alice', { credentialId: credential.id })
    await attach(resource.id, { credentialEpoch: 0 })
    const calls = {
      resource: vi.fn(db.providerResources.get),
      attachments: vi.fn(db.providerAttachments.listForResourcesInSpaces),
      credentials: vi.fn(db.credentials.getMany),
      spaces: vi.fn(db.spaces.getMany),
      users: vi.fn(db.auth.getUsers),
      grants: vi.fn(db.auth.grantsForUsers),
      keys: vi.fn((requiredKeyIds: ReadonlySet<string>) => keyring.readableKeyIds(requiredKeyIds)),
    }

    const noInventoryRead = async (): Promise<never> => {
      throw new Error('exact resolution regressed to an inventory read')
    }
    const counted = new ProviderRegistry({
      credentials: { ...db.credentials, getMany: calls.credentials },
      resources: {
        ...db.providerResources,
        get: calls.resource,
        listForOwner: noInventoryRead,
        pageEffectiveIds: noInventoryRead,
      },
      attachments: {
        ...db.providerAttachments,
        listForSpace: noInventoryRead,
        listForSpaces: noInventoryRead,
        listForResourcesInSpaces: calls.attachments,
      },
      attachmentLifecycle: db,
      spaces: { ...db.spaces, getMany: calls.spaces },
      projects: db.projects,
      directory: {
        ...db.auth,
        getUsers: calls.users,
        grantsForUsers: calls.grants,
      },
      keyring: { readableKeyIds: calls.keys } as unknown as CredentialKeyringService,
      privateOrigins: new Set(),
    })

    await expect(
      counted.resolveOneForPrincipal({ owner: 'bob', spaces: [SPACE], resourceId: resource.id }),
    ).resolves.toMatchObject({ record: { id: resource.id }, unusableBecause: null })
    expect(
      Object.fromEntries(
        Object.entries(calls).map(([name, call]) => [name, call.mock.calls.length]),
      ),
    ).toEqual({
      resource: 1,
      attachments: 1,
      credentials: 1,
      spaces: 1,
      users: 1,
      grants: 1,
      keys: 1,
    })
    expect(calls.attachments).toHaveBeenCalledWith([resource.id], [SPACE])
  })

  it('resolves a bounded owner status batch without foreign facts or row-wise reads', async () => {
    const mine = await createCredential('bob')
    const foreign = await createCredential('alice')
    const ownedResource = await createResource('bob', { credentialId: mine.id })
    const foreignResource = await createResource('alice', { credentialId: foreign.id })
    await registry.updateCredential('bob', mine.id, { disabled: true })
    const calls = {
      resources: vi.fn(db.providerResources.getMany),
      credentials: vi.fn(db.credentials.getMany),
      user: vi.fn(db.auth.getUser),
      keys: vi.fn((requiredKeyIds: ReadonlySet<string>) => keyring.readableKeyIds(requiredKeyIds)),
    }

    const forbidden = async (): Promise<never> => {
      throw new Error('owner status resolution crossed an unrelated or row-wise port')
    }
    const counted = new ProviderRegistry({
      credentials: { ...db.credentials, get: forbidden, getMany: calls.credentials },
      resources: { ...db.providerResources, get: forbidden, getMany: calls.resources },
      attachments: {
        ...db.providerAttachments,
        listForSpace: forbidden,
        listForSpaces: forbidden,
        listForResourcesInSpaces: forbidden,
      },
      attachmentLifecycle: db,
      spaces: { getById: forbidden, getMany: forbidden },
      projects: db.projects,
      directory: {
        getUser: calls.user,
        grantsFor: forbidden,
        getUsers: forbidden,
        grantsForUsers: forbidden,
      },
      keyring: { readableKeyIds: calls.keys } as unknown as CredentialKeyringService,
      privateOrigins: new Set(),
    })

    await expect(
      shapeOf(
        counted.resolveOwnedMany({
          owner: 'bob',
          resourceIds: [foreignResource.id, 'missing-resource', ownedResource.id],
        }),
      ),
    ).resolves.toEqual([[ownedResource.id, PROVIDER_STATUS.credentialDisabled]])
    expect(calls.resources).toHaveBeenCalledOnce()
    expect(calls.resources).toHaveBeenCalledWith([
      foreignResource.id,
      'missing-resource',
      ownedResource.id,
    ])
    expect(calls.credentials).toHaveBeenCalledOnce()
    expect(calls.credentials).toHaveBeenCalledWith([mine.id])
    expect(calls.user).toHaveBeenCalledOnce()
    expect(calls.user).toHaveBeenCalledWith('bob')
    expect(calls.keys).toHaveBeenCalledOnce()

    await expect(
      counted.resolveOwnedMany({
        owner: 'bob',
        resourceIds: Array.from({ length: 101 }, (_, index) => `resource-${index}`),
      }),
    ).rejects.toThrow(/exceeds its limit/)
    expect(calls.resources).toHaveBeenCalledOnce()
  })

  it('short-circuits the first usable keyset window and bounds an all-unusable walk', async () => {
    for (let index = 0; index < 205; index += 1) {
      const suffix = String(index).padStart(3, '0')
      await db.providerResources.create(
        {
          id: `bulk-${suffix}`,
          owner: 'alice',
          name: index === 0 ? 'A usable' : `Disabled ${suffix}`,
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
          disabledAt: index === 0 ? null : NOW,
          lastCheck: {},
          firstByteTimeoutMs: null,
          callTimeoutMs: null,
        },
        null,
      )
    }
    const scan = vi.fn(db.providerResources.scanEffectivePage)
    const resources = vi.fn(db.providerResources.getMany)
    const fullInventory = vi.fn(async (): Promise<never> => {
      throw new Error('boolean resolution regressed to the full inventory')
    })
    const counted = new ProviderRegistry({
      credentials: db.credentials,
      resources: {
        ...db.providerResources,
        getMany: resources,
        listForOwner: fullInventory,
        scanEffectivePage: scan,
      },
      attachments: db.providerAttachments,
      attachmentLifecycle: db,
      spaces: db.spaces,
      projects: db.projects,
      directory: db.auth,
      keyring,
      privateOrigins: new Set(),
    })

    await expect(counted.hasUsableForPrincipal({ owner: 'alice', spaces: [] })).resolves.toBe(true)
    expect(scan).toHaveBeenCalledOnce()
    expect(resources.mock.calls.map(([ids]) => ids.length)).toEqual([100])

    await registry.updateResource('alice', 'bulk-000', { disabled: true })
    scan.mockClear()
    resources.mockClear()
    await expect(counted.hasUsableForPrincipal({ owner: 'alice', spaces: [] })).resolves.toBe(false)
    expect(scan).toHaveBeenCalledTimes(3)
    expect(resources.mock.calls.map(([ids]) => ids.length)).toEqual([100, 100, 5])
    expect(fullInventory).not.toHaveBeenCalled()
  })

  it('turns live key deletion and same-name replacement into secret-unreadable', async () => {
    const credential = await createCredential()
    const resource = await createResource('alice', { credentialId: credential.id })
    await attach(resource.id, { credentialEpoch: 0 })
    const active = (await db.secretKeyring.active())[0]
    const activePath = join(keyringFiles.keysDir, `${active.keyId}.json`)
    const original = await readFile(activePath)

    await expect(shapeOf(registry.resolveForScope(SPACE))).resolves.toEqual([[resource.id, null]])
    await rm(activePath)
    await expect(shapeOf(registry.resolveForScope(SPACE))).resolves.toEqual([
      [resource.id, PROVIDER_STATUS.secretUnreadable],
    ])

    await writeFile(activePath, original)
    await expect(shapeOf(registry.resolveForScope(SPACE))).resolves.toEqual([[resource.id, null]])
    const replacement = await keyringFiles.createCandidate()
    const replacementPath = join(keyringFiles.keysDir, `${replacement.keyId}.json`)
    const replacementBytes = await readFile(replacementPath)
    await writeFile(activePath, replacementBytes)
    replacement.secret.fill(0)

    await expect(shapeOf(registry.resolveForScope(SPACE))).resolves.toEqual([
      [resource.id, PROVIDER_STATUS.secretUnreadable],
    ])
  })
})

describe('provider record invalidity', () => {
  const record = {
    id: 'resource-a',
    owner: 'alice',
    name: 'Main',
    wire: 'openai-compatible' as const,
    baseUrl: 'https://openrouter.ai/api/v1',
    headers: {} as Record<string, string>,
    allowPrivateNetwork: false,
    models: [
      {
        name: 'model-a',
        capabilities: ['completion' as const],
        dimensions: null,
        statusByCapability: { completion: 'available' as const },
      },
    ],
    defaultModel: null,
    credentialId: null as string | null,
    consentEpoch: 0,
    runtimeEpoch: 0,
    disabledAt: null as string | null,
    lastCheck: {},
    firstByteTimeoutMs: null,
    callTimeoutMs: null,
  }
  const credential = {
    id: 'credential-a',
    owner: 'alice',
    name: 'OpenRouter',
    kind: 'bearer' as const,
    secret: 'v1.ck_000000000000000000000000.payload',
    origin: 'https://openrouter.ai',
    injection: { header: '', prefix: 'Bearer ' },
    disabledAt: null as string | null,
    rpm: null,
    tpm: null,
    consentEpoch: 0,
    runtimeEpoch: 0,
  }
  const readableKeyIds = new Set(['ck_000000000000000000000000'])

  it('reads BOTH ciphertext carriers, so a credential-less resource cannot look healthy', () => {
    expect(
      providerRecordInvalidity({
        record: {
          ...record,
          headers: { 'x-api-key': 'v1.ck_ffffffffffffffffffffffff.payload' },
        },
        credential: null,
        ownerDisabled: false,
        readableKeyIds,
      }),
    ).toBe(PROVIDER_STATUS.secretUnreadable)
    expect(
      providerRecordInvalidity({
        record: { ...record, credentialId: credential.id },
        credential: { ...credential, secret: 'v1.ck_ffffffffffffffffffffffff.payload' },
        ownerDisabled: false,
        readableKeyIds,
      }),
    ).toBe(PROVIDER_STATUS.secretUnreadable)
  })

  it('treats a reference with no credential row left as unreadable, not as usable', () => {
    expect(
      providerRecordInvalidity({
        record: { ...record, credentialId: credential.id },
        credential: null,
        ownerDisabled: false,
        readableKeyIds,
      }),
    ).toBe(PROVIDER_STATUS.secretUnreadable)
  })

  it('refuses a credential whose origin drifted away from the addressee', () => {
    expect(
      providerRecordInvalidity({
        record: { ...record, credentialId: credential.id },
        credential: { ...credential, origin: 'https://elsewhere.example' },
        ownerDisabled: false,
        readableKeyIds,
      }),
    ).toBe(PROVIDER_STATUS.credentialOriginMismatch)
  })

  it('passes an intact record', () => {
    expect(
      providerRecordInvalidity({
        record: { ...record, credentialId: credential.id },
        credential,
        ownerDisabled: false,
        readableKeyIds,
      }),
    ).toBeNull()
  })
})
