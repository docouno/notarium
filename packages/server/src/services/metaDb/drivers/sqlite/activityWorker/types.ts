import type { RevisionPersistence } from '@notarium/core'

export type ActivityWorkerCall =
  | { operation: 'maintain'; space: string }
  | { operation: 'gc'; space: string }
  | {
      operation: 'events'
      space: string
      opts: Parameters<RevisionPersistence['activityEvents']>[1]
    }
  | {
      operation: 'groups'
      space: string
      opts: Parameters<RevisionPersistence['activityGroupsByNote']>[1]
    }
  | { operation: 'close' }

export type ActivityWorkerRequest = ActivityWorkerCall & { id: number }

export type SerializedActivityWorkerError = {
  name: string
  message: string
  reason?: string
  isToolError?: boolean
  isUnavailable?: boolean
  isNotFound?: boolean
  isConflict?: boolean
}

export type ActivityWorkerReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: SerializedActivityWorkerError }
