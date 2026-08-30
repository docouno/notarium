// Which provider resources a principal — or a Space acting without one — may
// actually call, and why the rest may not. The list of reasons is CLOSED: nothing
// outside `INVALIDITY` ever makes a resource unusable, and nothing inside it is
// decided anywhere but here. canon: #387 design/11

import {
  ATTACHMENT_STATE,
  type AttachmentState,
  PROVIDER_LIST_PAGE_SIZE,
  PROVIDER_STATUS,
} from '@notarium/contract'
import type { ProviderStatus } from '@notarium/contract'

import { AGENT_SYSTEM_OWNER } from '../authz'
import type {
  AuthPersistence,
  CredentialRecord,
  CredentialsPersistence,
  ProviderAttachmentRecord,
  ProviderAttachmentsPersistence,
  ProviderPageInput,
  ProviderPagePosition,
  ProviderResourceRecord,
  ProviderResourcesPersistence,
  SpaceRecord,
  SpacesPersistence,
  UserRecord,
} from '../metaDb'
import { providerCiphertextKeyId } from '../metaDb'

/** The two facts resolution needs about people. Narrowed to what it reads so the
 *  registry never gains the ability to write an account. */
export type ProviderPrincipalDirectory = Pick<AuthPersistence, 'getUser' | 'grantsFor'> &
  Partial<Pick<AuthPersistence, 'getUsers' | 'grantsForUsers'>>

export type ProviderResolutionPorts = {
  resources: Pick<
    ProviderResourcesPersistence,
    'get' | 'getMany' | 'pageEffectiveIds' | 'scanEffectivePage'
  >
  credentials: Pick<CredentialsPersistence, 'get' | 'getMany'>
  attachments: Pick<
    ProviderAttachmentsPersistence,
    'listForSpace' | 'listForSpaces' | 'listForResourcesInSpaces'
  >
  spaces: Pick<SpacesPersistence, 'getById' | 'getMany'>
  directory: ProviderPrincipalDirectory
  readableKeyIds: (requiredKeyIds: ReadonlySet<string>) => Promise<ReadonlySet<string>>
}

export type ProviderResolutionEntry = {
  record: ProviderResourceRecord
  /** Null exactly when the resource can be called; otherwise the closed-list reason. */
  unusableBecause: ProviderStatus | null
}

export type ProviderResolutionPage = {
  entries: ProviderResolutionEntry[]
  total: number
}

const HAS_USABLE_BATCH_SIZE = PROVIDER_LIST_PAGE_SIZE

/** An attachment that was accepted at least once. A `pending` offer is not a weaker
 *  grant — it is not a grant, and it stays invisible outside the consent surface. */
const CONSENTED: ReadonlySet<AttachmentState> = new Set<AttachmentState>([
  ATTACHMENT_STATE.active,
  ATTACHMENT_STATE.awaitingReconsent,
])

const readable = (ciphertext: string, keyIds: ReadonlySet<string>): boolean => {
  const keyId = providerCiphertextKeyId(ciphertext)

  return keyId !== null && keyIds.has(keyId)
}

/** Every fact that belongs to the record itself, in the order design/11 lists them.
 *  A grant cannot rescue any of these, so they are decided once per resource. */
export const providerRecordInvalidity = (input: {
  record: ProviderResourceRecord
  credential: CredentialRecord | null
  ownerDisabled: boolean
  readableKeyIds: ReadonlySet<string>
}): ProviderStatus | null => {
  const { record, credential } = input

  if (record.disabledAt) {
    return PROVIDER_STATUS.disabled
  }
  // A reference with no row left is unreachable behind the FK, so this is a
  // backstop — and it fails closed for the same reason unreadable ciphertext does:
  // without the credential the request would reach the real address unauthenticated.
  if (record.credentialId && !credential) {
    return PROVIDER_STATUS.secretUnreadable
  }
  if (credential?.disabledAt) {
    return PROVIDER_STATUS.credentialDisabled
  }
  // BOTH ciphertext carriers. A resource with no credential and unreadable headers
  // is the case that used to look healthy and send an unauthenticated request.
  const secretsReadable =
    Object.values(record.headers).every((value) => readable(value, input.readableKeyIds)) &&
    (!credential || readable(credential.secret, input.readableKeyIds))

  if (!secretsReadable) {
    return PROVIDER_STATUS.secretUnreadable
  }
  if (credential && credential.origin !== new URL(record.baseUrl).origin) {
    return PROVIDER_STATUS.credentialOriginMismatch
  }
  if (input.ownerDisabled) {
    return PROVIDER_STATUS.ownerDisabled
  }

  return null
}

