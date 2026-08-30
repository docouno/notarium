import { describe, expect, it, vi } from 'vitest'

import { SECRET_FACET } from './consts'
import {
  canonicalHeaderName,
  credentialCanaryOf,
  credentialEncryptionKeyOf,
  CredentialEnvelope,
  credentialKeyIdOf,
  secretAad,
} from './envelope'

const master = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
const key = { keyId: credentialKeyIdOf(master), secret: master }
const credentialAad = {
  facet: SECRET_FACET.credential,
  recordId: 'cred_alpha',
  field: 'secret',
} as const

describe('credential envelope', () => {
  it('freezes all three empty-salt HKDF derivations with golden vectors', () => {
    expect(credentialEncryptionKeyOf(master).toString('hex')).toBe(
      '3ebe595b2382f8cc22cd8812c680e381b075438221fd5f860014a16c7915d670',
    )
    expect(key.keyId).toBe('ck_6cec1c7707250abbc703cfcd')
    expect(credentialCanaryOf(master).toString('hex')).toBe(
      'cde990f491579d18560dda7897d02de3f053de506704300d38ef7322c87a6422',
    )
  })

  it('refuses a master key of any other width', () => {
    expect(() => credentialKeyIdOf(Buffer.alloc(31))).toThrow(/exactly 32 bytes/)
    expect(() => credentialCanaryOf(Buffer.alloc(33))).toThrow(/exactly 32 bytes/)
  })

  it('round-trips with the same key and mandatory AAD', async () => {
    const envelope = new CredentialEnvelope(async (keyId) => (keyId === key.keyId ? key : null))
    const encrypted = envelope.encrypt('sk-live-secret', key, credentialAad)

    expect(encrypted).toMatch(/^v1\.ck_[0-9a-f]{24}\.[A-Za-z0-9_-]+$/)
    await expect(envelope.decrypt(encrypted, credentialAad)).resolves.toBe('sk-live-secret')
    expect(encrypted).not.toContain('sk-live-secret')
  })

  it('round-trips an empty value instead of rejecting its nonce-plus-tag payload', async () => {
    const envelope = new CredentialEnvelope(async () => key)
    const encrypted = envelope.encrypt('', key, credentialAad)

    await expect(envelope.decrypt(encrypted, credentialAad)).resolves.toBe('')
  })

  it('reads one key once for a whole operation batch', async () => {
    const readKey = vi.fn(async () => key)
    const envelope = new CredentialEnvelope(readKey)
    const values = Array.from({ length: 33 }, (_, index) => {
      const aad = { ...credentialAad, field: `field-${index}` }
      return { value: envelope.encrypt(`secret-${index}`, key, aad), aad }
    })

    await expect(envelope.decryptMany(values)).resolves.toEqual(
      Array.from({ length: 33 }, (_, index) => `secret-${index}`),
    )
    expect(readKey).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      label: 'another record',
      aad: { ...credentialAad, recordId: 'cred_beta' },
    },
    {
      label: 'another field',
      aad: { ...credentialAad, field: 'secondary' },
    },
    {
      label: 'another facet',
      aad: { ...credentialAad, facet: SECRET_FACET.resource },
    },
  ])('rejects ciphertext moved to $label', async ({ aad }) => {
    const envelope = new CredentialEnvelope(async () => key)
    const encrypted = envelope.encrypt('secret', key, credentialAad)

    await expect(envelope.decrypt(encrypted, aad)).rejects.toThrow()
  })

  it('binds the key id inside AAD even when the key material is unchanged', async () => {
    const otherKeyId = 'ck_ffffffffffffffffffffffff'
    const envelope = new CredentialEnvelope(async (keyId) => ({
      keyId,
      secret: master,
    }))
    const encrypted = envelope.encrypt('secret', key, credentialAad)
    const withOtherPrefix = encrypted.replace(key.keyId, otherKeyId)

    await expect(envelope.decrypt(withOtherPrefix, credentialAad)).rejects.toThrow()
    expect(secretAad(key.keyId, credentialAad)).not.toEqual(secretAad(otherKeyId, credentialAad))
  })

  it('rejects an unknown version before consulting the keyring', async () => {
    const readKey = vi.fn(async () => key)
    const envelope = new CredentialEnvelope(readKey)

    await expect(
      envelope.decrypt('v2.ck_111111111111111111111111.YWJj', credentialAad),
    ).rejects.toThrow(/unsupported credential envelope version/)
    expect(readKey).not.toHaveBeenCalled()
  })

  it('never treats plaintext or an unversioned payload as a legacy envelope', async () => {
    const envelope = new CredentialEnvelope(async () => key)
    let plaintextError: Error | undefined

    try {
      await envelope.decrypt('sk-live-plaintext', credentialAad)
    } catch (error) {
      plaintextError = error as Error
    }
    expect(plaintextError?.message).toBe('unsupported credential envelope version')
    expect(plaintextError?.message).not.toContain('sk-live-plaintext')
    await expect(envelope.decrypt(`${key.keyId}.YWJj`, credentialAad)).rejects.toThrow(
      /unsupported credential envelope version/,
    )
  })

  it('canonicalizes RFC header tokens and refuses ambiguous or invalid names', () => {
    expect(canonicalHeaderName('X-Api-Key')).toBe('x-api-key')
    expect(canonicalHeaderName('x_custom~header')).toBe('x_custom~header')
    expect(() => canonicalHeaderName('bad header')).toThrow(/RFC token/)
    expect(() => canonicalHeaderName('')).toThrow(/RFC token/)
  })

  it('makes AAD a compile-time requirement', () => {
    const envelope = new CredentialEnvelope(async () => key)

    const callWithoutAad = () => {
      // @ts-expect-error The immutable format must never admit an AAD-less call.
      envelope.encrypt('secret', key)
    }

    expect(callWithoutAad).toBeTypeOf('function')
  })
})
