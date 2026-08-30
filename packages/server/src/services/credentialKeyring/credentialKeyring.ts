import { timingSafeEqual } from 'node:crypto'

import { CREDENTIAL_KEYRING_STATUS } from '@notarium/contract'

import type {
  ProviderCiphertextCarrier,
  ProviderCiphertextCounts,
  ProviderCiphertextsPersistence,
  SecretKeyringPersistence,
  SecretKeyringRecord,
} from '../metaDb'
import { CREDENTIAL_KEY_STATE, SECRET_FACET } from './consts'
import { credentialCanaryOf, CredentialEnvelope, type SecretAad } from './envelope'
import { CredentialSecretsUnreadableError } from './errors'
import type { ActiveCredentialKey, CredentialKeyring, StoredCredentialKeyMaterial } from './keyring'
import { type CredentialKeyringDiagnostic, type UnreadableSecretPlan } from './types'

const MAX_BOOTSTRAP_STEPS = 16
const DEFAULT_ROTATION_BATCH_SIZE = 100

export type CredentialKeyringServiceOptions = {
  persistence: SecretKeyringPersistence
  keyring: CredentialKeyring
  ciphertexts: ProviderCiphertextsPersistence
  now?: () => Date
}

export type EncryptedSecret = {
  ciphertext: string
  keyId: string
  generation: number
}

export type CredentialKeyRotationResult = {
  applied: boolean
  activeKeyId: string
  sourceKeyIds: string[]
  references: ProviderCiphertextCounts
  rewrapped: ProviderCiphertextCounts
  retiredKeyIds: string[]
}

const unreadable = (message: string): CredentialSecretsUnreadableError =>
  new CredentialSecretsUnreadableError(
    `credential keyring is unreadable: ${message}. Restore the matching secret-keyring, or stop every serving process and use the credential-keyring admin recovery commands`,
  )

export class CredentialKeyringService {
  readonly diagnostic: CredentialKeyringDiagnostic = {
    status: CREDENTIAL_KEYRING_STATUS.ready,
  }

  private readonly persistence: SecretKeyringPersistence
  private readonly keyring: CredentialKeyring
  private readonly ciphertexts: ProviderCiphertextsPersistence
  private readonly now: () => Date
  private readonly envelope: CredentialEnvelope
  private cached: ActiveCredentialKey | null = null
  private lastError: string | null = null

  constructor(options: CredentialKeyringServiceOptions) {
    this.persistence = options.persistence
    this.keyring = options.keyring
    this.ciphertexts = options.ciphertexts
    this.now = options.now ?? (() => new Date())
    this.envelope = new CredentialEnvelope(async (keyId) => this.keyring.readKey(keyId))
  }

  errorMessage(): string | null {
    return this.lastError
  }

  async encrypt(value: string, aad: SecretAad): Promise<EncryptedSecret> {
    const active = await this.activeForWrite()

    if (!active) {
      throw unreadable(this.lastError ?? 'no active key is available')
    }

    return {
      ciphertext: this.envelope.encrypt(value, active, aad),
      keyId: active.keyId,
      generation: active.generation,
    }
  }

  async encryptMany(
    values: ReadonlyArray<{ value: string; aad: SecretAad }>,
  ): Promise<EncryptedSecret[]> {
    const active = await this.activeForWrite()

    if (!active) {
      throw unreadable(this.lastError ?? 'no active key is available')
    }

    return values.map(({ value, aad }) => ({
      ciphertext: this.envelope.encrypt(value, active, aad),
      keyId: active.keyId,
      generation: active.generation,
    }))
  }

  decrypt(value: string, aad: SecretAad): Promise<string> {
    return this.envelope.decrypt(value, aad)
  }

  decryptMany(values: ReadonlyArray<{ value: string; aad: SecretAad }>): Promise<string[]> {
    return this.envelope.decryptMany(values)
  }

