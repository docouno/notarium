import type { ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import type { Server } from 'node:http'

type SyncStatusShape = {
  scan?: { phase?: string }
  engine?: { indexing?: string; vector?: { pending?: number } | null }
}

export const realStackReady = (status: SyncStatusShape): boolean =>
  status.scan?.phase === 'ready' &&
  status.engine?.indexing === 'idle' &&
  (status.engine.vector?.pending ?? 0) === 0

export const nodeTsxArguments = (entry: string): string[] => [
  '--no-maglev',
  '--import',
  'tsx',
  entry,
]

const childIsRunning = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null

export const stopChild = async (
  child: ChildProcess | null,
  {
    signal = 'SIGTERM',
    killAfterMs = 5_000,
  }: { signal?: NodeJS.Signals; killAfterMs?: number } = {},
): Promise<void> => {
  if (!child || !childIsRunning(child)) {
    return
  }

  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve())
  })
  child.kill(signal)
  let timer: NodeJS.Timeout | undefined
  const graceExpired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), killAfterMs)
    timer.unref()
  })
  const graceDidExpire = await Promise.race([closed.then(() => false), graceExpired])

  if (timer) {
    clearTimeout(timer)
  }
  if (graceDidExpire) {
    if (childIsRunning(child)) {
      child.kill('SIGKILL')
    }
    await closed
  }
}

export const listenReadiness = async (
  server: Server,
  port: number,
  host = '127.0.0.1',
): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }

    const onListening = () => {
      server.off('error', onError)
      resolve()
    }

    server.once('error', onError)
    server.once('listening', onListening)
    try {
      server.listen(port, host)
    } catch (error) {
      server.off('error', onError)
      server.off('listening', onListening)
      reject(error)
    }
  })

const closeReadiness = async (server: Server | null): Promise<void> => {
  if (!server?.listening) {
    return
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

export const cleanupRealStack = async ({
  server,
  readiness,
  dataDir,
}: {
  server: ChildProcess | null
  readiness: Server | null
  dataDir: string
}): Promise<void> => {
  await closeReadiness(readiness)
  await stopChild(server)
  await rm(dataDir, { recursive: true, force: true })
}
