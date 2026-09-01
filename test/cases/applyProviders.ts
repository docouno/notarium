import type {
  ProviderAttachmentAcceptRequest,
  ProviderResourceCreateRequest,
} from '@notarium/contract'
import type {
  ProviderAttachmentRecord,
  ProviderRegistry,
  ProviderResourceRecord,
} from '@notarium/server'

import type { ProviderSeedDecl } from './types'

const UNREADABLE_HEADER_CIPHERTEXT = 'v1.ck_000000000000000000000000.AA'

export type ApplyProviderSeedOptions = {
  declaration: ProviderSeedDecl
  registry: ProviderRegistry
  ownerOf?: (owner: string) => string
  resolveSpace: (slug: string) => string | null
  resolveProject: (space: string, path: string) => Promise<{ id: string; space: string } | null>
  /** Seed-only escape hatch for states every product persistence write rejects. */
  overrideResource: (record: ProviderResourceRecord) => void | Promise<void>
  recordMeasurement: (input: {
    resourceId: string
    modelName: string
    capability: 'completion' | 'embedding'
    status?: 'available' | 'model-unavailable'
    dimensions?: number
  }) => void | Promise<void>
  /** Seed-only escape hatch for a pending offer close to expiry. */
  overrideAttachment: (record: ProviderAttachmentRecord) => void | Promise<void>
}

export type AppliedProviderSeed = {
  credentials: ReadonlyMap<string, string>
  resources: ReadonlyMap<string, string>
  attachments: ReadonlyMap<string, string>
}

const required = <T>(value: T | null | undefined, message: string): T => {
  if (value == null) {
    throw new Error(message)
  }

  return value
}

/** Apply one neutral provider world through the production registry. Only the
 * explicitly impossible/corrupt states cross the two callbacks above. */