/** Everything that belongs to ONE grant. Read fresh on every resolution, not trusted
 *  from the moment of acceptance: a missed epoch bump, a lost cascade or a race would
 *  otherwise be recorded as consent forever, because there is no second acceptance. */
export const providerGrantInvalidity = (input: {
  attachment: ProviderAttachmentRecord
  record: ProviderResourceRecord
  credential: CredentialRecord | null
  spaceIsArchived: boolean
  ownerIsMember: boolean
}): ProviderStatus | null => {
  const { attachment } = input

  if (attachment.state !== ATTACHMENT_STATE.active) {
    return PROVIDER_STATUS.attachmentNotActive
  }
  if (
    attachment.resourceEpoch !== input.record.consentEpoch ||
    attachment.credentialEpoch !== (input.credential?.consentEpoch ?? null)
  ) {
    return PROVIDER_STATUS.attachmentNotActive
  }
  if (input.spaceIsArchived) {
    return PROVIDER_STATUS.spaceArchived
  }
  if (!input.ownerIsMember) {
    return PROVIDER_STATUS.attachmentNotActive
  }

  return null
}

const unique = (values: readonly string[]): string[] => [...new Set(values)]

const mapBy = <T>(values: readonly T[], key: (value: T) => string): Map<string, T> =>
  new Map(values.map((value) => [key(value), value]))

const getMany = async <T>(
  ids: readonly string[],
  batch: ((ids: readonly string[]) => Promise<T[]>) | undefined,
  one: (id: string) => Promise<T | null>,
): Promise<T[]> => {
  const keys = unique(ids)

  if (keys.length === 0) {
    return []
  }
  if (batch) {
    return batch(keys)
  }

  const loaded = await Promise.all(keys.map(one))
  const found: T[] = []

  for (const value of loaded) {
    if (value !== null) {
      found.push(value as T)
    }
  }

  return found
}

const requiredKeyIdsOf = (
  records: readonly ProviderResourceRecord[],
  credentials: readonly CredentialRecord[],
): ReadonlySet<string> => {
  const requiredKeyIds = new Set<string>()

  for (const record of records) {
    for (const ciphertext of Object.values(record.headers)) {
      const keyId = providerCiphertextKeyId(ciphertext)

      if (keyId) {
        requiredKeyIds.add(keyId)
      }
    }
  }
  for (const credential of credentials) {
    const keyId = providerCiphertextKeyId(credential.secret)

    if (keyId) {
      requiredKeyIds.add(keyId)
    }
  }

  return requiredKeyIds
}

const attachmentsForSpaces = async (
  ports: ProviderResolutionPorts,
  spaces: readonly string[],
): Promise<ProviderAttachmentRecord[]> => {
  const keys = unique(spaces)

  if (keys.length === 0) {
    return []
  }
  const rows = ports.attachments.listForSpaces
    ? await ports.attachments.listForSpaces(keys)
    : (await Promise.all(keys.map((space) => ports.attachments.listForSpace(space)))).flat()
  const bySpace = new Map<string, ProviderAttachmentRecord[]>()

  for (const row of rows) {
    const current = bySpace.get(row.targetSpace) ?? []
    current.push(row)
    bySpace.set(row.targetSpace, current)
  }

  return keys.flatMap((space) => bySpace.get(space) ?? [])
}

type ResolutionFacts = {
  credentials: ReadonlyMap<string, CredentialRecord>
  spaces: ReadonlyMap<string, SpaceRecord>
  users: ReadonlyMap<string, UserRecord>
  grants: ReadonlyMap<string, ReadonlySet<string>>
  readableKeyIds: ReadonlySet<string>
}

