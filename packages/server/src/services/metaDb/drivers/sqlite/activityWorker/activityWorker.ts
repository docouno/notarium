import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'

import type { RevisionPersistence } from '@notarium/core'

import type { SqliteActivityWorker } from '../context'
import type { ActivityWorkerCall, ActivityWorkerReply } from './types'

export type SqliteActivityWorkerClient = SqliteActivityWorker & {
  close(): Promise<void>
  /** Resolves only after an unexpected worker exit; the owner may lazily replace it. */
  readonly dead: Promise<void>
}

const workerEntry = (): URL => {
  for (const name of ['activityProjectionWorker.js', 'activityWorkerThread.ts']) {
    const url = new URL(`./${name}`, import.meta.url)

    if (existsSync(url)) {
      return url
    }
  }

  throw new Error(`SQLite Activity worker entry not found next to ${import.meta.url}`)
}

const errorOf = (reply: Extract<ActivityWorkerReply, { ok: false }>): Error => {
  const error = new Error(reply.error.message)

  return Object.assign(error, reply.error)
}

/** One deliberately narrow worker connection for file-backed SQLite Activity.
 * Main TS retains scheduling/readiness; this adapter only correlates the four
 * approved persistence calls and owns the worker lifecycle. */
export const createSqliteActivityWorker = (
  path: string,
  entry = workerEntry(),
): SqliteActivityWorkerClient => {
  const worker = new Worker(entry, {
    workerData: { path },
    ...(entry.pathname.endsWith('.ts') ? { execArgv: ['--import', 'tsx'] } : {}),
  })
  worker.unref()
  let sequence = 0
  let closing = false
  let closed = false
  let closePromise: Promise<void> | null = null
  let terminalError: Error | null = null
  let markDead!: () => void
  const dead = new Promise<void>((resolve) => {
    markDead = resolve
  })
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()

  const fail = (error: Error): void => {
    if (terminalError) {
      return
    }
    terminalError = error
    for (const waiter of pending.values()) {
      waiter.reject(error)
    }
    pending.clear()
    worker.unref()
    markDead()
  }

  worker.on('message', (reply: ActivityWorkerReply) => {
    const waiter = pending.get(reply.id)

    if (!waiter) {
      return
    }
    pending.delete(reply.id)
    if (!pending.size) {
      worker.unref()
    }
    if (reply.ok) {
      waiter.resolve(reply.value)
    } else {
      waiter.reject(errorOf(reply))
    }
  })
  worker.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))))
  worker.on('exit', (code) => {
    if (!closing || pending.size) {
      fail(new Error(`SQLite Activity worker exited (code ${code})`))
    }
  })

  const call = <T>(request: ActivityWorkerCall): Promise<T> => {
    if (terminalError) {
      return Promise.reject(terminalError)
    }
    if (closed || (closing && request.operation !== 'close')) {
      return Promise.reject(new Error('SQLite Activity worker is closed'))
    }
    const id = ++sequence

    return new Promise<T>((resolve, reject) => {
      if (!pending.size) {
        worker.ref()
      }
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      try {
        worker.postMessage({ ...request, id })
      } catch (error) {
        pending.delete(id)
        if (!pending.size) {
          worker.unref()
        }
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  return {
    dead,
    maintainActivityProjection: (space) =>
      call<Awaited<ReturnType<RevisionPersistence['maintainActivityProjection']>>>({
        operation: 'maintain',
        space,
      }),
    maintainActivityProjectionGc: (space) =>
      call<Awaited<ReturnType<RevisionPersistence['maintainActivityProjectionGc']>>>({
        operation: 'gc',
        space,
      }),
    activityEvents: (space, opts) =>
      call<Awaited<ReturnType<RevisionPersistence['activityEvents']>>>({
        operation: 'events',
        space,
        opts,
      }),
    activityGroupsByNote: (space, opts) =>
      call<Awaited<ReturnType<RevisionPersistence['activityGroupsByNote']>>>({
        operation: 'groups',
        space,
        opts,
      }),
    close: () => {
      if (closePromise) {
        return closePromise
      }
      closing = true
      closePromise = (async () => {
        try {
          if (!terminalError) {
            await call<void>({ operation: 'close' })
          }
        } finally {
          closed = true
          await worker.terminate().catch(() => {})
          if (pending.size) {
            fail(new Error('SQLite Activity worker closed with pending calls'))
          }
        }
      })()
      return closePromise
    },
  }
}