export const applyProviderSeed = async (
  options: ApplyProviderSeedOptions,
): Promise<AppliedProviderSeed> => {
  const ownerOf = options.ownerOf ?? ((owner: string) => owner)
  const credentialIds = new Map<string, string>()
  const resourceIds = new Map<string, string>()
  const attachmentIds = new Map<string, string>()

  for (const declaration of options.declaration.credentials) {
    if (credentialIds.has(declaration.ref)) {
      throw new Error(`duplicate provider credential seed ref: ${declaration.ref}`)
    }
    const owner = ownerOf(declaration.owner)
    const credential = await options.registry.createCredential(owner, {
      name: declaration.name,
      kind: declaration.kind,
      secret: declaration.secret,
      origin: declaration.origin,
      injection: declaration.injection ?? { header: '', prefix: '' },
      rpm: declaration.rpm ?? null,
      tpm: declaration.tpm ?? null,
    })

    if (declaration.disabled) {
      await options.registry.updateCredential(owner, credential.id, { disabled: true })
    }
    credentialIds.set(declaration.ref, credential.id)
  }

  for (const declaration of options.declaration.resources) {
    if (resourceIds.has(declaration.ref)) {
      throw new Error(`duplicate provider resource seed ref: ${declaration.ref}`)
    }
    const owner = ownerOf(declaration.owner)
    const credentialId = declaration.credential
      ? required(
          credentialIds.get(declaration.credential),
          `provider resource ${declaration.ref} references unknown credential ${declaration.credential}`,
        )
      : null
    const input: ProviderResourceCreateRequest = {
      name: declaration.name,
      wire: declaration.wire,
      baseUrl: declaration.baseUrl,
      headers: declaration.headers ?? {},
      allowPrivateNetwork: declaration.allowPrivateNetwork ?? false,
      models: declaration.models ?? [],
      defaultModel: declaration.defaultModel ?? null,
      credentialId,
      firstByteTimeoutMs: declaration.firstByteTimeoutMs ?? null,
      callTimeoutMs: declaration.callTimeoutMs ?? null,
    }
    const created = await options.registry.createResource(owner, input)

    for (const measurement of declaration.measurements ?? []) {
      await options.recordMeasurement({ resourceId: created.resource.id, ...measurement })
    }

    if (declaration.disabled) {
      await options.registry.updateResource(owner, created.resource.id, { disabled: true })
    }
    resourceIds.set(declaration.ref, created.resource.id)

    if (declaration.mismatchedBaseUrl || declaration.unreadableHeaders) {
      const current = required(
        await options.registry.getResource(created.resource.id),
        `seeded provider resource disappeared: ${declaration.ref}`,
      )
      const headers = declaration.unreadableHeaders
        ? Object.fromEntries(
            Object.keys(current.headers).map((name) => [name, UNREADABLE_HEADER_CIPHERTEXT]),
          )
        : current.headers

      if (declaration.unreadableHeaders && Object.keys(headers).length === 0) {
        throw new Error(`unreadable provider resource ${declaration.ref} has no headers`)
      }
      await options.overrideResource({
        ...current,
        baseUrl: declaration.mismatchedBaseUrl ?? current.baseUrl,
        headers,
      })
    }
  }

  for (const declaration of options.declaration.attachments) {
    if (attachmentIds.has(declaration.ref)) {
      throw new Error(`duplicate provider attachment seed ref: ${declaration.ref}`)
    }
    const resourceId = required(
      resourceIds.get(declaration.resource),
      `provider attachment ${declaration.ref} references unknown resource ${declaration.resource}`,
    )
    const resource = required(
      await options.registry.getResource(resourceId),
      `provider attachment resource disappeared: ${declaration.resource}`,
    )
    let target: { kind: 'space' | 'project'; id: string }

    if (declaration.target.kind === 'space') {
      target = {
        kind: 'space',
        id: required(
          options.resolveSpace(declaration.target.space),
          `provider attachment ${declaration.ref} references unknown Space ${declaration.target.space}`,
        ),
      }
    } else {
      const project = required(
        await options.resolveProject(declaration.target.space, declaration.target.path),
        `provider attachment ${declaration.ref} references unknown Project ${declaration.target.space}/${declaration.target.path}`,
      )
      target = { kind: 'project', id: project.id }
    }
    const offered = await options.registry.offerAttachment({
      owner: resource.owner,
      resourceId,
      targetKind: target.kind,
      targetId: target.id,
    })

    if (offered.status !== 'offered') {
      throw new Error(`provider attachment ${declaration.ref} could not be offered`)
    }
    const attachmentId = offered.view.attachment.id
    attachmentIds.set(declaration.ref, attachmentId)

    if (declaration.state !== 'pending') {
      const expected: ProviderAttachmentAcceptRequest = offered.view.currentEpochs
      const accepted = await options.registry.acceptAttachment(
        attachmentId,
        expected,
        ownerOf(declaration.manager),
        ownerOf(declaration.manager),
      )

      if (accepted.status !== 'accepted') {
        throw new Error(`provider attachment ${declaration.ref} could not be accepted`)
      }
      if (declaration.state === 'awaiting-reconsent') {
        const baseUrl = required(
          declaration.reconsentBaseUrl,
          `provider attachment ${declaration.ref} needs reconsentBaseUrl`,
        )
        const changed = await options.registry.updateResource(resource.owner, resourceId, {
          baseUrl,
        })

        if (!changed) {
          throw new Error(`provider attachment ${declaration.ref} resource could not be changed`)
        }
      }
    } else if (declaration.expiresInMs !== undefined) {
      const record = required(
        await options.registry.getAttachment(attachmentId),
        `seeded provider attachment disappeared: ${declaration.ref}`,
      )
      const now = new Date(record.createdAt).getTime()
      await options.overrideAttachment({
        ...record,
        expiresAt: new Date(now + declaration.expiresInMs).toISOString(),
      })
    }
  }

  return { credentials: credentialIds, resources: resourceIds, attachments: attachmentIds }
}