const factsOf = async (
  ports: ProviderResolutionPorts,
  records: readonly ProviderResourceRecord[],
  attachments: readonly ProviderAttachmentRecord[],
): Promise<ResolutionFacts> => {
  if (records.length === 0) {
    return {
      credentials: new Map(),
      spaces: new Map(),
      users: new Map(),
      grants: new Map(),
      readableKeyIds: new Set(),
    }
  }
  const credentialIds = unique(
    records.flatMap((record) => (record.credentialId ? [record.credentialId] : [])),
  )
  const owners = unique(
    records.map((record) => record.owner).filter((owner) => owner !== AGENT_SYSTEM_OWNER),
  )
  const recordsById = mapBy(records, (record) => record.id)
  const attachmentOwners = unique(
    attachments
      .map((attachment) => recordsById.get(attachment.resourceId)?.owner)
      .filter((owner): owner is string => Boolean(owner) && owner !== AGENT_SYSTEM_OWNER),
  )
  const targetSpaces = unique(attachments.map((attachment) => attachment.targetSpace))
  const [credentials, spaces, users, grants] = await Promise.all([
    getMany(credentialIds, ports.credentials.getMany, (id) => ports.credentials.get(id)),
    getMany(targetSpaces, ports.spaces.getMany, (id) => ports.spaces.getById(id)),
    getMany(owners, ports.directory.getUsers, (owner) => ports.directory.getUser(owner)),
    ports.directory.grantsForUsers
      ? ports.directory.grantsForUsers(attachmentOwners)
      : Promise.all(
          attachmentOwners.map(async (owner) =>
            (await ports.directory.grantsFor(owner)).map((grant) => ({ owner, ...grant })),
          ),
        ).then((rows) => rows.flat()),
  ])
  const readableKeyIds = await ports.readableKeyIds(requiredKeyIdsOf(records, credentials))
  const grantsByOwner = new Map<string, Set<string>>()

  for (const grant of grants) {
    const owner = 'username' in grant ? grant.username : grant.owner
    const current = grantsByOwner.get(owner) ?? new Set<string>()
    current.add(grant.space)
    grantsByOwner.set(owner, current)
  }

  return {
    credentials: mapBy(credentials, (record) => record.id),
    spaces: mapBy(spaces, (record) => record.id),
    users: mapBy(users, (record) => record.username),
    grants: grantsByOwner,
    readableKeyIds,
  }
}

const recordInvalidityOf = (
  facts: ResolutionFacts,
  record: ProviderResourceRecord,
  credential: CredentialRecord | null,
): ProviderStatus | null =>
  providerRecordInvalidity({
    record,
    credential,
    ownerDisabled:
      record.owner === AGENT_SYSTEM_OWNER ||
      (facts.users.has(record.owner) && facts.users.get(record.owner)?.disabledAt === null)
        ? false
        : true,
    readableKeyIds: facts.readableKeyIds,
  })

/** Fold one more grant into the answer. A resource reachable by several grants is
 *  usable when ANY of them is intact; the reason survives only while none is. */
const merge = (
  entries: Map<string, ProviderResolutionEntry>,
  entry: ProviderResolutionEntry,
): void => {
  const seen = entries.get(entry.record.id)

  if (!seen) {
    entries.set(entry.record.id, entry)
    return
  }
  if (seen.unusableBecause !== null && entry.unusableBecause === null) {
    entries.set(entry.record.id, entry)
  }
}

