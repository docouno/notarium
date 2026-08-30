import { ATTACHMENT_STATE, DEFAULT_CREDENTIAL_HEADER } from '@notarium/contract'
import type {
  CiphertextWrite,
  CredentialRecord,
  CredentialsPersistence,
  ProviderAttachmentLifecyclePersistence,
  ProviderAttachmentRecord,
  ProviderAttachmentsPersistence,
  ProviderCiphertextsPersistence,
  ProviderResourceRecord,
  ProviderResourcesPersistence,
  ProviderRetargetInput,
  ProviderRetargetResult,
} from '@notarium/server'
import { PROVIDER_PERSISTENCE_ERROR, providerPersistenceError } from '@notarium/server'
import { mergedProviderModels } from '../../packages/server/src/services/metaDb/drivers/providerModels'
import {
  providerCiphertextBatch,
  providerCiphertextCounts,
  providerCiphertextKeyId,
  providerUnreadablePlan,
  readableProviderHeaders,
} from '../../packages/server/src/services/metaDb/providerCiphertexts'

export class InMemoryProviderCoordinator {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(task: () => Promise<T> | T): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await task()
    } finally {
      release()
    }
  }
}

const copyCredential = (record: CredentialRecord): CredentialRecord => ({
  ...record,
  injection: { ...record.injection },
})

const copyResource = (record: ProviderResourceRecord): ProviderResourceRecord => ({
  ...record,
  headers: { ...record.headers },
  purposes: [...record.purposes],
  models: record.models.map((model) => ({ ...model })),
  lastCheck: { ...record.lastCheck },
})

const copyAttachment = (record: ProviderAttachmentRecord): ProviderAttachmentRecord => ({
  ...record,
  disclosure: record.disclosure
    ? {
        ...record.disclosure,
        purposes: [...record.disclosure.purposes],
        models: record.disclosure.models.map((model) => ({ ...model })),
        headerNames: [...record.disclosure.headerNames],
      }
    : null,
})

/** Mirrors SQLite BINARY and PostgreSQL COLLATE "C" for cursor-bearing fields. */
const bytewise = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))

export type InMemoryProviderPersistence = {
  credentials: CredentialsPersistence
  providerResources: ProviderResourcesPersistence
  providerAttachments: ProviderAttachmentsPersistence
  providerCiphertexts: ProviderCiphertextsPersistence
  offerProviderAttachment: ProviderAttachmentLifecyclePersistence['offerProviderAttachment']
  acceptProviderAttachment: ProviderAttachmentLifecyclePersistence['acceptProviderAttachment']
  detachProviderAttachment: ProviderAttachmentLifecyclePersistence['detachProviderAttachment']
  retargetProviderCredential(input: ProviderRetargetInput): Promise<ProviderRetargetResult>
  coordinator: InMemoryProviderCoordinator
  removeProviderAttachmentsForMemberInsideCoordinator(space: string, username: string): void
  injectProviderResource(record: ProviderResourceRecord): void
  injectProviderAttachment(record: ProviderAttachmentRecord): void
  purgeSpaceInsideCoordinator(space: string): void
  purgeSpace(space: string): Promise<void>
  clear(): void
}

