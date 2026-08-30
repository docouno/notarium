import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CredentialKeyring } from './keyring'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'notarium-credential-keyring-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('credential keyring filesystem', () => {
  it('publishes immutable 0600 key files and one atomic active pointer', async () => {
    const keyring = new CredentialKeyring(join(root, 'keyring'), [])
    const candidate = await keyring.createCandidate()
    await keyring.installActive(1, candidate)

    const active = await keyring.readActive()
    expect(active).toMatchObject({
      keyId: candidate.keyId,
      hash: candidate.hash,
      generation: 1,
    })
    expect((await stat(join(keyring.keysDir, `${candidate.keyId}.json`))).mode & 0o777).toBe(0o600)
    expect((await stat(keyring.activePath)).mode & 0o777).toBe(0o600)
    expect((await stat(keyring.keysDir)).mode & 0o777).toBe(0o700)

    const reopened = new CredentialKeyring(keyring.root, [])
    await expect(reopened.readActive()).resolves.toMatchObject({
      keyId: candidate.keyId,
      generation: 1,
    })
  })

  it('derives a stable ck id and refuses replay-key ids', async () => {
    const keyring = new CredentialKeyring(join(root, 'keyring'), [])
    const candidate = await keyring.createCandidate()
    const reread = await keyring.readKey(candidate.keyId)

    expect(candidate.keyId).toMatch(/^ck_[0-9a-f]{24}$/)
    expect(reread?.keyId).toBe(candidate.keyId)
    await expect(keyring.readKey('rk_111111111111111111111111')).rejects.toThrow(
      /invalid credential key id/,
    )
  })

  it('rejects a key file changed after pointer publication', async () => {
    const keyring = new CredentialKeyring(join(root, 'keyring'), [])
    const candidate = await keyring.createCandidate()
    await keyring.installActive(1, candidate)
    const path = join(keyring.keysDir, `${candidate.keyId}.json`)
    const stored = JSON.parse(await readFile(path, 'utf8')) as { secret: string }
    stored.secret = Buffer.alloc(32, 0x55).toString('base64url')
    await writeFile(
      path,
      `${JSON.stringify({
        format: 'notarium-credential-key',
        formatVersion: 1,
        keyId: candidate.keyId,
        secret: stored.secret,
      })}\n`,
    )

    await expect(keyring.readActive()).rejects.toThrow(
      /id does not match its secret|hash does not match/,
    )
  })

  it('reads each required key once per call, touches no historical file, and retains no secret', async () => {
    const keyring = new CredentialKeyring(join(root, 'keyring'), [])
    const required = await keyring.createCandidate()
    const historical = await keyring.createCandidate()
    const reopened = new CredentialKeyring(keyring.root, [])
    const readKey = vi.spyOn(reopened, 'readKey')

    await expect(reopened.readableKeyIds(new Set([required.keyId]))).resolves.toEqual(
      new Set([required.keyId]),
    )
    expect(readKey).toHaveBeenCalledTimes(1)
    expect(readKey).toHaveBeenCalledWith(required.keyId)
    expect(readKey).not.toHaveBeenCalledWith(historical.keyId)
    await expect(reopened.readableKeyIds(new Set([required.keyId]))).resolves.toEqual(
      new Set([required.keyId]),
    )
    expect(readKey).toHaveBeenCalledTimes(2)
    expect(reopened).not.toHaveProperty('readabilityCache')
    expect(JSON.stringify(reopened)).not.toContain(required.secret.toString('base64url'))
    expect(JSON.stringify(reopened)).not.toContain(historical.secret.toString('base64url'))
    required.secret.fill(0)
    historical.secret.fill(0)
  })

  it('invalidates a warm verdict on delete, replacement, corruption, and symlink', async () => {
    const keyring = new CredentialKeyring(join(root, 'keyring'), [])
    const required = await keyring.createCandidate()
    const other = await keyring.createCandidate()
    const requiredPath = join(keyring.keysDir, `${required.keyId}.json`)
    const otherPath = join(keyring.keysDir, `${other.keyId}.json`)
    const requiredBytes = await readFile(requiredPath)
    const otherBytes = await readFile(otherPath)
    const ids = new Set([required.keyId])

    await expect(keyring.readableKeyIds(ids)).resolves.toEqual(ids)
    await writeFile(requiredPath, otherBytes)
    await expect(keyring.readableKeyIds(ids)).resolves.toEqual(new Set())

    await writeFile(requiredPath, requiredBytes)
    await expect(keyring.readableKeyIds(ids)).resolves.toEqual(ids)
    await rm(requiredPath)
    await expect(keyring.readableKeyIds(ids)).resolves.toEqual(new Set())

    await writeFile(requiredPath, 'not-json')
    await expect(keyring.readableKeyIds(ids)).resolves.toEqual(new Set())
    await rm(requiredPath)
    await symlink(otherPath, requiredPath)
    await expect(keyring.readableKeyIds(ids)).resolves.toEqual(new Set())
    required.secret.fill(0)
    other.secret.fill(0)
  })

  it('distinguishes complete loss from partial or unknown state', async () => {
    const missing = new CredentialKeyring(join(root, 'missing'), [])
    await expect(missing.isCompletelyLost()).resolves.toBe(true)

    await mkdir(missing.keysDir, { recursive: true })
    await expect(missing.isCompletelyLost()).resolves.toBe(true)
    await writeFile(join(missing.keysDir, 'partial'), 'state')
    await expect(missing.isCompletelyLost()).resolves.toBe(false)
  })

  it.each([
    { label: 'the keyring itself', suffix: '' },
    { label: 'its nearest existing parent', suffix: 'not-created-yet' },
  ])('refuses $label symlinked into a packed root before creating a key', async ({ suffix }) => {
    const packed = join(root, 'packed')
    const destination = join(packed, 'hidden')
    const alias = join(root, 'shared-keyring')
    await mkdir(destination, { recursive: true })
    await symlink(destination, alias, 'dir')
    const configured = suffix ? join(alias, suffix) : alias
    const keyring = new CredentialKeyring(configured, [packed])

    await expect(keyring.createCandidate()).rejects.toThrow(
      /real path must stay outside backup roots/,
    )
    expect(await readdir(destination)).toEqual([])
  })
})
