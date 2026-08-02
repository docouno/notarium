export type MutationRelease = () => void

export type MutationCheckpointOptions = {
  signal?: AbortSignal
}

export type MutationEnterOptions = {
  signal?: AbortSignal
}

/** The caller-facing result may reject promptly on cancellation, while settlement
 *  remains pending until already-started checkpoint work has actually stopped. */
export type MutationCheckpoint = Promise<void> & {
  settlement: Promise<void>
}

export type MutationGate = {
  enter(options?: MutationEnterOptions): Promise<MutationRelease>
  run<T>(task: () => Promise<T>): Promise<T>
  checkpoint(task: () => Promise<void>, options?: MutationCheckpointOptions): MutationCheckpoint
}

const abortable = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) {
    return promise
  }
  signal.throwIfAborted()

  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener('abort', aborted)
      reject(signal.reason ?? new Error('backup checkpoint canceled'))
    }
    signal.addEventListener('abort', aborted, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', aborted)
        reject(err)
      },
    )
  })
}

/**
 * A short process-local write barrier used by online backup. Normal mutations
 * run concurrently; one checkpoint queues new mutations and waits for active
 * work before flushing persistence. A concurrent checkpoint fails fast.
 */
export const createMutationGate = (): MutationGate => {
  let active = 0
  let blocked = false
  let checkpointInProgress = false
  const entrants: Array<() => void> = []
  const drains: Array<() => void> = []

  const enter = async ({ signal }: MutationEnterOptions = {}): Promise<MutationRelease> => {
    while (blocked) {
      signal?.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const admitted = (): void => {
          signal?.removeEventListener('abort', aborted)
          resolve()
        }

        const aborted = (): void => {
          const index = entrants.indexOf(admitted)

          if (index !== -1) {
            entrants.splice(index, 1)
          }
          reject(signal?.reason ?? new Error('mutation canceled before admission'))
        }

        entrants.push(admitted)
        signal?.addEventListener('abort', aborted, { once: true })
      })
    }
    signal?.throwIfAborted()
    active += 1
    let released = false

    return () => {
      if (released) {
        return
      }
      released = true
      active -= 1
      if (active === 0) {
        for (const resolve of drains.splice(0)) {
          resolve()
        }
      }
    }
  }

  const checkpoint = (
    task: () => Promise<void>,
    { signal }: MutationCheckpointOptions = {},
  ): MutationCheckpoint => {
    if (checkpointInProgress) {
      return Object.assign(Promise.reject(new Error('backup checkpoint is already in progress')), {
        settlement: Promise.resolve(),
      })
    }
    checkpointInProgress = true
    blocked = true
    let taskPromise: Promise<void> | null = null

    const releaseBarrier = (): void => {
      blocked = false
      for (const resolve of entrants.splice(0)) {
        resolve()
      }
    }
    const run = (async () => {
      try {
        signal?.throwIfAborted()
        if (active > 0) {
          await new Promise<void>((resolve, reject) => {
            const drained = (): void => {
              signal?.removeEventListener('abort', aborted)
              resolve()
            }

            const aborted = (): void => {
              const index = drains.indexOf(drained)

              if (index !== -1) {
                drains.splice(index, 1)
              }
              reject(signal?.reason ?? new Error('backup checkpoint canceled'))
            }

            drains.push(drained)
            signal?.addEventListener('abort', aborted, { once: true })
          })
        }
        signal?.throwIfAborted()
        taskPromise = task()
        await abortable(taskPromise, signal)
      } finally {
        releaseBarrier()
      }
    })()

    const responseObserved = run.then(
      () => {
        // A successful response already awaited the task itself.
        checkpointInProgress = false
      },
      () => {
        // Failure before the task starts, or from the task itself without a
        // cancellation, is also fully settled at the response boundary.
        if (!taskPromise || !signal?.aborted) {
          checkpointInProgress = false
        }
      },
    )
    const settlement = responseObserved.then(async () => {
      const settling = taskPromise

      if (settling) {
        await settling.then(
          () => undefined,
          () => undefined,
        )
      }
      checkpointInProgress = false
    })
    return Object.assign(run, { settlement })
  }

  return {
    enter,
    run: async <T>(task: () => Promise<T>): Promise<T> => {
      const release = await enter()

      try {
        return await task()
      } finally {
        release()
      }
    },
    checkpoint,
  }
}