  async bootstrap(): Promise<ActiveCredentialKey | null> {
    try {
      await this.persistence.init()
      await this.keyring.assertWritable()

      for (let step = 0; step < MAX_BOOTSTRAP_STEPS; step += 1) {
        const rows = await this.persistence.list()
        const hasCiphertext = await this.ciphertexts.hasCiphertext()
        const active = hasCiphertext
          ? await this.bootstrapProtected(rows)
          : await this.bootstrapEmpty(rows)

        if (!active) {
          continue
        }
        this.cached = active
        this.lastError = null
        this.diagnostic.status = CREDENTIAL_KEYRING_STATUS.ready
        return active
      }

      throw new Error('credential keyring bootstrap did not converge')
    } catch (error) {
      if (!(error instanceof CredentialSecretsUnreadableError)) {
        throw error
      }
      this.cached = null
      this.lastError = error.message
      this.diagnostic.status = CREDENTIAL_KEYRING_STATUS.unreadable
      return null
    }
  }

  /** Live readability for only the key ids the current candidate rows reference.
   *  The filesystem owner keeps no cross-request readability or secret cache; each
   *  call reads every required distinct key once and observes delete/replace live. */
  readableKeyIds(requiredKeyIds: ReadonlySet<string>): Promise<ReadonlySet<string>> {
    return this.keyring.readableKeyIds(requiredKeyIds)
  }

  async refreshActive(): Promise<ActiveCredentialKey> {
    this.cached = null
    const active = await this.bootstrap()

    if (!active) {
      throw unreadable(this.lastError ?? 'no active key is available')
    }

    return active
  }

  async rotate(input: {
    expectedKeyId: string
    apply: boolean
    batchSize?: number
  }): Promise<CredentialKeyRotationResult> {
    const batchSize = input.batchSize ?? DEFAULT_ROTATION_BATCH_SIZE

    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new Error('credential key rotation batch size must be a positive safe integer')
    }
    let active: ActiveCredentialKey
    let rows: SecretKeyringRecord[]

    if (input.apply) {
      active = await this.refreshActive()
      rows = await this.persistence.list()
    } else {
      ;({ active, rows } = await this.inspectRotation(input.expectedKeyId))
    }
    if (active.keyId !== input.expectedKeyId) {
      throw unreadable(
        `expected key id ${input.expectedKeyId}, active pointer names ${active.keyId}`,
      )
    }
    const candidates = rows
      .filter((row) => !row.retiredAt && row.generation > active.generation)
      .sort((left, right) => left.generation - right.generation)

    if (candidates.length > 1) {
      throw unreadable('multiple unpublished rotation candidates need operator inspection')
    }
    const continuingSources = rows
      .filter((row) => !row.retiredAt && row.keyId !== active.keyId)
      .sort((left, right) => left.generation - right.generation)
    const dryRunSources = candidates.length
      ? rows.filter((row) => !row.retiredAt && row.keyId !== candidates[0].keyId)
      : continuingSources.length
        ? continuingSources
        : rows.filter((row) => !row.retiredAt && row.keyId === active.keyId)
    const dryRunSourceIds = dryRunSources.map((row) => row.keyId).sort()
    const dryRunReferences = await this.ciphertexts.countReferences(new Set(dryRunSourceIds))

    if (!input.apply) {
      return {
        applied: false,
        activeKeyId: active.keyId,
        sourceKeyIds: dryRunSourceIds,
        references: dryRunReferences,
        rewrapped: { credentials: 0, headers: 0 },
        retiredKeyIds: [],
      }
    }
    if (candidates.length) {
      active = await this.activateRotationCandidate(active, candidates[0])
    } else if (!continuingSources.length) {
      active = await this.createRotationCandidate(active, rows)
    }
    rows = await this.persistence.list()
    const sourceKeyIds = rows
      .filter((row) => !row.retiredAt && row.keyId !== active.keyId)
      .map((row) => row.keyId)
      .sort()
    const sources = new Set(sourceKeyIds)
    const references = await this.ciphertexts.countReferences(sources)
    const rewrapped = { credentials: 0, headers: 0 }

    while (sourceKeyIds.length > 0) {
      const batch = await this.ciphertexts.rewrapBatch({
        active,
        sourceKeyIds: sources,
        limit: batchSize,
        rewrap: (carrier) => this.rewrapCarrier(carrier, active),
      })
      rewrapped.credentials += batch.rewrapped.credentials
      rewrapped.headers += batch.rewrapped.headers

      if (batch.rewrapped.credentials === 0 && batch.rewrapped.headers === 0) {
        break
      }
    }
    const retired = await this.ciphertexts.retireKeys({
      active,
      sourceKeyIds: sources,
      retiredAt: this.now().toISOString(),
    })