const collectAttached = async (
  facts: ResolutionFacts,
  records: ReadonlyMap<string, ProviderResourceRecord>,
  entries: Map<string, ProviderResolutionEntry>,
  attachments: readonly ProviderAttachmentRecord[],
): Promise<void> => {
  for (const attachment of attachments) {
    if (!CONSENTED.has(attachment.state)) {
      continue
    }
    if (entries.get(attachment.resourceId)?.unusableBecause === null) {
      continue
    }
    const record = records.get(attachment.resourceId)

    if (!record) {
      continue
    }
    const credential = record.credentialId
      ? (facts.credentials.get(record.credentialId) ?? null)
      : null
    const unusableBecause =
      recordInvalidityOf(facts, record, credential) ??
      providerGrantInvalidity({
        attachment,
        record,
        credential,
        // Unknown is fail-closed, like archived.
        spaceIsArchived: facts.spaces.get(attachment.targetSpace)?.archivedAt !== null,
        ownerIsMember:
          record.owner === AGENT_SYSTEM_OWNER ||
          (facts.grants.get(record.owner)?.has(attachment.targetSpace) ?? false),
      })
    merge(entries, { record, unusableBecause })
  }
}

const resolvePrincipalCandidates = async (
  ports: ProviderResolutionPorts,
  input: { owner: string; spaces: readonly string[]; ids: readonly string[] },
): Promise<ProviderResolutionEntry[]> => {
  const loaded = await getMany(input.ids, ports.resources.getMany, (id) => ports.resources.get(id))
  const byId = mapBy(loaded, (record) => record.id)
  const records = input.ids.flatMap((id) => {
    const record = byId.get(id)
    return record ? [record] : []
  })
  const attachments = await ports.attachments.listForResourcesInSpaces(
    records.map(({ id }) => id),
    input.spaces,
  )
  const facts = await factsOf(ports, records, attachments)
  const entries = new Map<string, ProviderResolutionEntry>()

  for (const record of records) {
    if (record.owner !== input.owner) {
      continue
    }
    const credential = record.credentialId
      ? (facts.credentials.get(record.credentialId) ?? null)
      : null
    merge(entries, {
      record,
      unusableBecause: recordInvalidityOf(facts, record, credential),
    })
  }
  await collectAttached(facts, byId, entries, attachments)

  return input.ids.flatMap((id) => {
    const entry = entries.get(id)
    return entry ? [entry] : []
  })
}

/** Reconcile statuses for compact rows the caller already got from its owner-only
 * inventory. The explicit-id surface is bounded and batch-only: foreign rows are
 * discarded before their credentials or key ids can become facts, and no grant or
 * attachment query participates in an ownership status. */
export const resolveOwnedMany = async (
  ports: ProviderResolutionPorts,
  input: { owner: string; resourceIds: readonly string[] },
): Promise<ProviderResolutionEntry[]> => {
  const ids = unique(input.resourceIds)

  if (ids.length > PROVIDER_LIST_PAGE_SIZE) {
    throw new Error('provider owner status batch exceeds its limit')
  }
  if (ids.length === 0) {
    return []
  }
  if (!ports.resources.getMany || !ports.credentials.getMany) {
    throw new Error('provider owner status resolution requires batch persistence')
  }
  const loaded = await ports.resources.getMany(ids)
  const ownedById = mapBy(
    loaded.filter((record) => record.owner === input.owner),
    (record) => record.id,
  )
  const records = ids.flatMap((id) => {
    const record = ownedById.get(id)
    return record ? [record] : []
  })

  if (records.length === 0) {
    return []
  }
  const credentialIds = unique(
    records.flatMap((record) => (record.credentialId ? [record.credentialId] : [])),
  )
  const credentials = await ports.credentials.getMany(credentialIds)
  const credentialsById = mapBy(credentials, (record) => record.id)
  const owner =
    input.owner === AGENT_SYSTEM_OWNER ? null : await ports.directory.getUser(input.owner)
  const readableKeyIds = await ports.readableKeyIds(requiredKeyIdsOf(records, credentials))
  const ownerDisabled = input.owner !== AGENT_SYSTEM_OWNER && owner?.disabledAt !== null

  return records.map((record) => ({
    record,
    unusableBecause: providerRecordInvalidity({
      record,
      credential: record.credentialId ? (credentialsById.get(record.credentialId) ?? null) : null,
      ownerDisabled,
      readableKeyIds,
    }),
  }))
}

/** Route inventory page: select the authorized candidate ids before loading any
 *  resource/credential/grant detail, then hydrate only that bounded window. */
