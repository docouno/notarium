import { CREDENTIAL_KEY_STATE } from '../../packages/server/src/services/credentialKeyring/consts'
import type {
  CiphertextWrite,
  SecretKeyringPersistence,
  SecretKeyringRecord,
} from '../../packages/server/src/services/metaDb/types'

const copy = (record: SecretKeyringRecord): SecretKeyringRecord => ({ ...record })

const sameWitness = (left: SecretKeyringRecord, right: SecretKeyringRecord): boolean =>
  left.keyId === right.keyId &&
  left.canary === right.canary &&
  left.generation === right.generation &&
  left.createdAt === right.createdAt &&
  left.retiredAt === right.retiredAt

export class InMemorySecretKeyringPersistence implements SecretKeyringPersistence {
  private readonly records = new Map<string, SecretKeyringRecord>()

  async init(): Promise<void> {}

  async list(): Promise<SecretKeyringRecord[]> {
    return [...this.records.values()].sort((a, b) => a.generation - b.generation).map(copy)
  }

  async active(): Promise<SecretKeyringRecord[]> {
    return (await this.list()).filter(
      (record) => record.state === CREDENTIAL_KEY_STATE.active && !record.retiredAt,
    )
  }

  async admitReadable(record: SecretKeyringRecord) {
    const byKey = this.records.get(record.keyId)
    const byGeneration = [...this.records.values()].find(
      (candidate) => candidate.generation === record.generation,
    )

    if (byKey && sameWitness(byKey, record)) {
      return { status: 'present' as const, record: copy(byKey) }
    }
    if (byKey || byGeneration) {
      return { status: 'conflict' as const }
    }
    const inserted = { ...record, state: CREDENTIAL_KEY_STATE.readable }
    this.records.set(inserted.keyId, inserted)
    return { status: 'inserted' as const, record: copy(inserted) }
  }

  async projectActive({ keyId, generation }: { keyId: string; generation: number }) {
    const target = this.records.get(keyId)

    if (!target) {
      return { status: 'missing' as const }
    }
    if (target.retiredAt) {
      return { status: 'retired' as const, record: copy(target) }
    }
    if (target.generation !== generation) {
      return { status: 'generation-conflict' as const, record: copy(target) }
    }
    for (const [id, record] of this.records) {
      if (!record.retiredAt) {
        this.records.set(id, {
          ...record,
          state: id === keyId ? CREDENTIAL_KEY_STATE.active : CREDENTIAL_KEY_STATE.readable,
        })
      }
    }

    return { status: 'projected' as const, record: copy(this.records.get(keyId)!) }
  }

  async projectRotationActive(
    {
      expectedKeyId,
      keyId,
      generation,
    }: { expectedKeyId: string; keyId: string; generation: number },
    publishPointer: () => Promise<void>,
  ) {
    const active = this.activeWrite()

    if (active?.keyId !== expectedKeyId) {
      return { status: 'active-changed' as const, activeKeyId: active?.keyId ?? null }
    }
    const target = this.records.get(keyId)

    if (!target) {
      return { status: 'missing' as const }
    }
    if (target.retiredAt) {
      return { status: 'retired' as const, record: copy(target) }
    }
    if (target.generation !== generation) {
      return { status: 'generation-conflict' as const, record: copy(target) }
    }
    await publishPointer()
    await this.projectActive({ keyId, generation })
    return { status: 'projected' as const, record: copy(this.records.get(keyId)!) }
  }

  async replaceNonRetiredWith(record: SecretKeyringRecord): Promise<void> {
    for (const [id, current] of this.records) {
      if (!current.retiredAt) {
        this.records.delete(id)
      }
    }
    this.records.set(record.keyId, {
      ...copy(record),
      state: CREDENTIAL_KEY_STATE.active,
      retiredAt: null,
    })
  }

  activeWrite(): CiphertextWrite | null {
    const active = [...this.records.values()].find(
      (record) => record.state === CREDENTIAL_KEY_STATE.active && !record.retiredAt,
    )
    return active ? { keyId: active.keyId, generation: active.generation } : null
  }

  retireKeys(keyIds: ReadonlySet<string>, retiredAt: string): string[] {
    const retired: string[] = []

    for (const keyId of [...keyIds].sort()) {
      const record = this.records.get(keyId)

      if (!record || record.retiredAt || record.state === CREDENTIAL_KEY_STATE.active) {
        continue
      }
      this.records.set(keyId, { ...record, retiredAt })
      retired.push(keyId)
    }

    return retired
  }
}
