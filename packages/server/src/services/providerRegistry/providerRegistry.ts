import { createHash } from 'node:crypto'
import {
  AUTH_MODE,
  type AuthMode,
  type Author,
  AUTHOR_KIND,
  carriesWholeSecret,
  type Credential,
  type CredentialCreateRequest,
  type CredentialInjection,
  type CredentialListItem,
  type CredentialPatchRequest,
  type CredentialReference,
  type CredentialResponse,
  DEFAULT_CREDENTIAL_HEADER,
  looksLikeSecret,
  MODEL_CAPABILITY,
  MODEL_STATUS,
  type ModelCapability,
  PROVIDER_CALL_ERROR,
  PROVIDER_DELIVERY_STATE,
  PROVIDER_STATUS,
  PROVIDER_TIMEOUT,
  type ProviderAttachmentAcceptRequest,
  type ProviderAttachmentListItem,
  type ProviderAttachmentView,
  type ProviderModel,
  type ProviderModelWrite,
  ProviderModelWriteSchema,
  type ProviderResource,
  type ProviderResourceCreateRequest,
  type ProviderResourceHeaderPatch,
  type ProviderResourceListItem,
  type ProviderResourcePatchRequest,
  type ProviderRetargetConflictReference,
  type ProviderRetargetRequest,
  type ProviderRetargetResponse,
  type ProviderStatus,
  type ProviderValidateResponse,
  providerVendorOf,
} from '@notarium/contract'
import { freshNoteId } from '@notarium/core'

import type { MutationGate } from '../../libs/mutationGate'
import { ADDRESS_CLASS, canonicalOriginOf, literalAddressClassOf } from '../../libs/originPolicy'
import { AGENT_SYSTEM_OWNER } from '../authz'
import {
  canonicalHeaderName,
  type CredentialKeyringService,
  SECRET_FACET,
  type SecretAad,
} from '../credentialKeyring'
import type {
  CredentialMutableFields,
  CredentialRecord,
  CredentialsPersistence,
  MetaDb,
  ProjectsPersistence,
  ProviderAttachmentsPersistence,
  ProviderPagePosition,
  ProviderResourceRecord,
  ProviderResourcesPersistence,
  SpacesPersistence,
} from '../metaDb'
import { PROVIDER_PERSISTENCE_ERROR } from '../metaDb'
import {
  PROVIDER_CALL_KIND,
  ProviderCallError,
  type ProviderCallResult,
  type ProviderJobCall,
  type ProviderOperation,
  type ProviderRetryMode,
  type ProviderRuntime,
  type ProviderTextChunk,
  type ProviderValidateOutcome,
} from '../providerRuntime'
import { ProviderAttachmentsService } from './attachments'
import {
  type CredentialConsumer,
  credentialReferencesOf,
  providerResourceCredentialConsumer,
} from './credentialConsumer'
import {
  hasUsableForPrincipal,
  type ProviderPrincipalDirectory,
  type ProviderResolutionEntry,
  type ProviderResolutionPorts,
  resolveForPrincipalPage,
  resolveForScope,
  resolveOneForPrincipal,
  resolveOwnedMany,
} from './resolution'
import { projectProviderLastCheck } from './validate'

// eslint-disable-next-line no-control-regex -- provider metadata is a single-line HTTP input
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u
const DENIED_HEADER = new Set([
  'host',
  'connection',
  'transfer-encoding',
  'content-length',
  'range',
  'cookie',
  'upgrade',
  'te',
  'trailer',
])

const fails = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'PROVIDER_VALIDATION' })
}

const MODEL_CAPABILITY_ORDER: Readonly<Record<ModelCapability, number>> = {
  [MODEL_CAPABILITY.completion]: 0,
  [MODEL_CAPABILITY.embedding]: 1,
}

const canonicalProviderModelWrites = (
  models: readonly ProviderModelWrite[],
): ProviderModelWrite[] => {
  const parsed = models.map((model) => {
    const result = ProviderModelWriteSchema.safeParse(model)

    if (!result.success) {
      return fails(result.error.issues[0]?.message ?? 'invalid provider model')
    }

    return {
      name: result.data.name,
      capabilities: [...result.data.capabilities].sort(
        (left, right) => MODEL_CAPABILITY_ORDER[left] - MODEL_CAPABILITY_ORDER[right],
      ),
    }
  })

  if (new Set(parsed.map(({ name }) => name)).size !== parsed.length) {
    fails('provider model names must be unique')
  }

  return parsed
}

const authoredProviderModels = (models: readonly ProviderModel[]): ProviderModelWrite[] =>
  canonicalProviderModelWrites(models.map(({ name, capabilities }) => ({ name, capabilities })))

const freshProviderModels = (models: readonly ProviderModelWrite[]): ProviderModel[] =>
  models.map((model) => ({
    ...model,
    capabilities: [...model.capabilities],
    dimensions: null,
    statusByCapability: Object.fromEntries(
      model.capabilities.map((capability) => [capability, MODEL_STATUS.available]),
    ),
  }))

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const canonicalBaseUrl = (raw: string): { baseUrl: string; origin: string } => {
  if (CONTROL.test(raw)) {
    return fails('provider baseUrl contains control characters')
  }
  let url: URL

  try {
    url = new URL(raw)
  } catch {
    return fails('provider baseUrl is not a valid URL')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return fails('provider baseUrl must be HTTP(S) without credentials, query, or fragment')
  }
  const origin = canonicalOriginOf(url.origin)
  url.protocol = new URL(origin).protocol
  url.hostname = new URL(origin).hostname
  url.port = new URL(origin).port
  return { baseUrl: url.toString().replace(/\/$/, ''), origin }
}

const providerHeaderName = (rawName: string): string => {
  let name = ''

  try {
    name = canonicalHeaderName(rawName)
  } catch {
    fails(`provider header ${rawName} is not an RFC token`)
  }
  if (DENIED_HEADER.has(name) || name.startsWith('proxy-')) {
    fails(`provider header ${name} is controlled by the transport`)
  }

  return name
}

const headerInput = (headers: Readonly<Record<string, string>>) => {
  const canonical: Record<string, string> = {}
  const warnings = new Set<string>()

  for (const [rawName, value] of Object.entries(headers)) {
    const name = providerHeaderName(rawName)

    if (Object.hasOwn(canonical, name)) {
      fails(`provider header ${name} is duplicated after canonicalization`)
    }
    if (CONTROL.test(value)) {
      fails(`provider header ${name} contains control characters`)
    }
    canonical[name] = value
    if (looksLikeSecret(value)) {
      warnings.add('possible-secret')
    }
  }

  return { headers: canonical, warnings: [...warnings] }
}

