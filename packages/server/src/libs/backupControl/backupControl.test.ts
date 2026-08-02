import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createMutationGate } from '../mutationGate'
import { createBackupControl, requestBackupCheckpoint } from './backupControl'

const roots: string[] = []

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('backup control socket', () => {
  it('runs a checkpoint over a mode-0600 local socket and removes it on close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-control-'))
    roots.push(root)
    const socket = join(root, 'backup.sock')
    let checkpoints = 0
    const control = createBackupControl(socket, async () => {
      checkpoints += 1
    })

    await control.start()
    expect((await stat(socket)).mode & 0o777).toBe(0o600)
    await requestBackupCheckpoint(socket)
    expect(checkpoints).toBe(1)
    await control.close()
    await expect(stat(socket)).rejects.toThrow(/ENOENT/)
  })

  it('fails closed when the live server socket is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-control-'))
    roots.push(root)
    await expect(requestBackupCheckpoint(join(root, 'missing.sock'), 100)).rejects.toThrow(
      /requires a running Notarium server/,
    )
  })

  it('times out behind a long mutation and releases newly queued writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-control-'))
    roots.push(root)
    const socket = join(root, 'backup.sock')
    const gate = createMutationGate()
    const releaseLongMutation = await gate.enter()
    let checkpointRequested!: () => void
    const requested = new Promise<void>((resolve) => {
      checkpointRequested = resolve
    })
    const control = createBackupControl(
      socket,
      (signal) => {
        const checkpoint = gate.checkpoint(async () => {}, { signal })
        checkpointRequested()
        return checkpoint
      },
      25,
    )

    await control.start()
    const checkpoint = requestBackupCheckpoint(socket, 500)
    await requested
    const queued = gate.enter()

    await expect(checkpoint).rejects.toThrow(/checkpoint exceeded/)
    const releaseQueued = await queued
    releaseQueued()
    releaseLongMutation()
    await control.close()
  })

  it('awaits already-started checkpoint work before close completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-control-'))
    roots.push(root)
    const socket = join(root, 'backup.sock')
    const gate = createMutationGate()
    const started = deferred()
    const checkpointDone = deferred()
    const control = createBackupControl(socket, (signal) =>
      gate.checkpoint(
        async () => {
          started.resolve()
          await checkpointDone.promise
        },
        { signal },
      ),
    )

    await control.start()
    const request = requestBackupCheckpoint(socket, 500)
    void request.catch(() => {})
    await started.promise
    let closed = false
    const close = control.close().then(() => {
      closed = true
    })
    await expect(request).rejects.toThrow(/closed before checkpoint completed/)
    await Promise.resolve()
    expect(closed).toBe(false)

    checkpointDone.resolve()
    await close
    expect(closed).toBe(true)
  })
})
