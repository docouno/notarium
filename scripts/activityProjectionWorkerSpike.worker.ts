import { parentPort, workerData } from 'node:worker_threads'
import type { AuthorFilter, RevisionInput } from '@notarium/core'
import { openActivityProjectionSpikeDb } from './activityProjectionWorkerSpike.local'

type WorkerRequest = {
  id: number
  op: 'init' | 'prepare' | 'maintain' | 'gc' | 'groups' | 'get' | 'append' | 'close'
  space?: string
  author?: AuthorFilter
  viewerAuthor?: AuthorFilter
  revisionId?: string
  revision?: RevisionInput
}

const port = parentPort

if (!port || typeof workerData?.path !== 'string') {
  throw new Error('Activity projection spike worker requires a database path')
}

if (!Number.isInteger(workerData.batchSize) || workerData.batchSize <= 0) {
  throw new Error('Activity projection spike worker requires a positive batch size')
}
const db = openActivityProjectionSpikeDb(workerData.path, workerData.batchSize)
let tail = Promise.resolve()

const execute = async (request: WorkerRequest): Promise<unknown> => {
  const space = request.space ?? 'activity-groups'

  switch (request.op) {
    case 'init':
      return db.revisions.init()
    case 'prepare':
      return db.revisions.prepareActivityProjection(space)
    case 'maintain':
      return db.revisions.maintainActivityProjection(space)
    case 'gc':
      return db.revisions.maintainActivityProjectionGc(space)
    case 'groups':
      return db.revisions.activityGroupsByNote(space, {
        author: request.author,
        viewerAuthor: request.viewerAuthor,
      })
    case 'get':
      return db.revisions.get(space, request.revisionId ?? '1')
    case 'append':
      if (!request.revision) {
        throw new Error('append requires a revision')
      }

      return db.revisions.append(request.revision, null)
    case 'close':
      return db.close()
  }
}

port.on('message', (request: WorkerRequest) => {
  tail = tail.then(async () => {
    try {
      const value = await execute(request)
      port.postMessage({ id: request.id, ok: true, value })
    } catch (error) {
      const typed = error as Error & { reason?: string }
      port.postMessage({
        id: request.id,
        ok: false,
        error: { message: typed.message, reason: typed.reason },
      })
    }
  })
})