const applyHeaderPatch = (
  current: Readonly<Record<string, string>>,
  patch: ProviderResourceHeaderPatch,
): Record<string, string> => {
  const canonicalPatch: Record<string, string | null> = {}

  for (const [rawName, value] of Object.entries(patch)) {
    const name = providerHeaderName(rawName)

    if (Object.hasOwn(canonicalPatch, name)) {
      fails(`provider header ${name} is duplicated after canonicalization`)
    }
    if (value != null && CONTROL.test(value)) {
      fails(`provider header ${name} contains control characters`)
    }
    canonicalPatch[name] = value
  }

  const next = { ...current }

  for (const [name, value] of Object.entries(canonicalPatch)) {
    if (value == null) {
      delete next[name]
    } else {
      next[name] = value
    }
  }

  return next
}

const canonicalInjection = (injection: CredentialInjection): CredentialInjection => {
  let header = ''

  try {
    header = injection.header ? canonicalHeaderName(injection.header) : ''
  } catch {
    fails('credential injection header is not an RFC token')
  }

  return { header, prefix: injection.prefix }
}

const canonicalCredentialOrigin = (raw: string): string => {
  try {
    return canonicalOriginOf(raw)
  } catch {
    return fails('credential origin must be an exact HTTP(S) origin')
  }
}

const referenced = (message: string, references: CredentialReference[]): never => {
  throw Object.assign(new Error(message), {
    code: 'PROVIDER_CREDENTIAL_REFERENCED',
    references,
  })
}

export const providerEmbedderId = (input: {
  baseUrl: string
  model: string
  dimensions: number
}): string =>
  createHash('sha256')
    .update(`${new URL(input.baseUrl).origin}\0${input.model}\0${input.dimensions}`)
    .digest('hex')

type ProviderProbeOutcome = ProviderValidateOutcome & { model: string | null }

export type ProviderScopeCallInput = {
  space: string
  principal: string
  agent: string | null
  resourceId: string
  operation: ProviderOperation
  retryMode: ProviderRetryMode
  job: ProviderJobCall | null
  rateLimit: {
    inputUpperBound: number
    outputTokenBudget: number
  }
  signal: AbortSignal
  onText?: (chunk: ProviderTextChunk) => void | Promise<void>
}

/** Who is reading a resource row. Both fields default to the least privilege the
 *  seam can assume, so a caller that forgets one gets the coarse projection —
 *  the one that names what the resource serves and never where it points. */
export type ProviderResourceViewer = {
  /** `agentOwnerOf(principal)`. */
  owner?: string | null
  /** Host-wide administrator. May inspect owner diagnostics. */
  admin?: boolean
  /** Space manager deciding consent. May inspect the exact addressee, but not
   *  provider prose about the resource owner's account. */
  consentManager?: boolean
}

export type ProviderRegistryOptions = {
  credentials: CredentialsPersistence
  resources: ProviderResourcesPersistence
  attachments: ProviderAttachmentsPersistence
  attachmentLifecycle: Pick<
    MetaDb,
    | 'offerProviderAttachment'
    | 'acceptProviderAttachment'
    | 'detachProviderAttachment'
    | 'retargetProviderCredential'
  >
  /** Archive is derived on read, never cascaded into rows — restoring a Space brings
   *  its resources back without a second acceptance. */
  spaces: Pick<SpacesPersistence, 'getById' | 'getMany'>
  projects: Pick<ProjectsPersistence, 'getById'>
  /** Deactivation is derived the same way, and for the same reason. */
  directory: ProviderPrincipalDirectory
  keyring: CredentialKeyringService
  privateOrigins: ReadonlySet<string>
  /** Absent ⇒ the host cannot make provider calls; `validate` degrades to 404. */
  runtime?: ProviderRuntime
  mutationGate?: Pick<MutationGate, 'run'>
  /** Fail-closed default: coarsening applies unless the host says it is authless. */
  authMode?: AuthMode
  now?: () => Date
}

export class ProviderRegistry {
  private readonly credentials: CredentialsPersistence
  private readonly resources: ProviderResourcesPersistence
  private readonly resolution: ProviderResolutionPorts
  private readonly attachmentLifecycle: ProviderRegistryOptions['attachmentLifecycle']
  private readonly attachmentService: ProviderAttachmentsService
  private readonly credentialConsumer: CredentialConsumer
  private readonly keyring: CredentialKeyringService
  private readonly privateOrigins: ReadonlySet<string>
  private readonly runtime?: ProviderRuntime
  private readonly mutationGate?: Pick<MutationGate, 'run'>
  private readonly authMode: AuthMode
  private readonly now: () => Date

  constructor(options: ProviderRegistryOptions) {
    this.credentials = options.credentials
    this.resources = options.resources
    this.attachmentLifecycle = options.attachmentLifecycle
    this.resolution = {
      resources: options.resources,
      credentials: options.credentials,
      attachments: options.attachments,
      spaces: options.spaces,
      directory: options.directory,
      readableKeyIds: (requiredKeyIds) => options.keyring.readableKeyIds(requiredKeyIds),
    }
    this.credentialConsumer = providerResourceCredentialConsumer(options.credentials)
    this.keyring = options.keyring
    this.privateOrigins = options.privateOrigins
    this.runtime = options.runtime
    this.mutationGate = options.mutationGate
    this.authMode = options.authMode ?? AUTH_MODE.password
    this.now = options.now ?? (() => new Date())
    const projectAttachmentResource = (record: ProviderResourceRecord, viewerOwner: string) => {
      const summary = this.resourceListItemToWire(record, { owner: viewerOwner })

      delete summary.baseUrl

      return summary
    }
    this.attachmentService = new ProviderAttachmentsService({
      attachments: options.attachments,
      lifecycle: options.attachmentLifecycle,
      resources: options.resources,
      credentials: options.credentials,
      spaces: options.spaces,
      projects: options.projects,
      projectResource: projectAttachmentResource,
      projectResourceListItem: projectAttachmentResource,
      now: this.now,
    })
  }

  async createCredential(owner: string, input: CredentialCreateRequest): Promise<Credential> {
    const id = freshNoteId()
    const origin = canonicalCredentialOrigin(input.origin)
    const injection = canonicalInjection(input.injection)

    if (carriesWholeSecret(injection.prefix)) {
      fails('credential injection prefix must not contain a complete secret')
    }

    return this.withActiveCiphertext(async () => {
      const encrypted = await this.keyring.encrypt(input.secret, {
        facet: SECRET_FACET.credential,
        recordId: id,
        field: 'secret',
      })
      const record: CredentialRecord = {
        id,
        owner,
        name: input.name,
        kind: input.kind,
        secret: encrypted.ciphertext,
        origin,
        injection,
        disabledAt: null,
        rpm: input.rpm,
        tpm: input.tpm,
        consentEpoch: 0,
        runtimeEpoch: 0,
      }
      await this.credentials.create(record, encrypted)
      return this.credentialToWire(record)
    })
  }