export const createInMemoryProviderPersistence = (options: {
  spaceIsLive: (space: string) => Promise<boolean>
  ownerIsMember?: (space: string, owner: string) => Promise<boolean>
  activeCiphertextKey?: () => CiphertextWrite | null
  retireCiphertextKeys?: (keyIds: ReadonlySet<string>, retiredAt: string) => string[]
  coordinator?: InMemoryProviderCoordinator
}): InMemoryProviderPersistence => {
  const coordinator = options.coordinator ?? new InMemoryProviderCoordinator()
  const credentialRows = new Map<string, CredentialRecord>()
  const resourceRows = new Map<string, ProviderResourceRecord>()
  const attachmentRows = new Map<string, ProviderAttachmentRecord>()

  const transitionAttachments = (resourceIds: readonly string[]) => {
    const affected = new Set(resourceIds)

    for (const [id, attachment] of attachmentRows) {
      if (affected.has(attachment.resourceId) && attachment.state === ATTACHMENT_STATE.active) {
        attachmentRows.set(id, { ...attachment, state: ATTACHMENT_STATE.awaitingReconsent })
      }
    }
  }

  const ownerIsMember = (space: string, owner: string) =>
    owner === '@system' || (options.ownerIsMember?.(space, owner) ?? Promise.resolve(true))

  const assertCiphertext = (values: readonly string[], write: CiphertextWrite | null) => {
    if (!values.length) {
      return
    }
    if (!write || values.some((value) => !value.startsWith(`v1.${write.keyId}.`))) {
      throw providerPersistenceError(
        PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
        'fake provider persistence received plaintext or a foreign ciphertext key',
      )
    }
    const active = options.activeCiphertextKey?.()

    if (active && (active.keyId !== write.keyId || active.generation !== write.generation)) {
      throw providerPersistenceError(
        PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
        'fake provider persistence received ciphertext from a stale key',
      )
    }
  }

  const validateResource = (record: ProviderResourceRecord) => {
    if (!record.credentialId) {
      return
    }
    const credential = credentialRows.get(record.credentialId)

    if (!credential || credential.owner !== record.owner) {
      throw providerPersistenceError(
        PROVIDER_PERSISTENCE_ERROR.credentialNotOwned,
        'provider resource may reference only its owner credential',
      )
    }
    if (credential.origin !== new URL(record.baseUrl).origin) {
      throw providerPersistenceError(
        PROVIDER_PERSISTENCE_ERROR.credentialOriginMismatch,
        'provider resource and credential origins differ',
      )
    }
    const injectionHeader =
      credential.injection.header || DEFAULT_CREDENTIAL_HEADER[credential.kind][record.wire]

    if (Object.hasOwn(record.headers, injectionHeader)) {
      throw providerPersistenceError(
        PROVIDER_PERSISTENCE_ERROR.credentialInjectionCollision,
        'provider header collides with credential injection',
      )
    }
  }

  const credentials: CredentialsPersistence = {
    create: (record, ciphertext) =>
      coordinator.run(() => {
        assertCiphertext([record.secret], ciphertext)
        if (
          [...credentialRows.values()].some(
            (candidate) => candidate.owner === record.owner && candidate.name === record.name,
          )
        ) {
          throw new Error('UNIQUE constraint failed: credentials.owner, credentials.name')
        }
        credentialRows.set(record.id, copyCredential(record))
      }),
    mutate: (input) =>
      coordinator.run(() => {
        const current = credentialRows.get(input.id)

        if (!current) {
          return { status: 'missing' as const }
        }
        if (current.runtimeEpoch !== input.expectedRuntimeEpoch) {
          return { status: 'conflict' as const, record: copyCredential(current) }
        }
        const changesSecret = Object.hasOwn(input.changes, 'secret')

        if (changesSecret) {
          assertCiphertext([input.changes.secret!], input.ciphertext)
        }
        const record: CredentialRecord = {
          ...current,
          ...input.changes,
          secret: changesSecret ? input.changes.secret! : current.secret,
          consentEpoch: current.consentEpoch + (input.consentChanged ? 1 : 0),
          runtimeEpoch: current.runtimeEpoch + (input.runtimeChanged ? 1 : 0),
        }

        if (
          [...credentialRows.values()].some(
            (candidate) =>
              candidate.id !== record.id &&
              candidate.owner === record.owner &&
              candidate.name === record.name,
          )
        ) {
          throw new Error('UNIQUE constraint failed: credentials.owner, credentials.name')
        }
        const references = [...resourceRows.values()]
          .filter((resource) => resource.credentialId === input.id)
          .sort(
            (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
          )
          .map(copyResource)
        const invalidIds = new Set(input.validateReferences(record, references))
        const invalid = references.filter((reference) => invalidIds.has(reference.id))

        if (invalid.length > 0) {
          return { status: 'references-invalid' as const, references: invalid }
        }
        credentialRows.set(record.id, copyCredential(record))
        if (input.runtimeChanged) {
          for (const reference of references) {
            resourceRows.set(reference.id, { ...reference, lastCheck: {} })
          }
        }
        if (input.consentChanged) {
          transitionAttachments(references.map(({ id }) => id))
        }

        return { status: 'updated' as const, record: copyCredential(record) }
      }),
    get: async (id) => {
      const record = credentialRows.get(id)
      return record ? copyCredential(record) : null
    },
    getMany: async (ids) =>
      [...new Set(ids)].flatMap((id) => {
        const record = credentialRows.get(id)
        return record ? [copyCredential(record)] : []
      }),
    pageIdsForOwner: async (owner, input) => {
      const rows = [...credentialRows.values()]
        .filter((record) => record.owner === owner)
        .sort((left, right) => bytewise(left.name, right.name) || bytewise(left.id, right.id))
      const after = input.after
      const page = after
        ? rows.filter(
            (record) =>
              bytewise(record.name, after.sort) > 0 ||
              (record.name === after.sort && bytewise(record.id, after.id) > 0),
          )
        : rows

      return { ids: page.slice(0, input.limit).map(({ id }) => id), total: rows.length }
    },
    list: async () => [...credentialRows.values()].map(copyCredential),
    listForOwner: async (owner) =>
      [...credentialRows.values()]
        .filter((record) => record.owner === owner)
        .sort(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
        )
        .map(copyCredential),
    references: async (id) =>
      [...resourceRows.values()]
        .filter((resource) => resource.credentialId === id)
        .sort(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
        )
        .map(copyResource),
    deleteIfUnreferenced: (id) =>
      coordinator.run(() => {
        if (!credentialRows.has(id)) {
          return { status: 'missing' as const }
        }
        const references = [...resourceRows.values()]
          .filter((resource) => resource.credentialId === id)
          .sort(
            (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
          )
          .map(copyResource)

        if (references.length > 0) {
          return { status: 'referenced' as const, references }
        }
        credentialRows.delete(id)
        return { status: 'deleted' as const }
      }),
  }

  const providerResources: ProviderResourcesPersistence = {
    create: (record, ciphertext) =>
      coordinator.run(() => {
        assertCiphertext(Object.values(record.headers), ciphertext)
        validateResource(record)
        if (
          [...resourceRows.values()].some(
            (candidate) => candidate.owner === record.owner && candidate.name === record.name,
          )
        ) {
          throw new Error(
            'UNIQUE constraint failed: provider_resources.owner, provider_resources.name',
          )
        }
        resourceRows.set(record.id, copyResource(record))
      }),
    replaceIfRuntimeEpoch: (
      record,
      ciphertext,
      expectedRuntimeEpoch,
      expectedCredentialId,
      preserveModels = false,
    ) =>
      coordinator.run(() => {
        assertCiphertext(Object.values(record.headers), ciphertext)
        validateResource(record)
        const current = resourceRows.get(record.id)

        if (!current) {
          return { status: 'missing' as const }
        }
        if (
          current.runtimeEpoch !== expectedRuntimeEpoch ||
          current.credentialId !== expectedCredentialId
        ) {
          return { status: 'conflict' as const, record: copyResource(current) }
        }
        const stored = copyResource({
          ...record,
          models: preserveModels ? current.models : record.models,
          lastCheck:
            record.runtimeEpoch === expectedRuntimeEpoch ? current.lastCheck : record.lastCheck,
        })
        resourceRows.set(record.id, stored)
        if (stored.consentEpoch !== current.consentEpoch) {
          transitionAttachments([record.id])
        }

        return { status: 'replaced' as const, record: copyResource(stored) }
      }),
    get: async (id) => {
      const record = resourceRows.get(id)
      return record ? copyResource(record) : null
    },
    getMany: async (ids) =>
      [...new Set(ids)].flatMap((id) => {
        const record = resourceRows.get(id)
        return record ? [copyResource(record)] : []
      }),
    pageIdsForOwner: async (owner, input) => {
      const rows = [...resourceRows.values()]
        .filter((record) => record.owner === owner)
        .sort((left, right) => bytewise(left.name, right.name) || bytewise(left.id, right.id))
      const after = input.after
      const page = after
        ? rows.filter(
            (record) =>
              bytewise(record.name, after.sort) > 0 ||
              (record.name === after.sort && bytewise(record.id, after.id) > 0),
          )
        : rows

      return { ids: page.slice(0, input.limit).map(({ id }) => id), total: rows.length }
    },
    pageEffectiveIds: async (owner, spaces, input) => {
      const targets = new Set(spaces)
      const attached = new Set(
        [...attachmentRows.values()]
          .filter(
            (attachment) =>
              targets.has(attachment.targetSpace) &&
              (attachment.state === ATTACHMENT_STATE.active ||
                attachment.state === ATTACHMENT_STATE.awaitingReconsent),
          )
          .map(({ resourceId }) => resourceId),
      )
      const rows = [...resourceRows.values()]
        .filter((record) => record.owner === owner || attached.has(record.id))
        .sort((left, right) => bytewise(left.name, right.name) || bytewise(left.id, right.id))
      const after = input.after
      const page = after
        ? rows.filter(
            (record) =>
              bytewise(record.name, after.sort) > 0 ||
              (record.name === after.sort && bytewise(record.id, after.id) > 0),
          )
        : rows

      return { ids: page.slice(0, input.limit).map(({ id }) => id), total: rows.length }
    },
    scanEffectivePage: async (owner, spaces, input) => {
      const targets = new Set(spaces)
      const attached = new Set(
        [...attachmentRows.values()]
          .filter(
            (attachment) =>
              targets.has(attachment.targetSpace) &&
              (attachment.state === ATTACHMENT_STATE.active ||
                attachment.state === ATTACHMENT_STATE.awaitingReconsent),
          )
          .map(({ resourceId }) => resourceId),
      )
      const rows = [...resourceRows.values()]
        .filter((record) => record.owner === owner || attached.has(record.id))
        .sort((left, right) => bytewise(left.name, right.name) || bytewise(left.id, right.id))
      const after = input.after
      const candidates = after
        ? rows.filter(
            (record) =>
              bytewise(record.name, after.sort) > 0 ||
              (record.name === after.sort && bytewise(record.id, after.id) > 0),
          )
        : rows
      const positions = candidates.slice(0, input.limit + 1).map(({ id, name }) => ({
        sort: name,
        id,
      }))

      return {
        positions: positions.slice(0, input.limit),
        hasMore: positions.length > input.limit,
      }
    },
    list: async () => [...resourceRows.values()].map(copyResource),
    listForOwner: async (owner) =>
      [...resourceRows.values()]
        .filter((record) => record.owner === owner)
        .sort(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
        )
        .map(copyResource),
    delete: (id) =>
      coordinator.run(() => {
        resourceRows.delete(id)
        for (const [attachmentId, attachment] of attachmentRows) {
          if (attachment.resourceId === id) {
            attachmentRows.delete(attachmentId)
          }
        }
      }),
    materializeModel: (id, model) =>
      coordinator.run(() => {
        const record = resourceRows.get(id)

        if (!record) {
          return null
        }
        const updated = { ...record, models: mergedProviderModels(record.models, model) }
        resourceRows.set(id, updated)
        return copyResource(updated)
      }),
    recordLastCheck: (input) =>
      coordinator.run(() => {
        const record = resourceRows.get(input.resourceId)

        if (!record) {
          return { status: 'missing' as const }
        }
        const credential = input.expectedCredentialId
          ? credentialRows.get(input.expectedCredentialId)
          : undefined

        if (
          record.runtimeEpoch !== input.expectedRuntimeEpoch ||
          record.credentialId !== input.expectedCredentialId ||
          (credential?.runtimeEpoch ?? null) !== input.expectedCredentialRuntimeEpoch
        ) {
          return { status: 'stale' as const, record: copyResource(record) }
        }
        const updated = {
          ...record,
          lastCheck: { ...record.lastCheck, [input.purpose]: input.lastCheck },
          models: input.model ? mergedProviderModels(record.models, input.model) : record.models,
        }
        resourceRows.set(input.resourceId, copyResource(updated))
        return { status: 'recorded' as const, record: copyResource(updated) }
      }),
  }

  const providerAttachments: ProviderAttachmentsPersistence = {
    get: async (id) => {
      const record = attachmentRows.get(id)
      return record ? copyAttachment(record) : null
    },
    getMany: async (ids) =>
      [...new Set(ids)].flatMap((id) => {
        const record = attachmentRows.get(id)
        return record ? [copyAttachment(record)] : []
      }),
    listForResource: async (resourceId) =>
      [...attachmentRows.values()]
        .filter((record) => record.resourceId === resourceId)
        .map(copyAttachment),
    listForSpace: async (targetSpace) =>
      [...attachmentRows.values()]
        .filter((record) => record.targetSpace === targetSpace)
        .map(copyAttachment),
    listForSpaces: async (targetSpaces) => {
      const allowed = new Set(targetSpaces)
      return [...attachmentRows.values()]
        .filter((record) => allowed.has(record.targetSpace))
        .map(copyAttachment)
    },
    listForResourcesInSpaces: async (resourceIds, targetSpaces) => {
      const resources = new Set(resourceIds)
      const spaces = new Set(targetSpaces)
      return [...attachmentRows.values()]
        .filter((record) => resources.has(record.resourceId) && spaces.has(record.targetSpace))
        .map(copyAttachment)
    },
    pageIdsForSpace: async (targetSpace, pendingAfter, input) => {
      const rows = [...attachmentRows.values()]
        .filter(
          (record) =>
            record.targetSpace === targetSpace &&
            (record.state !== ATTACHMENT_STATE.pending || record.expiresAt > pendingAfter),
        )
        .sort(
          (left, right) => bytewise(left.createdAt, right.createdAt) || bytewise(left.id, right.id),
        )
      const after = input.after
      const page = after
        ? rows.filter(
            (record) =>
              bytewise(record.createdAt, after.sort) > 0 ||
              (record.createdAt === after.sort && bytewise(record.id, after.id) > 0),
          )
        : rows

      return { ids: page.slice(0, input.limit).map(({ id }) => id), total: rows.length }
    },
  }

  const transitionState = (record: ProviderAttachmentRecord) => {
    const resource = resourceRows.get(record.resourceId)

    if (!resource) {
      return null
    }
    const credential = resource.credentialId
      ? (credentialRows.get(resource.credentialId) ?? null)
      : null

    return {
      record: copyAttachment(record),
      resource: copyResource(resource),
      credential: credential ? copyCredential(credential) : null,
    }
  }

  const offerProviderAttachment: ProviderAttachmentLifecyclePersistence['offerProviderAttachment'] =
    (record) =>
      coordinator.run(async () => {
        if (!(await options.spaceIsLive(record.targetSpace))) {
          return { status: 'target-gone' }
        }
        const resource = resourceRows.get(record.resourceId)

        if (!resource) {
          return { status: 'missing-resource' }
        }
        if (!(await ownerIsMember(record.targetSpace, resource.owner))) {
          return { status: 'owner-not-member' }
        }
        const existing = [...attachmentRows.values()].find(
          (candidate) =>
            candidate.resourceId === record.resourceId &&
            candidate.targetKind === record.targetKind &&
            candidate.targetId === record.targetId,
        )

        if (existing && existing.state !== ATTACHMENT_STATE.pending) {
          return { status: 'already-attached', ...transitionState(existing)! }
        }
        const stored = existing
          ? {
              ...existing,
              targetSpace: record.targetSpace,
              createdAt: record.createdAt,
              expiresAt: record.expiresAt,
            }
          : copyAttachment(record)
        attachmentRows.set(stored.id, stored)
        return { status: 'offered', ...transitionState(stored)! }
      })

  const acceptProviderAttachment: ProviderAttachmentLifecyclePersistence['acceptProviderAttachment'] =
    (input, disclosureOf) =>
      coordinator.run(async () => {
        const record = attachmentRows.get(input.id)

        if (!record) {
          return { status: 'missing' }
        }
        if (!(await options.spaceIsLive(record.targetSpace))) {
          return { status: 'target-gone' }
        }
        const state = transitionState(record)

        if (!state) {
          return { status: 'missing' }
        }
        if (!(await ownerIsMember(record.targetSpace, state.resource.owner))) {
          return { status: 'owner-not-member' }
        }
        if (input.manager !== null && !(await ownerIsMember(record.targetSpace, input.manager))) {
          return { status: 'owner-not-member' }
        }
        const credentialEpoch = state.credential?.consentEpoch ?? null
        const currentPair =
          record.resourceEpoch === state.resource.consentEpoch &&
          record.credentialEpoch === credentialEpoch

        if (record.state === ATTACHMENT_STATE.active) {
          if (currentPair) {
            return { status: 'already-active', ...state }
          }
          const changed = { ...record, state: ATTACHMENT_STATE.awaitingReconsent }
          attachmentRows.set(record.id, changed)
          return { status: 'epoch-conflict', ...transitionState(changed)! }
        }
        if (record.state === ATTACHMENT_STATE.pending && record.expiresAt <= input.acceptedAt) {
          return { status: 'expired', ...state }
        }
        if (
          input.expectedResourceEpoch !== state.resource.consentEpoch ||
          input.expectedCredentialEpoch !== credentialEpoch
        ) {
          return { status: 'epoch-conflict', ...state }
        }
        const accepted = {
          ...record,
          state: ATTACHMENT_STATE.active,
          resourceEpoch: state.resource.consentEpoch,
          credentialEpoch,
          disclosure: disclosureOf(state.resource, state.credential, record.targetSpace),
        }
        attachmentRows.set(record.id, accepted)
        return { status: 'accepted', ...transitionState(accepted)! }
      })

  const detachProviderAttachment: ProviderAttachmentLifecyclePersistence['detachProviderAttachment'] =
    (input) =>
      coordinator.run(async () => {
        const record = attachmentRows.get(input.id)

        if (!record) {
          return { status: 'missing' }
        }
        if (!(await options.spaceIsLive(record.targetSpace))) {
          return { status: 'target-gone' }
        }
        if (input.manager !== null && !(await ownerIsMember(record.targetSpace, input.manager))) {
          return { status: 'manager-not-member' }
        }
        attachmentRows.delete(input.id)
        return { status: 'detached', targetSpace: record.targetSpace }
      })

  const retargetProviderCredential = (input: ProviderRetargetInput) =>
    coordinator.run((): ProviderRetargetResult => {
      const credential = credentialRows.get(input.credentialId)

      if (!credential || credential.owner !== input.owner) {
        return { status: 'missing' }
      }
      if (credential.runtimeEpoch !== input.expectedCredentialRuntimeEpoch) {
        return { status: 'conflict' }
      }
      const references = [...resourceRows.values()]
        .filter(({ credentialId }) => credentialId === input.credentialId)
        .sort((left, right) => left.id.localeCompare(right.id))
      const requested = new Map(input.resources.map((resource) => [resource.id, resource]))

      if (requested.size !== references.length || references.some(({ id }) => !requested.has(id))) {
        return { status: 'references-changed' }
      }
      for (const current of references) {
        const next = requested.get(current.id)!

        if (current.owner !== input.owner || current.runtimeEpoch !== next.expectedRuntimeEpoch) {
          return { status: 'conflict' }
        }
        const injectionHeader =
          credential.injection.header || DEFAULT_CREDENTIAL_HEADER[credential.kind][current.wire]
        const credentialConditionalFailure =
          new URL(next.baseUrl).origin !== input.origin ||
          Object.hasOwn(current.headers, injectionHeader)

        if (next.detachCredential !== credentialConditionalFailure) {
          return { status: 'conflict' }
        }
      }
      credentialRows.set(input.credentialId, {
        ...credential,
        origin: input.origin,
        consentEpoch: credential.consentEpoch + 1,
        runtimeEpoch: credential.runtimeEpoch + 1,
      })
      for (const current of references) {
        const next = requested.get(current.id)!
        resourceRows.set(current.id, {
          ...current,
          baseUrl: next.baseUrl,
          credentialId: next.detachCredential ? null : input.credentialId,
          consentEpoch: current.consentEpoch + 1,
          runtimeEpoch: current.runtimeEpoch + 1,
          lastCheck: {},
        })
      }
      transitionAttachments(references.map(({ id }) => id))
      return {
        status: 'retargeted',
        credential: copyCredential(credentialRows.get(input.credentialId)!),
        resources: references.map(({ id }) => copyResource(resourceRows.get(id)!)),
      }
    })

  const removeProviderAttachmentsForMemberInsideCoordinator = (
    space: string,
    username: string,
  ): void => {
    const owned = new Set(
      [...resourceRows.values()].filter(({ owner }) => owner === username).map(({ id }) => id),
    )

    for (const [id, attachment] of attachmentRows) {
      if (attachment.targetSpace === space && owned.has(attachment.resourceId)) {
        attachmentRows.delete(id)
      }
    }
  }

  const purgeSpaceInsideCoordinator = (space: string): void => {
    for (const [id, attachment] of attachmentRows) {
      if (attachment.targetSpace === space) {
        attachmentRows.delete(id)
      }
    }
  }

  const providerCiphertexts: ProviderCiphertextsPersistence = {
    hasCiphertext: () =>
      coordinator.run(
        () =>
          credentialRows.size > 0 ||
          [...resourceRows.values()].some((resource) => Object.keys(resource.headers).length > 0),
      ),
    previewUnreadable: (readableKeyIds) =>
      coordinator.run(() =>
        providerUnreadablePlan(
          [...credentialRows.values()],
          [...resourceRows.values()],
          readableKeyIds,
        ),
      ),
    purgeUnreadable: (readableKeyIds, changedAt) =>
      coordinator.run(() => {
        const credentialRecords = [...credentialRows.values()]
        const resources = [...resourceRows.values()]
        const plan = providerUnreadablePlan(credentialRecords, resources, readableKeyIds)
        const badCredentials = new Set(
          plan.affected
            .filter((impact) => impact.kind === 'credential')
            .map((impact) => impact.recordId),
        )
        const badHeaders = new Set(
          plan.affected
            .filter((impact) => impact.kind === 'header')
            .map((impact) => impact.recordId),
        )

        for (const resource of resources) {
          if (!badHeaders.has(resource.id) && !badCredentials.has(resource.credentialId ?? '')) {
            continue
          }
          resourceRows.set(resource.id, {
            ...resource,
            headers: readableProviderHeaders(resource, readableKeyIds),
            credentialId: badCredentials.has(resource.credentialId ?? '')
              ? null
              : resource.credentialId,
            disabledAt: changedAt,
            runtimeEpoch: resource.runtimeEpoch + 1,
            lastCheck: {},
          })
        }
        for (const id of badCredentials) {
          credentialRows.delete(id)
        }

        return plan
      }),
    countReferences: (keyIds) =>
      coordinator.run(() =>
        providerCiphertextCounts([...credentialRows.values()], [...resourceRows.values()], keyIds),
      ),
    rewrapBatch: ({ active, sourceKeyIds, limit, rewrap }) =>
      coordinator.run(async () => {
        const current = options.activeCiphertextKey?.()

        if (
          current &&
          (current.keyId !== active.keyId || current.generation !== active.generation)
        ) {
          throw providerPersistenceError(
            PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
            'credential key changed during provider ciphertext maintenance',
          )
        }
        const credentialInventory = [...credentialRows.values()].sort((left, right) =>
          left.id.localeCompare(right.id),
        )
        const resources = [...resourceRows.values()].sort((left, right) =>
          left.id.localeCompare(right.id),
        )
        const carriers = providerCiphertextBatch(
          credentialInventory,
          resources,
          sourceKeyIds,
          limit,
        )
        const rewrapped = { credentials: 0, headers: 0 }

        for (const carrier of carriers) {
          const ciphertext = await rewrap(carrier)

          if (providerCiphertextKeyId(ciphertext) !== active.keyId) {
            throw providerPersistenceError(
              PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
              'rewrapped provider ciphertext does not use the active credential key',
            )
          }
          if (carrier.kind === 'credential') {
            const credential = credentialRows.get(carrier.recordId)!
            credentialRows.set(carrier.recordId, { ...credential, secret: ciphertext })
            rewrapped.credentials += 1
            continue
          }
          const resource = resourceRows.get(carrier.recordId)!
          resourceRows.set(carrier.recordId, {
            ...resource,
            headers: { ...resource.headers, [carrier.field]: ciphertext },
          })
          rewrapped.headers += 1
        }

        return { rewrapped }
      }),
    retireKeys: ({ active, sourceKeyIds, retiredAt }) =>
      coordinator.run(() => {
        const current = options.activeCiphertextKey?.()

        if (
          current &&
          (current.keyId !== active.keyId || current.generation !== active.generation)
        ) {
          throw providerPersistenceError(
            PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey,
            'credential key changed during provider ciphertext maintenance',
          )
        }
        const references = providerCiphertextCounts(
          [...credentialRows.values()],
          [...resourceRows.values()],
          sourceKeyIds,
        )

        if (references.credentials > 0 || references.headers > 0) {
          return { status: 'references-remain' as const, references }
        }

        return {
          status: 'retired' as const,
          references,
          retiredKeyIds: options.retireCiphertextKeys?.(sourceKeyIds, retiredAt) ?? [],
        }
      }),
  }

  return {
    credentials,
    providerResources,
    providerAttachments,
    providerCiphertexts,
    offerProviderAttachment,
    acceptProviderAttachment,
    detachProviderAttachment,
    retargetProviderCredential,
    coordinator,
    removeProviderAttachmentsForMemberInsideCoordinator,
    injectProviderResource: (record) => void resourceRows.set(record.id, copyResource(record)),
    injectProviderAttachment: (record) =>
      void attachmentRows.set(record.id, copyAttachment(record)),
    purgeSpaceInsideCoordinator,
    purgeSpace: (space) => coordinator.run(() => purgeSpaceInsideCoordinator(space)),
    clear: () => {
      credentialRows.clear()
      resourceRows.clear()
      attachmentRows.clear()
    },
  }
}
