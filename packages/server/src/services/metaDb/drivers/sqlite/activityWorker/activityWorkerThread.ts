import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

import type { SqliteDriverCtx } from '../context'
import { createRevisionsFacet } from '../revisions'
import type {
  ActivityWorkerReply,
  ActivityWorkerRequest,
  SerializedActivityWorkerError,
} from './types'

const port = parentPort

if (!port || typeof workerData?.path !== 'string') {
  throw new Error('SQLite Activity worker requires a database path')
}

const db = new DatabaseSync(workerData.path)
// Background writes give foreground appends priority: a missed 250 ms window
// becomes a no-op maintenance turn and retries after the main scheduler yields.
db.exec('PRAGMA busy_timeout = 250')
db.exec('PRAGMA journal_mode = WAL')
// Checkpoint explicitly between durable rebuild units so the connection that
// crosses SQLite's page threshold never pushes that work onto the main loop.
db.exec('PRAGMA wal_autocheckpoint = 0')
let open = true
const ctx: SqliteDriverCtx = {
  ensureInit: async () => {
    if (!open) {
      throw new Error('SQLite Activity worker database is closed')
    }
  },
  checkpointWal: async () => {
    db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
  },
  close: async () => {
    if (open) {
      db.close()
      open = false
    }
  },
  get required() {
    if (!open) {
      throw new Error('SQLite Activity worker database is closed')
    }

    return db
  },
}
const revisions = createRevisionsFacet(ctx)

const serializeError = (error: unknown): SerializedActivityWorkerError => {
  const typed = error instanceof Error ? error : new Error(String(error))
  const flags = typed as Error & {
    reason?: string
    isToolError?: boolean
    isUnavailable?: boolean
    isNotFound?: boolean
    isConflict?: boolean
  }

  return {
    name: typed.name,
    message: typed.message,
    ...(flags.reason === undefined ? {} : { reason: flags.reason }),
    ...(flags.isToolError === undefined ? {} : { isToolError: flags.isToolError }),
    ...(flags.isUnavailable === undefined ? {} : { isUnavailable: flags.isUnavailable }),
    ...(flags.isNotFound === undefined ? {} : { isNotFound: flags.isNotFound }),
    ...(flags.isConflict === undefined ? {} : { isConflict: flags.isConflict }),
  }
}

const execute = async (request: ActivityWorkerRequest): Promise<unknown> => {
  switch (request.operation) {
    case 'maintain':
      return revisions.maintainActivityProjection(request.space)
    case 'gc':
      return revisions.maintainActivityProjectionGc(request.space)
    case 'events':
      if (request.opts.from != null || request.opts.to != null || request.opts.noteId != null) {
        throw new Error('SQLite Activity worker accepts only standing unbounded events')
      }

      return revisions.activityEvents(request.space, request.opts)
    case 'groups':
      if (request.opts.from != null || request.opts.to != null) {
        throw new Error('SQLite Activity worker accepts only standing unbounded groups')
      }

      return revisions.activityGroupsByNote(request.space, request.opts)
    case 'close':
      return ctx.close()
  }
}

let tail = Promise.resolve()

port.on('message', (request: ActivityWorkerRequest) => {
  tail = tail.then(async () => {
    let reply: ActivityWorkerReply

    try {
      reply = { id: request.id, ok: true, value: await execute(request) }
    } catch (error) {
      reply = { id: request.id, ok: false, error: serializeError(error) }
    }
    try {
      port.postMessage(reply)
    } catch (error) {
      port.postMessage({ id: request.id, ok: false, error: serializeError(error) })
    }
  })
})