  async listCredentials(owner: string): Promise<CredentialListItem[]> {
    return (await this.credentials.listForOwner(owner)).map((record) =>
      this.credentialListItemToWire(record),
    )
  }

  async pageCredentials(
    owner: string,
    after: ProviderPagePosition | null,
    limit: number,
  ): Promise<{ items: CredentialListItem[]; total: number }> {
    const page = await this.credentials.pageIdsForOwner(owner, { after, limit })
    const loaded = this.credentials.getMany
      ? await this.credentials.getMany(page.ids)
      : (await Promise.all(page.ids.map((id) => this.credentials.get(id)))).filter(
          (record): record is CredentialRecord => record !== null,
        )
    const byId = new Map(loaded.map((record) => [record.id, record]))

    return {
      items: page.ids.flatMap((id) => {
        const record = byId.get(id)
        return record ? [this.credentialListItemToWire(record)] : []
      }),
      total: page.total,
    }
  }

  async getCredential(owner: string, id: string): Promise<CredentialResponse | null> {
    const record = await this.credentials.get(id)

    if (!record || record.owner !== owner) {
      return null
    }

    return {
      credential: this.credentialToWire(record),
      references: await this.credentialConsumer.references(id),
    }
  }

  async updateCredential(
    owner: string,
    id: string,
    patch: CredentialPatchRequest,
  ): Promise<CredentialResponse | null> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.credentials.get(id)

      if (!current || current.owner !== owner) {
        return null
      }
      const changes: Partial<CredentialMutableFields> = {}
      let runtimeChanged = false
      let consentChanged = false

      if (patch.name !== undefined) {
        changes.name = patch.name
      }
      if (patch.origin !== undefined) {
        changes.origin = canonicalCredentialOrigin(patch.origin)
        runtimeChanged ||= changes.origin !== current.origin
        consentChanged ||= changes.origin !== current.origin
      }
      if (patch.injection !== undefined) {
        changes.injection = canonicalInjection(patch.injection)
        if (carriesWholeSecret(changes.injection.prefix)) {
          fails('credential injection prefix must not contain a complete secret')
        }
        const changed =
          changes.injection.header !== current.injection.header ||
          changes.injection.prefix !== current.injection.prefix
        runtimeChanged ||= changed
        consentChanged ||= changed
      }
      if (patch.disabled !== undefined) {
        changes.disabledAt = patch.disabled ? this.now().toISOString() : null
        runtimeChanged ||= changes.disabledAt !== current.disabledAt
      }
      if (patch.rpm !== undefined) {
        changes.rpm = patch.rpm
        runtimeChanged ||= patch.rpm !== current.rpm
      }
      if (patch.tpm !== undefined) {
        changes.tpm = patch.tpm
        runtimeChanged ||= patch.tpm !== current.tpm
      }
      let ciphertext = null

