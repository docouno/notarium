import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const KEY_FORMAT = 'notarium-replay-key'
const POINTER_FORMAT = 'notarium-replay-key-pointer'
const FORMAT_VERSION = 1
const KEY_BYTES = 32

type StoredReplayKey = {
  format: typeof KEY_FORMAT
  formatVersion: typeof FORMAT_VERSION
  keyId: string
  secret: string
}

export type ReplayKeyMaterial = {
  keyId: string
  hash: string
  secret: Buffer
}

export type ActiveReplayKey = ReplayKeyMaterial & {
  generation: number
}

type ActivePointer = {
  format: typeof POINTER_FORMAT
  formatVersion: typeof FORMAT_VERSION
  generation: number
  keyId: string
  keyHash: string
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

const keyIdOf = (secret: Buffer): string =>
  `rk_${createHash('sha256').update('notarium-replay-key-id\0').update(secret).digest('hex').slice(0, 24)}`

const parseKey = (bytes: Buffer, path: string): ReplayKeyMaterial => {
  let value: unknown

  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`replay key is corrupt: ${path}`)
  }
  const key = value as Partial<StoredReplayKey>

  if (
    key.format !== KEY_FORMAT ||
    key.formatVersion !== FORMAT_VERSION ||
    typeof key.keyId !== 'string' ||
    typeof key.secret !== 'string'
  ) {
    throw new Error(`replay key has an unsupported shape: ${path}`)
  }
  const secret = Buffer.from(key.secret, 'base64url')

  if (secret.length !== KEY_BYTES || secret.toString('base64url') !== key.secret) {
    throw new Error(`replay key secret is invalid: ${path}`)
  }
  if (keyIdOf(secret) !== key.keyId) {
    throw new Error(`replay key id does not match its secret: ${path}`)
  }

  return { keyId: key.keyId, hash: sha256(bytes), secret }
}

const parsePointer = (bytes: Buffer, path: string): ActivePointer => {
  let value: unknown

  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`active replay key pointer is corrupt: ${path}`)
  }
  const pointer = value as Partial<ActivePointer>

  if (
    pointer.format !== POINTER_FORMAT ||
    pointer.formatVersion !== FORMAT_VERSION ||
    !Number.isSafeInteger(pointer.generation) ||
    (pointer.generation ?? 0) < 1 ||
    typeof pointer.keyId !== 'string' ||
    typeof pointer.keyHash !== 'string'
  ) {
    throw new Error(`active replay key pointer has an unsupported shape: ${path}`)
  }

  return pointer as ActivePointer
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

/** Filesystem half of the FS↔DB generation witness. Key files are immutable;
 *  only the small active pointer is atomically replaced. */
export class ReplayKeyring {
  readonly root: string
  readonly keysDir: string
  readonly activePath: string

  constructor(root: string) {
    this.root = root
    this.keysDir = join(root, 'keys')
    this.activePath = join(root, 'active.json')
  }

  async init(): Promise<void> {
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
    if (!/^rk_[0-9a-f]{24}$/.test(keyId)) {
      throw new Error(`invalid replay key id: ${keyId}`)
    }

    return join(this.keysDir, `${keyId}.json`)
  }

  async createCandidate(): Promise<ReplayKeyMaterial> {
    await this.init()
    const secret = randomBytes(KEY_BYTES)
    const keyId = keyIdOf(secret)
    const path = this.keyPath(keyId)
    const bytes = serialize({
      format: KEY_FORMAT,
      formatVersion: FORMAT_VERSION,
      keyId,
      secret: secret.toString('base64url'),
    } satisfies StoredReplayKey)
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

  async readKey(keyId: string): Promise<ReplayKeyMaterial | null> {
    const path = this.keyPath(keyId)
    const bytes = await readOptional(path)
    return bytes ? parseKey(bytes, path) : null
  }

  async listKeys(): Promise<ReplayKeyMaterial[]> {
    await this.init()
    const entries = (await readdir(this.keysDir)).sort()

    if (entries.some((entry) => !/^rk_[0-9a-f]{24}\.json$/.test(entry))) {
      throw new Error('replay keyring contains an unrecognized key file')
    }
    const keys = await Promise.all(entries.map((entry) => this.readKey(entry.slice(0, -5))))
    return keys.filter((key): key is ReplayKeyMaterial => key !== null)
  }

  async readActive(): Promise<ActiveReplayKey | null> {
    const bytes = await readOptional(this.activePath)

    if (!bytes) {
      return null
    }
    const pointer = parsePointer(bytes, this.activePath)
    const key = await this.readKey(pointer.keyId)

    if (!key) {
      throw new Error(`active replay key is missing: ${pointer.keyId}`)
    }
    if (key.hash !== pointer.keyHash) {
      throw new Error(`active replay key hash does not match its pointer: ${pointer.keyId}`)
    }

    return { ...key, generation: pointer.generation }
  }

  async installActive(generation: number, candidate: ReplayKeyMaterial): Promise<void> {
    await this.init()
    const onDisk = await this.readKey(candidate.keyId)

    if (!onDisk || onDisk.hash !== candidate.hash) {
      throw new Error(`candidate replay key does not match its durable file: ${candidate.keyId}`)
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

  async assertNoUnwitnessedState(): Promise<void> {
    if (!(await this.isCompletelyLost())) {
      throw new Error(
        `replay keyring contains state without an installation witness: ${dirname(this.activePath)}`,
      )
    }
  }
}
