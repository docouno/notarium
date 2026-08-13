import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  InMemoryInstallationGenerationPersistence,
  INSTALLATION_GENERATION_PHASE,
} from '@notarium/core'

import { createMutationGate } from '../mutationGate'
import {
  createBackupControl,
  requestBackupCheckpoint,
  requestBackupGenerationCut,
} from './backupControl'

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

  it('holds, renews, and releases one durable installation generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-control-'))
    roots.push(root)
    const socket = join(root, 'backup.sock')
    const installation = new InMemoryInstallationGenerationPersistence()
    const installed = {
      generation: 1,
      phase: INSTALLATION_GENERATION_PHASE.activeInstalled,
      activeKeyId: 'rk_0123456789abcdef01234567',
      activeHash: 'sha256:active',
      candidateKeyId: null,
      candidateHash: null,
      changedAt: new Date(0).toISOString(),
    }
    await installation.compareAndSet({ expected: null, record: installed })
    const control = createBackupControl(socket, async () => {}, 5_000, installation, 30_000)

    await control.start()
    const lease = await requestBackupGenerationCut(socket)
    expect(lease.bundle).toEqual({
      generation: 1,
      keyId: installed.activeKeyId,
      activeHash: installed.activeHash,
      candidateKeyId: null,
      candidateHash: null,
    })
    await expect(lease.renew()).resolves.toMatch(/^\d{4}-/)
    await expect(
      installation.compareAndSet({
        expected: installed,
        record: {
          ...installed,
          generation: 2,
          phase: INSTALLATION_GENERATION_PHASE.candidateReady,
          candidateKeyId: 'rk_abcdef0123456789abcdef01',
          candidateHash: 'sha256:candidate',
          changedAt: new Date().toISOString(),
        },
      }),
    ).resolves.toMatchObject({ status: 'backup-frozen' })
    await lease.release()
    await expect(lease.release()).resolves.toBeUndefined()
    await control.close()
  })
})
