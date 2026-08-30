import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { credentialKeyIdOf, type CredentialKeyMaterial } from './envelope'

const KEY_FORMAT = 'notarium-credential-key'
const POINTER_FORMAT = 'notarium-credential-key-pointer'
const FORMAT_VERSION = 1
const KEY_BYTES = 32
const KEY_ID = /^ck_[0-9a-f]{24}$/

type StoredCredentialKey = {
  format: typeof KEY_FORMAT
  formatVersion: typeof FORMAT_VERSION
  keyId: string
  secret: string
}

type ActivePointer = {
  format: typeof POINTER_FORMAT
  formatVersion: typeof FORMAT_VERSION
  generation: number
  keyId: string
  keyHash: string
}

export type StoredCredentialKeyMaterial = CredentialKeyMaterial & {
  hash: string
}

export type ActiveCredentialKey = StoredCredentialKeyMaterial & {
  generation: number
}

const serialize = (value: object): Buffer => Buffer.from(`${JSON.stringify(value)}\n`)
const sha256 = (value: Uint8Array): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, constants.O_RDONLY)

  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const readOptional = async (path: string): Promise<Buffer | null> => {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

const resolvedThroughExistingAncestor = async (path: string): Promise<string> => {
  const suffix: string[] = []
  let cursor = resolve(path)

  while (true) {
    try {
      return resolve(await realpath(cursor), ...suffix.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      const parent = dirname(cursor)

      if (parent === cursor) {
        throw error
      }
      suffix.push(basename(cursor))
      cursor = parent
    }
  }
}

const under = (path: string, root: string): boolean => path === root || path.startsWith(root + sep)

const parseKey = (bytes: Buffer, path: string): StoredCredentialKeyMaterial => {
  let value: unknown

  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`credential key is corrupt: ${path}`)
  }
  const key = value as Partial<StoredCredentialKey>

  if (
    key.format !== KEY_FORMAT ||
    key.formatVersion !== FORMAT_VERSION ||
    typeof key.keyId !== 'string' ||
    typeof key.secret !== 'string'
  ) {
    throw new Error(`credential key has an unsupported shape: ${path}`)
  }
  const secret = Buffer.from(key.secret, 'base64url')

  if (secret.length !== KEY_BYTES || secret.toString('base64url') !== key.secret) {
    throw new Error(`credential key secret is invalid: ${path}`)
  }
  if (credentialKeyIdOf(secret) !== key.keyId) {
    throw new Error(`credential key id does not match its secret: ${path}`)
  }

  return { keyId: key.keyId, hash: sha256(bytes), secret }
}

const parsePointer = (bytes: Buffer, path: string): ActivePointer => {
  let value: unknown

  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`active credential key pointer is corrupt: ${path}`)
  }
  const pointer = value as Partial<ActivePointer>

  if (
    pointer.format !== POINTER_FORMAT ||
    pointer.formatVersion !== FORMAT_VERSION ||
    !Number.isSafeInteger(pointer.generation) ||
    (pointer.generation ?? 0) < 1 ||
    typeof pointer.keyId !== 'string' ||
    !KEY_ID.test(pointer.keyId) ||
    typeof pointer.keyHash !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(pointer.keyHash)
  ) {
    throw new Error(`active credential key pointer has an unsupported shape: ${path}`)
  }

  return pointer as ActivePointer
}

export class CredentialKeyring {
  readonly root: string
  readonly keysDir: string
  readonly activePath: string

  private readonly packedRoots: readonly string[]
  constructor(root: string, packedRoots: readonly string[]) {
    this.root = root
    this.keysDir = join(root, 'keys')
    this.activePath = join(root, 'active.json')
    this.packedRoots = packedRoots
  }

  async init(): Promise<void> {
    const [actual, ...packedRoots] = await Promise.all([
      resolvedThroughExistingAncestor(this.root),
      ...this.packedRoots.map(resolvedThroughExistingAncestor),
    ])
    const packedRoot = packedRoots.find((root) => under(actual, root))

    if (packedRoot) {
      throw new Error(
        `credential keyring real path must stay outside backup roots: ${actual} is inside ${packedRoot}`,
      )
    }
    await mkdir(this.keysDir, { recursive: true, mode: 0o700 })
  }

  async assertWritable(): Promise<void> {
    await this.init()
    const probe = join(this.root, `.write-probe-${randomUUID()}`)
    const handle = await open(probe, 'wx', 0o600)

    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rm(probe)
    await syncDirectory(this.root)
  }

  private keyPath(keyId: string): string {
    if (!KEY_ID.test(keyId)) {
      throw new Error(`invalid credential key id: ${keyId}`)
    }

    return join(this.keysDir, `${keyId}.json`)
  }

