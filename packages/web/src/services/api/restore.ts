import type { RestoreResponse, SaveResponse, TrashRestoreManyResponse } from '@notarium/contract'

import { ApiError, req } from './client'

const replayKeys = new Map<string, string>()
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Same-POST recovery loop. The key remains cached across a network failure or
 * a still-pending response, so a second click resumes the accepted operation
 * instead of creating another restore event. */
export const strictRestore = async (
  path: string,
  commandIdentity: string,
  body: Record<string, unknown>,
): Promise<SaveResponse> => {
  const idempotencyKey = replayKeys.get(commandIdentity) ?? crypto.randomUUID()

  replayKeys.set(commandIdentity, idempotencyKey)
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await req<RestoreResponse>(path, {
        method: 'POST',
        body: JSON.stringify({ ...body, idempotencyKey }),
      })

      if (result.status === 'succeeded') {
        replayKeys.delete(commandIdentity)
        return {
          ok: true,
          id: result.id,
          filePath: result.filePath,
          versionToken: result.versionToken,
        }
      }
      if (result.status !== 'pending') {
        throw new ApiError('restore did not return a terminal result')
      }
      await wait(Math.min(1_000, 100 * 2 ** attempt))
    }
    const pending = new ApiError('Restore was accepted and is still recovering')

    pending.reason = 'restore_pending'
    throw pending
  } catch (error) {
    // A server response proves whether this attempt was rejected. A transport
    // failure is ambiguous, so retain the key for the next explicit retry.
    if (error instanceof ApiError && error.status != null) {
      replayKeys.delete(commandIdentity)
    }
    throw error
  }
}

/** Same replay discipline for a durable bulk command. A running roster is not
 * a partial answer: repeat the identical POST until its frozen children are all
 * terminal, retaining the key across ambiguity and bounded client polling. */
export const strictBulkRestore = async (
  path: string,
  commandIdentity: string,
  body: Record<string, unknown>,
): Promise<Extract<TrashRestoreManyResponse, { status: 'completed' }>> => {
  const idempotencyKey = replayKeys.get(commandIdentity) ?? crypto.randomUUID()

  replayKeys.set(commandIdentity, idempotencyKey)
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await req<TrashRestoreManyResponse>(path, {
        method: 'POST',
        body: JSON.stringify({ ...body, idempotencyKey }),
      })

      if (result.status === 'completed') {
        replayKeys.delete(commandIdentity)
        return result
      }
      if (result.status !== 'running') {
        throw new ApiError('bulk restore did not return a terminal result')
      }
      await wait(Math.min(1_000, 100 * 2 ** attempt))
    }
    const pending = new ApiError('Bulk restore was accepted and is still recovering')

    pending.reason = 'restore_pending'
    throw pending
  } catch (error) {
    if (error instanceof ApiError && error.status != null) {
      replayKeys.delete(commandIdentity)
    }
    throw error
  }
}