    if (retired.status === 'references-remain') {
      throw unreadable(
        `cannot retire credential keys; ${retired.references.credentials} credential and ${retired.references.headers} header references remain`,
      )
    }
    this.cached = active
    return {
      applied: true,
      activeKeyId: active.keyId,
      sourceKeyIds,
      references,
      rewrapped,
      retiredKeyIds: retired.retiredKeyIds,
    }
  }

  async reconcileHistorical(input: {
    expectedKeyId: string
    apply: boolean
  }): Promise<{ applied: boolean; active: SecretKeyringRecord }> {
    await this.persistence.init()
    await this.keyring.assertWritable()
    const activeRows = await this.persistence.active()

    if (activeRows.length !== 1) {
      throw unreadable('historical reconciliation requires exactly one active DB projection')
    }
    const active = activeRows[0]

    if (active.keyId !== input.expectedKeyId) {
      throw unreadable(`expected key id ${input.expectedKeyId}, database names ${active.keyId}`)
    }
    const key = await this.keyring.readKey(active.keyId)

    if (!key) {
      throw unreadable(`database-active key file is missing: ${active.keyId}`)
    }
    await this.assertCanary(active, key)

    if (input.apply) {
      await this.keyring.installActive(active.generation, key)
      const projected = await this.persistence.projectActive({
        keyId: active.keyId,
        generation: active.generation,
      })

      if (projected.status !== 'projected') {
        throw unreadable(`database-active key changed during reconciliation (${projected.status})`)
      }
      this.cached = { ...key, generation: active.generation }
      this.lastError = null
      this.diagnostic.status = CREDENTIAL_KEYRING_STATUS.ready
    }

    return { applied: input.apply, active }
  }

  async purgeUnreadable(input: { expectedKeyId: string; apply: boolean }): Promise<{
    applied: boolean
    previousKeyId: string
    activeKeyId?: string
    plan: UnreadableSecretPlan
  }> {
    await this.persistence.init()
    const activeRows = await this.persistence.active()

    if (activeRows.length !== 1) {
      throw unreadable('complete-loss recovery requires exactly one active DB projection')
    }
    const active = activeRows[0]

    if (active.keyId !== input.expectedKeyId) {
      throw unreadable(`expected key id ${input.expectedKeyId}, database names ${active.keyId}`)
    }
    if (!(await this.keyring.isCompletelyLost())) {
      throw unreadable('complete-loss recovery requires a completely missing keyring')
    }
    const plan = await this.ciphertexts.previewUnreadable(new Set())

    if (!input.apply) {
      return { applied: false, previousKeyId: active.keyId, plan }
    }
    const appliedPlan = await this.ciphertexts.purgeUnreadable(new Set(), this.now().toISOString())
    const replacement = await this.bootstrap()

    if (!replacement) {
      throw unreadable(this.lastError ?? 'replacement key could not be initialized')
    }

    return {
      applied: true,
      previousKeyId: active.keyId,
      activeKeyId: replacement.keyId,
      plan: appliedPlan,
    }
  }

  private async bootstrapEmpty(rows: SecretKeyringRecord[]): Promise<ActiveCredentialKey | null> {
    let pointer: ActiveCredentialKey | null = null

    try {
      pointer = await this.keyring.readActive()
    } catch {
      // With no ciphertext the pointer carries no user data authority. A new
      // witnessed key replaces corrupt pointer state instead of making the warning eternal.
    }

    if (pointer) {
      const existing = rows.find((row) => row.keyId === pointer!.keyId)

      if (!existing?.retiredAt) {
        const record = this.recordFor(
          pointer,
          pointer.generation,
          existing?.createdAt ?? this.now().toISOString(),
          CREDENTIAL_KEY_STATE.active,
        )
        await this.persistence.replaceNonRetiredWith(record)
        return pointer
      }
    }

    for (const row of [...rows].sort((a, b) => b.generation - a.generation)) {
      if (row.retiredAt) {
        continue
      }
      const key = await this.keyring.readKey(row.keyId).catch(() => null)

      if (!key || !(await this.canaryMatches(row, key))) {
        continue
      }
      await this.keyring.installActive(row.generation, key)
      await this.persistence.replaceNonRetiredWith({
        ...row,
        state: CREDENTIAL_KEY_STATE.active,
      })
      return { ...key, generation: row.generation }
    }

    const generation = rows.reduce((maximum, row) => Math.max(maximum, row.generation), 0) + 1
    const candidate = await this.keyring.createCandidate()
    const record = this.recordFor(
      candidate,
      generation,
      this.now().toISOString(),
      CREDENTIAL_KEY_STATE.readable,
    )
    const admitted = await this.persistence.admitReadable(record)

    if (admitted.status === 'conflict') {
      return null
    }
    await this.keyring.installActive(generation, candidate)
    await this.persistence.replaceNonRetiredWith({
      ...record,
      state: CREDENTIAL_KEY_STATE.active,
    })
    return { ...candidate, generation }
  }

  private async activeForWrite(): Promise<ActiveCredentialKey | null> {
    const pointer = await this.keyring.readActive()

    if (pointer && this.cached?.keyId !== pointer.keyId) {
      this.cached = pointer
    }

    return pointer ?? this.bootstrap()
  }

  private async inspectRotation(
    expectedKeyId: string,
  ): Promise<{ active: ActiveCredentialKey; rows: SecretKeyringRecord[] }> {
    await this.persistence.init()
    let active: ActiveCredentialKey | null
    let rows: SecretKeyringRecord[]

    try {
      ;[active, rows] = await Promise.all([this.keyring.readActive(), this.persistence.list()])
    } catch (error) {
      throw unreadable((error as Error).message)
    }
    if (!active) {
      throw unreadable('the active pointer is missing')
    }
    if (active.keyId !== expectedKeyId) {
      throw unreadable(`expected key id ${expectedKeyId}, active pointer names ${active.keyId}`)
    }
    const target = rows.find((row) => row.keyId === active.keyId)

    if (!target) {
      throw unreadable(`active pointer has no durable DB witness: ${active.keyId}`)
    }
    if (target.retiredAt) {
      throw unreadable(`active pointer names a retired key: ${target.keyId}`)
    }
    if (target.generation !== active.generation) {
      throw unreadable(
        `active pointer generation ${active.generation} disagrees with database generation ${target.generation}`,
      )
    }
    for (const row of rows.filter((candidate) => !candidate.retiredAt)) {
      let key: StoredCredentialKeyMaterial | null

      try {
        key = await this.keyring.readKey(row.keyId)
      } catch (error) {
        throw unreadable((error as Error).message)
      }
      if (!key) {
        throw unreadable(`non-retired key file is missing: ${row.keyId}`)
      }
    }
    await this.assertCanary(target, active)
    return { active, rows }
  }

  private async createRotationCandidate(
    active: ActiveCredentialKey,
    rows: SecretKeyringRecord[],
  ): Promise<ActiveCredentialKey> {
    const generation = rows.reduce((maximum, row) => Math.max(maximum, row.generation), 0) + 1
    const candidate = await this.keyring.createCandidate()
    const record = this.recordFor(
      candidate,
      generation,
      this.now().toISOString(),
      CREDENTIAL_KEY_STATE.readable,
    )
    const admitted = await this.persistence.admitReadable(record)

    if (admitted.status === 'conflict') {
      throw unreadable('rotation candidate changed concurrently; rerun the dry-run')
    }

    return this.activateRotationCandidate(active, admitted.record)
  }

  private async activateRotationCandidate(
    current: ActiveCredentialKey,
    record: SecretKeyringRecord,
  ): Promise<ActiveCredentialKey> {
    const candidate = await this.keyring.readKey(record.keyId)

    if (!candidate) {
      throw unreadable(`rotation candidate key file is missing: ${record.keyId}`)
    }
    await this.assertCanary(record, candidate)

    try {
      const projected = await this.persistence.projectRotationActive(
        {
          expectedKeyId: current.keyId,
          keyId: record.keyId,
          generation: record.generation,
        },
        () => this.keyring.installActive(record.generation, candidate),
      )

      if (projected.status !== 'projected') {
        throw unreadable(`credential rotation target could not become active (${projected.status})`)
      }
    } catch (error) {
      const pointer = await this.keyring.readActive().catch(() => null)

      if (pointer?.keyId !== record.keyId) {
        throw error
      }
      const converged = await this.bootstrap()

      if (converged?.keyId !== record.keyId) {
        throw error
      }

      return converged
    }
    const active = { ...candidate, generation: record.generation }
    this.cached = active
    return active
  }

  private async rewrapCarrier(
    carrier: ProviderCiphertextCarrier,
    active: ActiveCredentialKey,
  ): Promise<string> {
    const aad: SecretAad = {
      facet: carrier.kind === 'credential' ? SECRET_FACET.credential : SECRET_FACET.resource,
      recordId: carrier.recordId,
      field: carrier.field,
    }
    const plaintext = await this.envelope.decrypt(carrier.ciphertext, aad)
    return this.envelope.encrypt(plaintext, active, aad)
  }

  private async bootstrapProtected(rows: SecretKeyringRecord[]): Promise<ActiveCredentialKey> {
    let pointer: ActiveCredentialKey | null
    let files: StoredCredentialKeyMaterial[]

    try {
      ;[pointer, files] = await Promise.all([this.keyring.readActive(), this.keyring.listKeys()])
    } catch (error) {
      throw unreadable((error as Error).message)
    }

    if (!pointer) {
      throw unreadable('the active pointer is missing while ciphertext exists')
    }
    const filesById = new Map(files.map((key) => [key.keyId, key]))

    for (const row of rows.filter((candidate) => !candidate.retiredAt)) {
      if (!filesById.has(row.keyId)) {
        throw unreadable(`non-retired key file is missing: ${row.keyId}`)
      }
    }
    const target = rows.find((row) => row.keyId === pointer!.keyId)

    if (!target) {
      const active = rows.filter(
        (row) => row.state === CREDENTIAL_KEY_STATE.active && !row.retiredAt,
      )
      const hint =
        active.length === 1
          ? `; database names ${active[0].keyId} active — run reconcile-credential-keyring --expected-key-id ${active[0].keyId}`
          : ''
      throw unreadable(`active pointer has no durable DB witness: ${pointer.keyId}${hint}`)
    }
    if (target.retiredAt) {
      throw unreadable(`active pointer names a retired key: ${target.keyId}`)
    }
    if (target.generation !== pointer.generation) {
      throw unreadable(
        `active pointer generation ${pointer.generation} disagrees with database generation ${target.generation}`,
      )
    }
    const projected = await this.persistence.projectActive({
      keyId: pointer.keyId,
      generation: pointer.generation,
    })

    if (projected.status !== 'projected') {
      throw unreadable(`active DB projection failed: ${projected.status}`)
    }
    await this.assertCanary(projected.record, pointer)
    return pointer
  }

  private recordFor(
    key: StoredCredentialKeyMaterial,
    generation: number,
    createdAt: string,
    state: SecretKeyringRecord['state'],
  ): SecretKeyringRecord {
    return {
      keyId: key.keyId,
      canary: this.envelope.encrypt(credentialCanaryOf(key.secret).toString('base64url'), key, {
        facet: SECRET_FACET.keyring,
        recordId: key.keyId,
        field: 'canary',
      }),
      state,
      generation,
      createdAt,
      retiredAt: null,
    }
  }

  private async canaryMatches(
    record: SecretKeyringRecord,
    key: StoredCredentialKeyMaterial,
  ): Promise<boolean> {
    try {
      await this.assertCanary(record, key)
      return true
    } catch {
      return false
    }
  }

  private async assertCanary(
    record: SecretKeyringRecord,
    key: StoredCredentialKeyMaterial,
  ): Promise<void> {
    let actual: string

    try {
      actual = await this.envelope.decrypt(record.canary, {
        facet: SECRET_FACET.keyring,
        recordId: record.keyId,
        field: 'canary',
      })
    } catch (error) {
      throw unreadable(
        `canary authentication failed for ${record.keyId}: ${(error as Error).message}`,
      )
    }
    const actualBytes = Buffer.from(actual)
    const expected = Buffer.from(credentialCanaryOf(key.secret).toString('base64url'))

    if (actualBytes.length !== expected.length || !timingSafeEqual(actualBytes, expected)) {
      throw unreadable(`canary value does not match key ${record.keyId}`)
    }
  }
}