  async createCandidate(): Promise<StoredCredentialKeyMaterial> {
    await this.init()
    const secret = randomBytes(KEY_BYTES)
    const keyId = credentialKeyIdOf(secret)
    const path = this.keyPath(keyId)
    const bytes = serialize({
      format: KEY_FORMAT,
      formatVersion: FORMAT_VERSION,
      keyId,
      secret: secret.toString('base64url'),
    } satisfies StoredCredentialKey)
    const handle = await open(path, 'wx', 0o600)

    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await syncDirectory(this.keysDir)
    return { keyId, hash: sha256(bytes), secret }
  }

  async readKey(keyId: string): Promise<StoredCredentialKeyMaterial | null> {
    const path = this.keyPath(keyId)
    const bytes = await readOptional(path)
    return bytes ? parseKey(bytes, path) : null
  }

  async listKeys(): Promise<StoredCredentialKeyMaterial[]> {
    await this.init()
    const entries = (await readdir(this.keysDir)).sort()

    if (entries.some((entry) => !/^ck_[0-9a-f]{24}\.json$/.test(entry))) {
      throw new Error('credential keyring contains an unrecognized key file')
    }
    const keys = await Promise.all(entries.map((entry) => this.readKey(entry.slice(0, -5))))
    return keys.filter((key): key is StoredCredentialKeyMaterial => key !== null)
  }

  /** Probe only keys referenced by this resolution candidate set. Historical files
   * that no candidate names are intentionally untouched. Required files are read once
   * on every call: stat fingerprints are not a safe cross-request cache key on filesystems
   * with coarse timestamps. Missing, replaced, corrupt, symlinked and non-regular files
   * all answer unreadable; live decrypt remains the final AEAD backstop. */
  async readableKeyIds(requiredKeyIds: ReadonlySet<string>): Promise<ReadonlySet<string>> {
    const readable = new Set<string>()

    await Promise.all(
      [...requiredKeyIds].sort().map(async (keyId) => {
        if (await this.keyFileIsReadable(keyId)) {
          readable.add(keyId)
        }
      }),
    )

    return readable
  }

  async readActive(): Promise<ActiveCredentialKey | null> {
    const bytes = await readOptional(this.activePath)

    if (!bytes) {
      return null
    }
    const pointer = parsePointer(bytes, this.activePath)
    const key = await this.readKey(pointer.keyId)

    if (!key) {
      throw new Error(`active credential key is missing: ${pointer.keyId}`)
    }
    if (key.hash !== pointer.keyHash) {
      throw new Error(`active credential key hash does not match its pointer: ${pointer.keyId}`)
    }

    return { ...key, generation: pointer.generation }
  }

  async installActive(generation: number, candidate: StoredCredentialKeyMaterial): Promise<void> {
    await this.init()
    const onDisk = await this.readKey(candidate.keyId)

    try {
      if (!onDisk || onDisk.hash !== candidate.hash) {
        throw new Error(
          `candidate credential key does not match its durable file: ${candidate.keyId}`,
        )
      }
    } finally {
      // `candidate` belongs to the caller; only erase this independent verification read.
      onDisk?.secret.fill(0)
    }
    const bytes = serialize({
      format: POINTER_FORMAT,
      formatVersion: FORMAT_VERSION,
      generation,
      keyId: candidate.keyId,
      keyHash: candidate.hash,
    } satisfies ActivePointer)
    const temporary = join(this.root, `.active-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)

    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, this.activePath)
      await syncDirectory(this.root)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  async isCompletelyLost(): Promise<boolean> {
    let rootEntries: string[]

    try {
      rootEntries = await readdir(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return true
      }
      throw error
    }
    if (rootEntries.length === 0) {
      return true
    }
    if (rootEntries.some((entry) => entry !== 'keys')) {
      return false
    }
    const keyEntries = await readdir(this.keysDir)
    return keyEntries.length === 0
  }

  private async keyFileIsReadable(keyId: string): Promise<boolean> {
    let material: StoredCredentialKeyMaterial | null = null

    try {
      const before = await lstat(this.keyPath(keyId), { bigint: true })

      if (!before.isFile() || before.isSymbolicLink()) {
        return false
      }

      material = await this.readKey(keyId)
      const after = await lstat(this.keyPath(keyId), { bigint: true })

      if (!after.isFile() || after.isSymbolicLink()) {
        return false
      }

      return (
        material !== null &&
        material.keyId === keyId &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs
      )
    } catch {
      return false
    } finally {
      material?.secret.fill(0)
    }
  }
}
