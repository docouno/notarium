import { chmod, lstat, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'

const MAX_REQUEST_BYTES = 1024
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_CHECKPOINT_TIMEOUT_MS = 5_000

export type BackupControl = {
  start(): Promise<void>
  close(): Promise<void>
}

type CheckpointRequest = Promise<void> & {
  /** Optional for simple implementations; MutationGate supplies the stronger
   *  lifecycle promise when cancellation precedes underlying task settlement. */
  settlement?: Promise<void>
}

const socketExists = async (socketPath: string): Promise<boolean> => {
  try {
    const info = await lstat(socketPath)

    if (!info.isSocket()) {
      throw new Error(`backup control path exists and is not a socket: ${socketPath}`)
    }

    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw err
  }
}

const connectable = (socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })

export const createBackupControl = (
  socketPath: string,
  checkpoint: (signal: AbortSignal) => CheckpointRequest,
  checkpointTimeoutMs = DEFAULT_CHECKPOINT_TIMEOUT_MS,
): BackupControl => {
  let server: Server | null = null
  const sockets = new Set<Socket>()
  const checkpointSettlements = new Set<Promise<void>>()

  const handle = (socket: Socket): void => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.setEncoding('utf8')
    let body = ''
    let handling = false
    socket.on('data', (chunk: string) => {
      body += chunk
      if (body.length > MAX_REQUEST_BYTES) {
        socket.end(`${JSON.stringify({ ok: false, error: 'request too large' })}\n`)
        return
      }
      const newline = body.indexOf('\n')

      if (newline === -1) {
        return
      }
      if (handling) {
        return
      }
      handling = true
      socket.pause()
      const command = body.slice(0, newline).trim()

      if (command !== 'checkpoint') {
        socket.end(`${JSON.stringify({ ok: false, error: 'unknown command' })}\n`)
        return
      }
      const controller = new AbortController()
      const timer = setTimeout(
        () =>
          controller.abort(
            new Error(`backup checkpoint exceeded ${checkpointTimeoutMs}ms; retry later`),
          ),
        checkpointTimeoutMs,
      )
      timer.unref?.()
      socket.once('close', () =>
        controller.abort(new Error('backup checkpoint client disconnected')),
      )
      const response = checkpoint(controller.signal)
      const settlement = response.settlement ?? response
      checkpointSettlements.add(settlement)
      void settlement.finally(() => checkpointSettlements.delete(settlement)).catch(() => {})
      void response.then(
        () => {
          clearTimeout(timer)
          if (!socket.destroyed) {
            socket.end(`${JSON.stringify({ ok: true })}\n`)
          }
        },
        (err) => {
          clearTimeout(timer)
          if (!socket.destroyed) {
            socket.end(
              `${JSON.stringify({ ok: false, error: (err as Error).message || 'checkpoint failed' })}\n`,
            )
          }
        },
      )
    })
  }

  return {
    start: async () => {
      if (server) {
        return
      }
      if ((await socketExists(socketPath)) && (await connectable(socketPath))) {
        throw new Error(`backup control socket is already in use: ${socketPath}`)
      }
      await rm(socketPath, { force: true })
      server = createServer(handle)
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(socketPath, () => {
          server!.off('error', reject)
          resolve()
        })
      })
      await chmod(socketPath, 0o600)
    },
    close: async () => {
      const current = server
      server = null
      for (const socket of sockets) {
        socket.destroy()
      }
      if (current) {
        await new Promise<void>((resolve, reject) =>
          current.close((err) => (err ? reject(err) : resolve())),
        )
      }
      // Destroying the client aborts its response promptly, but an already-started
      // store checkpoint deliberately continues settling behind that response. Do
      // not let the outer onClose tear down stores/meta.db underneath it.
      await Promise.allSettled([...checkpointSettlements])
      if (await socketExists(socketPath)) {
        await rm(socketPath)
      }
    },
  }
}

export const requestBackupCheckpoint = (
  socketPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let body = ''
    let settled = false

    const finish = (err?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    }
    const timer = setTimeout(
      () => finish(new Error(`backup checkpoint timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )

    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write('checkpoint\n'))
    socket.on('data', (chunk: string) => {
      body += chunk
      const newline = body.indexOf('\n')

      if (newline === -1) {
        return
      }
      try {
        const response = JSON.parse(body.slice(0, newline)) as { ok?: boolean; error?: string }

        if (response.ok === true) {
          finish()
        } else {
          finish(new Error(response.error || 'backup checkpoint failed'))
        }
      } catch {
        finish(new Error('backup control returned malformed response'))
      }
    })
    socket.once('error', (err) =>
      finish(
        new Error(
          `online backup requires a running Notarium server (${socketPath}): ${err.message}`,
        ),
      ),
    )
    socket.once('end', () => {
      if (!settled) {
        finish(new Error('backup control closed before checkpoint completed'))
      }
    })
  })

export const backupControlSocketFromEnv = (env: NodeJS.ProcessEnv = process.env): string =>
  env.NOTARIUM_BACKUP_CONTROL_SOCKET?.trim() || '/tmp/notarium-backup-control.sock'