      if (patch.secret !== undefined) {
        const encrypted = await this.keyring.encrypt(patch.secret, {
          facet: SECRET_FACET.credential,
          recordId: id,
          field: 'secret',
        })
        changes.secret = encrypted.ciphertext
        ciphertext = encrypted
        runtimeChanged = true
      }
      try {
        const result = await this.credentialConsumer.mutate({
          id,
          expectedRuntimeEpoch: current.runtimeEpoch,
          changes,
          ciphertext,
          runtimeChanged,
          consentChanged,
        })

        if (result.status === 'missing') {
          return null
        }
        if (result.status === 'conflict') {
          continue
        }
        if (result.status === 'references-invalid') {
          return referenced(
            'credential mutation is incompatible with referenced provider resources',
            credentialReferencesOf(result.references),
          )
        }

        return {
          credential: this.credentialToWire(result.record),
          references: await this.credentialConsumer.references(id),
        }
      } catch (error) {
        if (this.isStaleCiphertextKey(error)) {
          await this.keyring.refreshActive()
          continue
        }
        throw error
      }
    }

    throw Object.assign(new Error('credential kept changing during update'), {
      code: 'PROVIDER_CONFLICT',
    })
  }

  async deleteCredential(owner: string, id: string): Promise<boolean> {
    const current = await this.credentials.get(id)

    if (!current || current.owner !== owner) {
      return false
    }
    const result = await this.credentialConsumer.deleteIfUnreferenced(id)

    if (result.status === 'missing') {
      return false
    }
    if (result.status === 'referenced') {
      return referenced(
        'credential is still referenced by provider resources',
        credentialReferencesOf(result.references),
      )
    }

    return true
  }

  async createResource(
    owner: string,
    input: ProviderResourceCreateRequest,
  ): Promise<{ resource: ProviderResource; warnings: string[] }> {
    const id = freshNoteId()
    return this.withActiveCiphertext(async () => {
      const prepared = await this.prepareResource(id, owner, input)
      await this.resources.create(prepared.record, prepared.ciphertext)
      return {
        resource: this.resourceToWire(prepared.record, { owner }),
        warnings: prepared.warnings,
      }
    })
  }

  async updateResource(
    owner: string,
    id: string,
    patch: ProviderResourcePatchRequest,
  ): Promise<{ resource: ProviderResource; warnings: string[] } | null> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.resources.get(id)

      if (!current || current.owner !== owner) {
        return null
      }
      const encryptedHeaders = Object.entries(current.headers)
      const plaintextValues = await this.keyring.decryptMany(
        encryptedHeaders.map(([name, value]) => ({
          value,
          aad: {
            facet: SECRET_FACET.resource,
            recordId: current.id,
            field: name,
          },
        })),
      )
      const plaintextHeaders = Object.fromEntries(
        encryptedHeaders.map(([name], index) => [name, plaintextValues[index]]),
      )
      const merged: ProviderResourceCreateRequest = {
        name: patch.name ?? current.name,
        wire: patch.wire ?? current.wire,
        baseUrl: patch.baseUrl ?? current.baseUrl,
        headers: patch.headers
          ? applyHeaderPatch(plaintextHeaders, patch.headers)
          : plaintextHeaders,
        allowPrivateNetwork: patch.allowPrivateNetwork ?? current.allowPrivateNetwork,
        models: patch.models ?? authoredProviderModels(current.models),
        defaultModel: patch.defaultModel !== undefined ? patch.defaultModel : current.defaultModel,
        credentialId: patch.credentialId !== undefined ? patch.credentialId : current.credentialId,
        firstByteTimeoutMs:
          patch.firstByteTimeoutMs !== undefined
            ? patch.firstByteTimeoutMs
            : current.firstByteTimeoutMs,
        callTimeoutMs:
          patch.callTimeoutMs !== undefined ? patch.callTimeoutMs : current.callTimeoutMs,
      }
      const prepared = await this.prepareResource(id, owner, merged)
      const nameChanged = prepared.record.name !== current.name
      const disabledAt =
        patch.disabled === undefined
          ? current.disabledAt
          : patch.disabled
            ? (current.disabledAt ?? this.now().toISOString())
            : null
      const disabledChanged = disabledAt !== current.disabledAt
      const callConfigChanged =
        prepared.record.wire !== current.wire ||
        prepared.record.baseUrl !== current.baseUrl ||
        !sameJson(
          Object.entries(merged.headers).sort(([left], [right]) => left.localeCompare(right)),
          Object.entries(plaintextHeaders).sort(([left], [right]) => left.localeCompare(right)),
        ) ||
        prepared.record.allowPrivateNetwork !== current.allowPrivateNetwork ||
        !sameJson(
          authoredProviderModels(prepared.record.models),
          authoredProviderModels(current.models),
        ) ||
        prepared.record.defaultModel !== current.defaultModel ||
        prepared.record.credentialId !== current.credentialId ||
        prepared.record.firstByteTimeoutMs !== current.firstByteTimeoutMs ||
        prepared.record.callTimeoutMs !== current.callTimeoutMs

      if (!nameChanged && !disabledChanged && !callConfigChanged) {
        return {
          resource: this.resourceToWire(current, { owner }),
          warnings: prepared.warnings,
        }
      }
      const consentChanged = callConfigChanged
      const callChanged = callConfigChanged || disabledChanged
      prepared.record.consentEpoch = current.consentEpoch + (consentChanged ? 1 : 0)
      prepared.record.runtimeEpoch = current.runtimeEpoch + (callChanged ? 1 : 0)
      prepared.record.lastCheck = callChanged ? {} : current.lastCheck
      prepared.record.disabledAt = disabledAt
      let replaced: Awaited<ReturnType<ProviderResourcesPersistence['replaceIfRuntimeEpoch']>>

      try {
        replaced = await this.resources.replaceIfRuntimeEpoch(
          prepared.record,
          prepared.ciphertext,
          current.runtimeEpoch,
          current.credentialId,
        )
      } catch (error) {
        if (this.isStaleCiphertextKey(error)) {
          await this.keyring.refreshActive()
          continue
        }
        throw error
      }

      if (replaced.status === 'missing') {
        return null
      }
      if (replaced.status === 'conflict') {
        continue
      }

      return {
        resource: this.resourceToWire(replaced.record, { owner }),
        warnings: prepared.warnings,
      }
    }

    throw Object.assign(new Error('provider resource kept changing during update'), {
      code: 'PROVIDER_CONFLICT',
    })
  }

  async listResources(owner: string): Promise<ProviderResourceListItem[]> {
    return (await this.resources.listForOwner(owner)).map((record) =>
      this.resourceListItemToWire(record, { owner }),
    )
  }

  async pageResources(
    owner: string,
    after: ProviderPagePosition | null,
    limit: number,
  ): Promise<{ items: ProviderResourceListItem[]; total: number }> {
    const page = await this.resources.pageIdsForOwner(owner, { after, limit })
    const loaded = this.resources.getMany
      ? await this.resources.getMany(page.ids)
      : (await Promise.all(page.ids.map((id) => this.resources.get(id)))).filter(
          (record): record is ProviderResourceRecord => record !== null,
        )
    const byId = new Map(loaded.map((record) => [record.id, record]))

    return {
      items: page.ids.flatMap((id) => {
        const record = byId.get(id)
        return record ? [this.resourceListItemToWire(record, { owner })] : []
      }),
      total: page.total,
    }
  }

  resourceListItemToWire(
    record: ProviderResourceRecord,
    viewer: ProviderResourceViewer = {},
  ): ProviderResourceListItem {
    const resource = this.resourceToWire(record, viewer)
    const capabilities = [MODEL_CAPABILITY.completion, MODEL_CAPABILITY.embedding].filter(
      (capability) => record.models.some((model) => model.capabilities.includes(capability)),
    )

    return {
      id: resource.id,
      name: resource.name,
      wire: resource.wire,
      owner: resource.owner,
      ...(resource.baseUrl === undefined ? {} : { baseUrl: resource.baseUrl }),
      addressIsPrivate: resource.addressIsPrivate,
      capabilities,
      modelCount: resource.models.length,
      hasCredentials: resource.hasCredentials,
      disabledAt: resource.disabledAt,
    }
  }

  async getResource(id: string): Promise<ProviderResourceRecord | null> {
    return this.resources.get(id)
  }

  resourceToWire(
    record: ProviderResourceRecord,
    viewer: ProviderResourceViewer = {},
  ): ProviderResource {
    const isOwner = viewer.owner !== undefined && viewer.owner === record.owner
    // The addressee and everything derived from it travel together. An ordinary
    // member of a Space a resource is attached to learns what it serves and who
    // pays for it; the host it points at is the consent surface's subject, not
    // theirs. A header NAME can be a secret of its own, so it rides along.
    const canReadAddress = isOwner || viewer.admin === true || viewer.consentManager === true
    const canReadDiagnostic = isOwner || viewer.admin === true
    const addressIsPrivate = this.addressIsPrivate(record)

    return {
      id: record.id,
      name: record.name,
      wire: record.wire,
      owner: this.ownerToWire(record.owner, isOwner),
      ...(canReadAddress
        ? {
            baseUrl: record.baseUrl,
            headerNames: Object.keys(record.headers).sort(),
            vendor: providerVendorOf(new URL(record.baseUrl).origin),
            allowPrivateNetwork: record.allowPrivateNetwork,
            firstByteTimeoutMs: record.firstByteTimeoutMs,
            callTimeoutMs: record.callTimeoutMs,
          }
        : {}),
      addressIsPrivate,
      models: record.models.map((model) => ({
        ...model,
        capabilities: [...model.capabilities],
        statusByCapability: { ...model.statusByCapability },
      })),
      defaultModel: record.defaultModel,
      // An owner-management detail. A host admin does not get it either: the
      // credential belongs to its owner, admin or not.
      ...(isOwner ? { credentialId: record.credentialId } : {}),
      hasCredentials: record.credentialId !== null,
      consentEpoch: record.consentEpoch,
      runtimeEpoch: record.runtimeEpoch,
      disabledAt: record.disabledAt,
      lastCheck: projectProviderLastCheck(record.lastCheck, {
        authMode: this.authMode,
        canReadAddress,
        canReadDiagnostic,
        addressIsPrivate,
      }),
    }
  }

  /** Who pays for the call. The owner key is a username by construction (a token
   *  cannot reach this surface), so the attribution needs no principal parsing —
   *  except for the authless host, which is not a person at all. */
  private ownerToWire(owner: string, mine: boolean): Author {
    return owner === AGENT_SYSTEM_OWNER
      ? { kind: AUTHOR_KIND.system, name: null, mine }
      : { kind: AUTHOR_KIND.user, name: owner, mine }
  }

  hasUsableForPrincipal(input: { owner: string; spaces: readonly string[] }): Promise<boolean> {
    return hasUsableForPrincipal(this.resolution, input)
  }

  resolveForPrincipalPage(input: {
    owner: string
    spaces: readonly string[]
    after: ProviderPagePosition | null
    limit: number
  }) {
    return resolveForPrincipalPage(this.resolution, {
      owner: input.owner,
      spaces: input.spaces,
      page: { after: input.after, limit: input.limit },
    })
  }

  resolveOneForPrincipal(input: { owner: string; spaces: readonly string[]; resourceId: string }) {
    return resolveOneForPrincipal(this.resolution, input)
  }

  resolveOwnedMany(input: { owner: string; resourceIds: readonly string[] }) {
    return resolveOwnedMany(this.resolution, input)
  }

  /** What a Space's background work may call. Ownership grants nothing here, so a
   *  personal resource nobody attached is unreachable to it by construction. */
  async resolveForScope(space: string): Promise<ProviderResolutionEntry[]> {
    return resolveForScope(this.resolution, { space })
  }

  /** Resolve a concrete resource through the Space capability and execute it under
   *  the exact runtime snapshot that was admitted. Resolution runs once on entry and
   *  once more after any limiter wait in the executor's `beforeSend` seam. */
  async executeForScope(input: ProviderScopeCallInput): Promise<ProviderCallResult> {
    if (!this.runtime) {
      throw new ProviderCallError(PROVIDER_CALL_ERROR.policyDenied, {
        retrySafe: true,
        deliveryState: PROVIDER_DELIVERY_STATE.notSent,
      })
    }
    const initial = await this.requireCallableScopeResource(input.space, input.resourceId)
    const { record, credential } = initial
    let capability: ModelCapability
    let modelName: string

    if (input.operation.kind === PROVIDER_CALL_KIND.chat) {
      capability = MODEL_CAPABILITY.completion
      modelName = input.operation.model
    } else if (input.operation.kind === PROVIDER_CALL_KIND.embedding) {
      capability = MODEL_CAPABILITY.embedding
      modelName = input.operation.model
    } else {
      throw new ProviderCallError(PROVIDER_CALL_ERROR.invalidRequest, {
        deliveryState: PROVIDER_DELIVERY_STATE.notSent,
      })
    }
    const model = record.models.find((candidate) => candidate.name === modelName)

    if (
      !model ||
      !model.capabilities.includes(capability) ||
      model.statusByCapability[capability] !== MODEL_STATUS.available
    ) {
      throw new ProviderCallError(PROVIDER_CALL_ERROR.modelUnavailable, {
        deliveryState: PROVIDER_DELIVERY_STATE.notSent,
      })
    }
    let callHeaders: Awaited<ReturnType<ProviderRegistry['callHeaders']>>

    try {
      callHeaders = await this.callHeaders(record, credential)
    } catch (cause) {
      throw this.scopePolicyDenied(cause)
    }
    const snapshot = {
      resourceRuntimeEpoch: record.runtimeEpoch,
      credentialId: record.credentialId,
      credentialRuntimeEpoch: credential?.runtimeEpoch ?? null,
    }

    return this.runtime.execute({
      endpoint: {
        principalId: input.principal,
        wire: record.wire,
        baseUrl: record.baseUrl,
        headers: callHeaders.headers,
        sensitiveValues: callHeaders.sensitiveValues,
        allowPrivateNetwork: record.allowPrivateNetwork,
        firstByteTimeoutMs: record.firstByteTimeoutMs,
        callTimeoutMs: record.callTimeoutMs,
      },
      operation: input.operation,
      retryMode: input.retryMode,
      call: {
        owner: record.owner,
        principal: input.principal,
        agent: input.agent,
        resourceId: record.id,
        credentialId: credential?.id ?? null,
        spaces: [input.space],
        job: input.job,
        rateLimit: {
          rpm: credential?.rpm ?? null,
          tpm: credential?.tpm ?? null,
          ...input.rateLimit,
        },
      },
      signal: input.signal,
      onText: input.onText,
      beforeSend: async () => {
        const current = await this.requireCallableScopeResource(input.space, input.resourceId)

        if (
          current.record.runtimeEpoch !== snapshot.resourceRuntimeEpoch ||
          current.record.credentialId !== snapshot.credentialId ||
          (current.credential?.runtimeEpoch ?? null) !== snapshot.credentialRuntimeEpoch
        ) {
          throw this.scopePolicyDenied()
        }
        const currentModel = current.record.models.find((candidate) => candidate.name === modelName)

        if (
          !currentModel ||
          !currentModel.capabilities.includes(capability) ||
          currentModel.statusByCapability[capability] !== MODEL_STATUS.available
        ) {
          throw new ProviderCallError(PROVIDER_CALL_ERROR.modelUnavailable, {
            deliveryState: PROVIDER_DELIVERY_STATE.notSent,
          })
        }

        return true
      },
    })
  }

  private scopePolicyDenied(cause?: unknown): ProviderCallError {
    return new ProviderCallError(PROVIDER_CALL_ERROR.policyDenied, {
      retrySafe: true,
      deliveryState: PROVIDER_DELIVERY_STATE.notSent,
      cause,
    })
  }

  private async requireCallableScopeResource(space: string, resourceId: string) {
    try {
      const current = await this.callableScopeResource(space, resourceId)

      if (current) {
        return current
      }
    } catch (cause) {
      throw this.scopePolicyDenied(cause)
    }

    throw this.scopePolicyDenied()
  }

  private async callableScopeResource(space: string, resourceId: string) {
    const entry = (await resolveForScope(this.resolution, { space })).find(
      (candidate) => candidate.record.id === resourceId,
    )

    if (!entry || entry.unusableBecause !== null) {
      return null
    }
    const credential = entry.record.credentialId
      ? await this.credentials.get(entry.record.credentialId)
      : null

    if (entry.record.credentialId && !credential) {
      return null
    }

    return { record: entry.record, credential }
  }

  /** Pure, and deliberately so: an outgoing DNS lookup on a READ path would be a
   *  worse version of the resolve that saving is forbidden to do. An origin can
   *  only ever reach a private address when it is literally one, or when it holds
   *  both the operator admission and the resource opt-in. */
  private addressIsPrivate(record: ProviderResourceRecord): boolean {
    const origin = new URL(record.baseUrl).origin
    const literal = literalAddressClassOf(new URL(origin).hostname)

    return (
      literal === ADDRESS_CLASS.private ||
      literal === ADDRESS_CLASS.loopback ||
      (record.allowPrivateNetwork && this.privateOrigins.has(origin))
    )
  }

  async getOwnedResource(owner: string, id: string) {
    const resource = await this.resources.get(id)

    return resource?.owner === owner ? resource : null
  }

  async deleteResource(owner: string, id: string): Promise<boolean> {
    const resource = await this.resources.get(id)

    if (!resource || resource.owner !== owner) {
      return false
    }
    await this.resources.delete(id)
    return true
  }

  getAttachment(id: string) {
    return this.attachmentService.get(id)
  }

  attachmentTargetSpace(targetKind: 'space' | 'project', targetId: string) {
    return this.attachmentService.targetSpace(targetKind, targetId)
  }

  offerAttachment(input: {
    owner: string
    resourceId: string
    targetKind: 'space' | 'project'
    targetId: string
  }) {
    return this.attachmentService.offer(input)
  }

  pageAttachmentsForSpace(
    space: string,
    viewerOwner: string,
    after: ProviderPagePosition | null,
    limit: number,
  ): Promise<{ items: ProviderAttachmentListItem[]; total: number }> {
    return this.attachmentService.pageForSpace(space, viewerOwner, { after, limit })
  }

  getAttachmentDetail(id: string, viewerOwner: string): Promise<ProviderAttachmentView | null> {
    return this.attachmentService.detail(id, viewerOwner)
  }

  acceptAttachment(
    id: string,
    expected: ProviderAttachmentAcceptRequest,
    viewerOwner: string,
    manager: string | null,
  ) {
    return this.attachmentService.accept(id, expected, viewerOwner, manager)
  }

  detachAttachment(id: string, manager: string | null) {
    return this.attachmentService.detach(id, manager)
  }

  async retargetCredential(
    owner: string,
    id: string,
    input: ProviderRetargetRequest,
    signal: AbortSignal,
  ): Promise<ProviderRetargetResponse | null> {
    const runtime = this.runtime

    if (!runtime) {
      return null
    }
    const owned = await this.credentials.get(id)

    if (!owned || owned.owner !== owner) {
      return null
    }
    runtime.admitRetarget(owner)
    const operationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(PROVIDER_TIMEOUT.firstByteMaximumMs),
    ])

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const credential = await this.credentials.get(id)

      if (!credential || credential.owner !== owner) {
        return null
      }
      const references = await this.credentials.references(id)
      const requested = new Map(input.resources.map((resource) => [resource.id, resource]))

      if (
        requested.size !== references.length ||
        references.some((resource) => !requested.has(resource.id))
      ) {
        return this.retargetRefused(
          'retarget resources no longer match the credential references',
          references.map((resource) => ({
            id: resource.id,
            name: resource.name,
            reason: 'the reference set changed; reload before retrying',
            resolution: 'fix-or-delete',
          })),
        )
      }
      const origin = canonicalCredentialOrigin(input.origin)
      const conflicts: ProviderRetargetConflictReference[] = []
      const admissions = new Map<string, Promise<unknown>>()
      const prepared: Array<{
        id: string
        expectedRuntimeEpoch: number
        baseUrl: string
        detachCredential: boolean
      }> = []

      for (const resource of references) {
        const requestedResource = requested.get(resource.id)!
        const canonical = canonicalBaseUrl(requestedResource.baseUrl)
        const literal = literalAddressClassOf(new URL(canonical.origin).hostname)

        if (literal === ADDRESS_CLASS.alwaysDenied) {
          conflicts.push({
            id: resource.id,
            name: resource.name,
            reason: 'the target is always denied by network policy',
            resolution: 'fix-or-delete',
          })
          continue
        }
        if (
          (literal === ADDRESS_CLASS.private || literal === ADDRESS_CLASS.loopback) &&
          (!resource.allowPrivateNetwork || !this.privateOrigins.has(canonical.origin))
        ) {
          conflicts.push({
            id: resource.id,
            name: resource.name,
            reason: 'the private target lacks operator admission or resource opt-in',
            resolution: 'fix-or-delete',
          })
          continue
        }
        try {
          const admissionKey = `${canonical.origin}\0${resource.allowPrivateNetwork ? 'private' : 'public'}`
          let admission = admissions.get(admissionKey)

          if (!admission) {
            admission = runtime.admitEndpoint({
              // Network policy is origin-scoped. Rechecking every path at the same
              // origin only repeats DNS and cannot produce a different class.
              baseUrl: canonical.origin,
              allowPrivateNetwork: resource.allowPrivateNetwork,
              signal: operationSignal,
            })
            admissions.set(admissionKey, admission)
          }
          await admission
        } catch {
          if (operationSignal.aborted) {
            throw operationSignal.reason
          }
          conflicts.push({
            id: resource.id,
            name: resource.name,
            reason: 'the target is refused by the network policy',
            resolution: 'fix-or-delete',
          })
          continue
        }
        const injectionHeader =
          credential.injection.header || DEFAULT_CREDENTIAL_HEADER[credential.kind][resource.wire]
        const conditionalReason =
          canonical.origin !== origin
            ? 'the resource origin differs from the new credential origin'
            : Object.hasOwn(resource.headers, injectionHeader)
              ? `provider header ${injectionHeader} collides with credential injection`
              : null

        if (conditionalReason && !requestedResource.detachCredential) {
          conflicts.push({
            id: resource.id,
            name: resource.name,
            reason: conditionalReason,
            resolution: 'detach',
          })
          continue
        }
        if (!conditionalReason && requestedResource.detachCredential) {
          conflicts.push({
            id: resource.id,
            name: resource.name,
            reason: 'detachment is allowed only as the exit from a credential-conditional refusal',
            resolution: 'fix-or-delete',
          })
          continue
        }
        prepared.push({
          id: resource.id,
          expectedRuntimeEpoch: resource.runtimeEpoch,
          baseUrl: canonical.baseUrl,
          detachCredential: requestedResource.detachCredential,
        })
      }

      if (conflicts.length > 0) {
        return this.retargetRefused('provider credential cannot be retargeted', conflicts)
      }
      const result = await this.attachmentLifecycle.retargetProviderCredential({
        owner,
        credentialId: id,
        expectedCredentialRuntimeEpoch: credential.runtimeEpoch,
        origin,
        resources: prepared,
      })

      if (result.status !== 'retargeted') {
        if (result.status === 'missing') {
          return null
        }
        continue
      }

      return {
        credential: this.credentialToWire(result.credential),
        resources: result.resources.map((resource) => this.resourceToWire(resource, { owner })),
      }
    }

    throw Object.assign(new Error('provider references kept changing during retarget'), {
      code: 'PROVIDER_CONFLICT',
    })
  }

  /** The product caller of the executor: one click, a real outbound call, an outcome
   *  recorded under the epochs it was taken with. There is no background rechecker
   *  by design — it would spend someone else's tokens without being asked. */
  async validateResource(input: {
    owner: string
    /** The full principal id and its agent label, snapshotted into the journal. */
    principal: string
    agent: string | null
    admin: boolean
    resourceId: string
    capability: ModelCapability
    signal: AbortSignal
  }): Promise<ProviderValidateResponse | null> {
    const record = await this.resources.get(input.resourceId)

    if (!record || record.owner !== input.owner || !this.runtime) {
      return null
    }
    const model = this.probedModel(record, input.capability)

    if (!model) {
      return fails('provider resource has no model with this capability')
    }
    // Admission first, before anything that can persist. A locally decided outcome
    // opens no socket but still writes a row, and an uncapped loop of those writes
    // starves the online backup's drift detector just as effectively as traffic.
    await this.runtime.admitValidate(input.owner)
    const credential = record.credentialId ? await this.credentials.get(record.credentialId) : null
    // Captured BEFORE the send: the outcome may take up to the call ceiling to come
    // back, and both rows are free to move meanwhile.
    const snapshot = {
      expectedRuntimeEpoch: record.runtimeEpoch,
      expectedCredentialId: record.credentialId,
      expectedCredentialRuntimeEpoch: credential?.runtimeEpoch ?? null,
    }
    const probe = await this.probeResource(record, credential, {
      ...input,
      model: model.name,
      beforeSend: async () => {
        const currentResource = await this.resources.get(record.id)

        if (
          !currentResource ||
          currentResource.runtimeEpoch !== snapshot.expectedRuntimeEpoch ||
          currentResource.credentialId !== snapshot.expectedCredentialId
        ) {
          return false
        }
        const currentCredential = snapshot.expectedCredentialId
          ? await this.credentials.get(snapshot.expectedCredentialId)
          : null

        const currentModel = currentResource.models.find(
          (candidate) => candidate.name === model.name,
        )

        return (
          (currentCredential?.runtimeEpoch ?? null) === snapshot.expectedCredentialRuntimeEpoch &&
          currentModel?.capabilities.includes(input.capability) === true
        )
      },
    })
    const result = {
      status: probe.status,
      checkedAt: this.now().toISOString(),
      diagnostic: probe.diagnostic,
      credentialProven: probe.credentialProven,
    }
    const write = () =>
      this.resources.recordLastCheck({
        resourceId: record.id,
        capability: input.capability,
        lastCheck: result,
        measurement: this.measurementOf(probe, input.capability),
        ...snapshot,
      })
    // Being outside the mutation barrier is a licence to hold no admission during
    // the network call, NOT to write outside the gate: this write moves
    // `PRAGMA data_version`, and an online-backup snapshot that sees it drift
    // discards the attempt.
    const written = await (this.mutationGate ? this.mutationGate.run(write) : write())
    const stored = written.status === 'missing' ? record : written.record

    return {
      capability: input.capability,
      result,
      saved: written.status === 'recorded',
      resource: this.resourceToWire(stored, { owner: input.owner, admin: input.admin }),
    }
  }

  /** A capable default first, then the first capable authored row. Availability is
   * intentionally ignored: validate is how an unavailable pair becomes available. */
  private probedModel(
    record: ProviderResourceRecord,
    capability: ModelCapability,
  ): ProviderModel | null {
    const capable = record.models.filter((model) => model.capabilities.includes(capability))

    if (record.defaultModel) {
      const selected = capable.find((model) => model.name === record.defaultModel)

      if (selected) {
        return selected
      }
    }

    return capable[0] ?? null
  }

  private measurementOf(
    probe: ProviderProbeOutcome,
    capability: ModelCapability,
  ): {
    modelName: string
    status?: (typeof MODEL_STATUS)[keyof typeof MODEL_STATUS]
    dimensions?: number
  } | null {
    if (!probe.model) {
      return null
    }

    if (probe.modelUnavailable) {
      return {
        modelName: probe.model,
        status: MODEL_STATUS.unavailable,
      }
    }
    if (probe.status !== PROVIDER_STATUS.ready) {
      return null
    }

    return {
      modelName: probe.model,
      status: MODEL_STATUS.available,
      ...(capability === MODEL_CAPABILITY.embedding && probe.dimensions !== null
        ? { dimensions: probe.dimensions }
        : {}),
    }
  }

  /** Everything decidable without a socket is decided without one. */
  private async probeResource(
    record: ProviderResourceRecord,
    credential: CredentialRecord | null,
    input: {
      owner: string
      principal: string
      agent: string | null
      capability: ModelCapability
      model: string
      signal: AbortSignal
      beforeSend: () => Promise<boolean>
    },
  ): Promise<ProviderProbeOutcome> {
    const refuse = (status: ProviderStatus): ProviderProbeOutcome => ({
      status,
      diagnostic: null,
      credentialProven: false,
      dimensions: null,
      modelUnavailable: false,
      model: null,
    })

    if (record.disabledAt) {
      return refuse(PROVIDER_STATUS.disabled)
    }
    if (record.credentialId && !credential) {
      return refuse(PROVIDER_STATUS.notConfigured)
    }
    if (credential?.disabledAt) {
      return refuse(PROVIDER_STATUS.credentialDisabled)
    }
    const origin = new URL(record.baseUrl).origin

    if (credential && credential.origin !== origin) {
      return refuse(PROVIDER_STATUS.credentialOriginMismatch)
    }
    let callHeaders: Awaited<ReturnType<ProviderRegistry['callHeaders']>>

    try {
      callHeaders = await this.callHeaders(record, credential)
    } catch {
      // Both ciphertext carriers land here. Without them the request would go out
      // to a real address unauthenticated, which is worse than not going at all.
      return refuse(PROVIDER_STATUS.secretUnreadable)
    }
    const outcome = await this.runtime!.validate({
      endpoint: {
        principalId: `user:${input.owner}`,
        wire: record.wire,
        baseUrl: record.baseUrl,
        headers: callHeaders.headers,
        sensitiveValues: callHeaders.sensitiveValues,
        allowPrivateNetwork: record.allowPrivateNetwork,
        firstByteTimeoutMs: record.firstByteTimeoutMs,
        callTimeoutMs: record.callTimeoutMs,
      },
      call: {
        owner: input.owner,
        principal: input.principal,
        agent: input.agent,
        resourceId: record.id,
        credentialId: credential?.id ?? null,
        // A probe carries a fixed string of ours, so no Space's content is on it.
        spaces: [],
        // `validate` is interactive: there is no durable call to fence.
        job: null,
        rateLimit: {
          rpm: credential?.rpm ?? null,
          tpm: credential?.tpm ?? null,
          inputUpperBound: 0,
          outputTokenBudget: 0,
        },
      },
      capability: input.capability,
      model: input.model,
      signal: input.signal,
      beforeSend: input.beforeSend,
    })

    return { ...outcome, model: input.model }
  }

  private async callHeaders(
    record: ProviderResourceRecord,
    credential: CredentialRecord | null,
  ): Promise<{ headers: Map<string, string>; sensitiveValues: ReadonlySet<string> }> {
    const headers = new Map<string, string>()
    const encryptedHeaders = Object.entries(record.headers)
    const values: Array<{ value: string; aad: SecretAad }> = encryptedHeaders.map(
      ([name, value]) => ({
        value,
        aad: {
          facet: SECRET_FACET.resource,
          recordId: record.id,
          field: name,
        },
      }),
    )

    if (credential) {
      values.push({
        value: credential.secret,
        aad: {
          facet: SECRET_FACET.credential,
          recordId: credential.id,
          field: 'secret',
        },
      })
    }
    const plaintext = await this.keyring.decryptMany(values)
    const sensitiveValues = new Set(plaintext)

    for (const [index, [name]] of encryptedHeaders.entries()) {
      headers.set(name, plaintext[index])
    }
    if (credential) {
      const secret = plaintext[plaintext.length - 1]
      const name =
        credential.injection.header || DEFAULT_CREDENTIAL_HEADER[credential.kind][record.wire]
      headers.set(name, `${credential.injection.prefix}${secret}`)
    }

    return { headers, sensitiveValues }
  }

  private credentialToWire(record: CredentialRecord): Credential {
    return {
      id: record.id,
      name: record.name,
      kind: record.kind,
      origin: record.origin,
      injection: { ...record.injection },
      disabledAt: record.disabledAt,
      rpm: record.rpm,
      tpm: record.tpm,
      consentEpoch: record.consentEpoch,
      runtimeEpoch: record.runtimeEpoch,
    }
  }

  private credentialListItemToWire(record: CredentialRecord): CredentialListItem {
    const credential = this.credentialToWire(record)

    return {
      id: credential.id,
      name: credential.name,
      kind: credential.kind,
      origin: credential.origin,
      disabledAt: credential.disabledAt,
      rpm: credential.rpm,
      tpm: credential.tpm,
    }
  }

  private async withActiveCiphertext<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        if (attempt === 0 && this.isStaleCiphertextKey(error)) {
          await this.keyring.refreshActive()
          continue
        }
        throw error
      }
    }

    throw new Error('unreachable provider ciphertext retry state')
  }

  private isStaleCiphertextKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === PROVIDER_PERSISTENCE_ERROR.staleCiphertextKey
    )
  }

  private retargetRefused(message: string, references: ProviderRetargetConflictReference[]): never {
    throw Object.assign(new Error(message), {
      code: 'PROVIDER_RETARGET_CONFLICT',
      references,
    })
  }

  private async prepareResource(id: string, owner: string, input: ProviderResourceCreateRequest) {
    const { baseUrl, origin } = canonicalBaseUrl(input.baseUrl)
    const literal = literalAddressClassOf(new URL(origin).hostname)

    if (literal === ADDRESS_CLASS.alwaysDenied) {
      fails('provider baseUrl is always denied by network policy')
    }
    if (literal === ADDRESS_CLASS.private || literal === ADDRESS_CLASS.loopback) {
      if (!input.allowPrivateNetwork || !this.privateOrigins.has(origin)) {
        fails('private provider origin needs exact operator admission and resource opt-in')
      }
    }
    const preparedHeaders = headerInput(input.headers)
    const credential = input.credentialId ? await this.credentials.get(input.credentialId) : null

    if (input.credentialId && (!credential || credential.owner !== owner)) {
      fails('provider resource may reference only its owner credential')
    }
    if (credential && credential.origin !== origin) {
      fails('provider resource and credential origins differ')
    }
    if (credential) {
      const injectionName =
        credential.injection.header || DEFAULT_CREDENTIAL_HEADER[credential.kind][input.wire]

      if (Object.hasOwn(preparedHeaders.headers, injectionName)) {
        fails(`provider header ${injectionName} collides with credential injection`)
      }
    }
    const headerEntries = Object.entries(preparedHeaders.headers)
    const encrypted = await this.keyring.encryptMany(
      headerEntries.map(([name, value]) => ({
        value,
        aad: { facet: SECRET_FACET.resource, recordId: id, field: name },
      })),
    )
    const encryptedHeaders = Object.fromEntries(
      headerEntries.map(([name], index) => [name, encrypted[index].ciphertext]),
    )
    const ciphertext = encrypted[0] ?? null
    const authoredModels = canonicalProviderModelWrites(input.models)
    const modelNames = new Set(authoredModels.map((model) => model.name))

    if (input.defaultModel && !modelNames.has(input.defaultModel)) {
      fails('provider defaultModel must name a listed model')
    }
    const models = freshProviderModels(authoredModels)
    const record: ProviderResourceRecord = {
      id,
      owner,
      name: input.name,
      wire: input.wire,
      baseUrl,
      headers: encryptedHeaders,
      allowPrivateNetwork: input.allowPrivateNetwork,
      models,
      defaultModel: input.defaultModel,
      credentialId: input.credentialId,
      consentEpoch: 0,
      runtimeEpoch: 0,
      disabledAt: null,
      lastCheck: {},
      firstByteTimeoutMs: input.firstByteTimeoutMs,
      callTimeoutMs: input.callTimeoutMs,
    }
    return { record, ciphertext, warnings: preparedHeaders.warnings }
  }
}
