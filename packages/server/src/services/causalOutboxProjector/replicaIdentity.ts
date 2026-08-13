import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const FILE = '.causal-replica-id'
const VALID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/

/** A local projection cache is owned by one engine-data directory, so its
 * durable subscriber identity lives beside that cache rather than in the shared
 * meta-DB. Reopen returns the same subscriber; a second replica with its own
 * cache directory gets an independent delivery cursor. */
export const causalReplicaId = async (engineDataDir: string): Promise<string> => {
  await mkdir(engineDataDir, { recursive: true })
  const path = join(engineDataDir, FILE)

  try {
    const handle = await open(path, 'wx', 0o600)
    const value = `replica-${randomUUID()}`

    try {
      await handle.writeFile(value + '\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
    const directory = await open(engineDataDir, 'r')

    try {
      await directory.sync()
    } finally {
      await directory.close()
    }

    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }
  const value = (await readFile(path, 'utf8')).trim()

  if (!VALID.test(value)) {
    throw new Error('causal outbox replica identity is corrupt')
  }

  return value
}