export const resolveForPrincipalPage = async (
  ports: ProviderResolutionPorts,
  input: { owner: string; spaces: readonly string[]; page: ProviderPageInput },
): Promise<ProviderResolutionPage> => {
  const page = await ports.resources.pageEffectiveIds(input.owner, input.spaces, input.page)
  const entries = await resolvePrincipalCandidates(ports, {
    owner: input.owner,
    spaces: input.spaces,
    ids: page.ids,
  })

  return {
    entries,
    total: page.total,
  }
}

/** Boolean MCP/existence read. It deliberately has no `total`: each keyset window
 *  selects one look-ahead row, hydrates at most the public page size, and stops at
 *  the first usable candidate without retaining earlier pages. */
export const hasUsableForPrincipal = async (
  ports: ProviderResolutionPorts,
  input: { owner: string; spaces: readonly string[] },
): Promise<boolean> => {
  let after: ProviderPagePosition | null = null

  for (;;) {
    const page = await ports.resources.scanEffectivePage(input.owner, input.spaces, {
      after,
      limit: HAS_USABLE_BATCH_SIZE,
    })

    if (page.positions.length === 0) {
      return false
    }
    const entries = await resolvePrincipalCandidates(ports, {
      owner: input.owner,
      spaces: input.spaces,
      ids: page.positions.map(({ id }) => id),
    })

    if (entries.some(({ unusableBecause }) => unusableBecause === null)) {
      return true
    }
    if (!page.hasMore) {
      return false
    }
    const next = page.positions.at(-1)!

    if (after && next.sort === after.sort && next.id === after.id) {
      throw new Error('provider effective candidate cursor did not advance')
    }
    after = next
  }
}

/** Exact inventory lookup for a mutation refresh. Foreign, pending-only and missing
 *  ids all collapse to null; only the one candidate and its grants are hydrated. */
export const resolveOneForPrincipal = async (
  ports: ProviderResolutionPorts,
  input: { owner: string; spaces: readonly string[]; resourceId: string },
): Promise<ProviderResolutionEntry | null> => {
  const record = await ports.resources.get(input.resourceId)

  if (!record) {
    return null
  }
  const attachments = await ports.attachments.listForResourcesInSpaces([record.id], input.spaces)
  const consented = attachments.filter((attachment) => CONSENTED.has(attachment.state))

  if (record.owner !== input.owner && consented.length === 0) {
    return null
  }
  const facts = await factsOf(ports, [record], consented)
  const entries = new Map<string, ProviderResolutionEntry>()

  if (record.owner === input.owner) {
    const credential = record.credentialId
      ? (facts.credentials.get(record.credentialId) ?? null)
      : null
    merge(entries, {
      record,
      unusableBecause: recordInvalidityOf(facts, record, credential),
    })
  }
  await collectAttached(facts, new Map([[record.id, record]]), entries, consented)
  return entries.get(record.id) ?? null
}

/** What everything WITHOUT an interactive principal picks from. Ownership is not a
 *  grant here — an unattached personal resource is not in this list even for the
 *  person who owns it, which is the whole reason the second list exists.
 *
 *  Addressed by Space: an attachment to a project grants the project's Space, so
 *  `targetSpace` is the one key both attachment kinds answer to. */
export const resolveForScope = async (
  ports: ProviderResolutionPorts,
  input: { space: string },
): Promise<ProviderResolutionEntry[]> => {
  const attachments = await attachmentsForSpaces(ports, [input.space])
  const resourceIds = unique(
    attachments
      .filter((attachment) => CONSENTED.has(attachment.state))
      .map((attachment) => attachment.resourceId),
  )
  const records = mapBy(
    await getMany(resourceIds, ports.resources.getMany, (id) => ports.resources.get(id)),
    (record) => record.id,
  )
  const facts = await factsOf(ports, [...records.values()], attachments)
  const entries = new Map<string, ProviderResolutionEntry>()
  await collectAttached(facts, records, entries, attachments)
  return [...entries.values()]
}
