import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

import { type SecretFacet } from './consts'

const VERSION = 'v1'
const KEY_BYTES = 32
const KEY_ID_BYTES = 12
const NONCE_BYTES = 12
const TAG_BYTES = 16
const EMPTY_SALT = Buffer.alloc(0)
const ENCRYPTION_INFO = Buffer.from('notarium:secret:credential:v1')
const KEY_ID_INFO = Buffer.from('notarium:key-id:v1')
const CANARY_INFO = Buffer.from('notarium:canary:v1')
const KEY_ID = /^ck_[0-9a-f]{24}$/
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export type CredentialKeyMaterial = {
  keyId: string
  secret: Buffer
}

export type SecretAad = {
  facet: SecretFacet
  recordId: string
  field: string
}

const derive = (master: Uint8Array, info: Uint8Array, length: number): Buffer => {
  if (master.byteLength !== KEY_BYTES) {
    throw new Error('credential master key must contain exactly 32 bytes')
  }

  return Buffer.from(hkdfSync('sha256', master, EMPTY_SALT, info, length))
}

export const credentialKeyIdOf = (master: Uint8Array): string =>
  `ck_${derive(master, KEY_ID_INFO, KEY_ID_BYTES).toString('hex')}`

export const credentialCanaryOf = (master: Uint8Array): Buffer =>
  derive(master, CANARY_INFO, KEY_BYTES)

export const canonicalHeaderName = (name: string): string => {
  if (!HEADER_NAME.test(name)) {
    throw new Error('provider header name must be a non-empty RFC token')
  }

  return name.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

const segment = (name: string, value: string): string => {
  if (!value || value.includes('\0')) {
    throw new Error(`secret AAD ${name} must be non-empty and cannot contain NUL`)
  }

  return value
}

export const secretAad = (keyId: string, input: SecretAad): Buffer => {
  if (!KEY_ID.test(keyId)) {
    throw new Error(`invalid credential key id: ${keyId}`)
  }

  return Buffer.from(
    [
      VERSION,
      keyId,
      segment('facet', input.facet),
      segment('record id', input.recordId),
      segment('field', input.field),
    ].join('\0'),
  )
}

export const credentialEncryptionKeyOf = (master: Uint8Array): Buffer =>
  derive(master, ENCRYPTION_INFO, KEY_BYTES)

const parse = (serialized: string): { keyId: string; payload: Buffer } => {
  const [version, keyId, encoded, ...rest] = serialized.split('.')

  if (version !== VERSION) {
    throw new Error('unsupported credential envelope version')
  }
  if (!KEY_ID.test(keyId ?? '')) {
    throw new Error('credential envelope has an invalid key id')
  }
  if (!encoded || rest.length > 0) {
    throw new Error('credential envelope has an invalid shape')
  }
  const payload = Buffer.from(encoded, 'base64url')

  if (payload.length < NONCE_BYTES + TAG_BYTES || payload.toString('base64url') !== encoded) {
    throw new Error('credential envelope payload is invalid')
  }

  return { keyId, payload }
}

export class CredentialEnvelope {
  constructor(private readonly readKey: (keyId: string) => Promise<CredentialKeyMaterial | null>) {}

  encrypt(value: string, key: CredentialKeyMaterial, aad: SecretAad): string {
    if (!KEY_ID.test(key.keyId)) {
      throw new Error(`invalid credential key id: ${key.keyId}`)
    }
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', credentialEncryptionKeyOf(key.secret), nonce)
    cipher.setAAD(secretAad(key.keyId, aad))
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const payload = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()])
    return `${VERSION}.${key.keyId}.${payload.toString('base64url')}`
  }

  async decrypt(serialized: string, aad: SecretAad): Promise<string> {
    const { keyId, payload } = parse(serialized)
    const key = await this.readKey(keyId)

    if (!key) {
      throw new Error(`credential key is unavailable: ${keyId}`)
    }

    return this.decryptPayload(keyId, payload, key, aad)
  }

  /** One operation reads each referenced master-key file once. Live loss is
   *  still observed on every operation; only duplicate reads inside that
   *  operation are collapsed. */
  async decryptMany(values: ReadonlyArray<{ value: string; aad: SecretAad }>): Promise<string[]> {
    const keys = new Map<string, Promise<CredentialKeyMaterial | null>>()

    return Promise.all(
      values.map(async ({ value, aad }) => {
        const { keyId, payload } = parse(value)
        let key = keys.get(keyId)

        if (!key) {
          key = this.readKey(keyId)
          keys.set(keyId, key)
        }
        const material = await key

        if (!material) {
          throw new Error(`credential key is unavailable: ${keyId}`)
        }

        return this.decryptPayload(keyId, payload, material, aad)
      }),
    )
  }

  private decryptPayload(
    keyId: string,
    payload: Buffer,
    key: CredentialKeyMaterial,
    aad: SecretAad,
  ): string {
    const nonce = payload.subarray(0, NONCE_BYTES)
    const tag = payload.subarray(payload.length - TAG_BYTES)
    const ciphertext = payload.subarray(NONCE_BYTES, payload.length - TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', credentialEncryptionKeyOf(key.secret), nonce)
    decipher.setAAD(secretAad(keyId, aad))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  }
}
