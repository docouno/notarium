import { constants } from 'node:fs'
import { link, lstat, open, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

type FileIdentity = {
  dev: number
  ino: number
  size: number
}

type PublicationOps = {
  identity(path: string): Promise<FileIdentity>
  link(source: string, destination: string): Promise<void>
  unlink(path: string): Promise<void>
  syncDirectory(path: string): Promise<void>
  warn(message: string, err: unknown): void
}

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)

  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const DEFAULT_OPS: PublicationOps = {
  identity: lstat,
  link,
  unlink,
  syncDirectory,
  warn: (message, err) => console.error(`[backup] ${message}:`, err),
}

/**
 * Atomically publish a completed archive without clobbering an existing target.
 * The hard link is the commit point. Before it, the partial and its directory are
 * durable and failures reject with no final. After it, path-based rollback cannot be
 * made race-free, so cleanup is best-effort and the call remains successful: at worst
 * the operator gets a warning plus a recovery hard-link to the same durable inode.
 */
export const publishArchive = async (
  partial: string,
  final: string,
  overrides: Partial<PublicationOps> = {},
): Promise<number> => {
  const ops = { ...DEFAULT_OPS, ...overrides }
  const parent = dirname(final)
  const partialIdentity = await ops.identity(partial)

  // Make the completed recovery name durable before publishing the operator-facing
  // name. A post-link fsync failure can then safely retain this hard-link as fallback.
  await ops.syncDirectory(parent)
  await ops.link(partial, final)

  try {
    await ops.syncDirectory(parent)
  } catch (err) {
    ops.warn(
      `output is visible but directory fsync failed; retaining recovery partial ${partial}`,
      err,
    )
    return partialIdentity.size
  }

  try {
    await ops.unlink(partial)
  } catch (err) {
    ops.warn(`output is published; could not remove recovery partial ${partial}`, err)
    return partialIdentity.size
  }
  try {
    await ops.syncDirectory(parent)
  } catch (err) {
    // The final link was already directory-synced. A crash may resurrect the removed
    // recovery name, which is harmless and still references the same archive bytes.
    ops.warn('output is durable but recovery-partial cleanup could not be synced', err)
  }

  return partialIdentity.size
}
