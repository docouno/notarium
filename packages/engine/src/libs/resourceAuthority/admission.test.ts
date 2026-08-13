import { afterEach, describe, expect, it, vi } from 'vitest'

import { ResourceAdmission } from './admission'

const turn = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ResourceAdmission', () => {
  it('rejects ownerless and invalid-deadline requests before they enter the queue', async () => {
    const admission = new ResourceAdmission()

    await expect(
      admission.admit({ scope: 'resource', mode: 'shared', owner: '  ', path: 'note.md' }),
    ).rejects.toThrow('owner is required')
    await expect(
      admission.admit({
        scope: 'resource',
        mode: 'shared',
        owner: 'reader',
        path: 'note.md',
        deadlineMs: Number.NaN,
      }),
    ).rejects.toThrow('deadlineMs')
    await expect(
      admission.admit({
        scope: 'resource',
        mode: 'shared',
        owner: 'reader',
        path: 'note.md',
        deadlineMs: -1,
      }),
    ).rejects.toThrow('deadlineMs')
  })

  it('cancels both pre-aborted and queued requests without disturbing the blocker', async () => {
    const admission = new ResourceAdmission()
    const preAborted = new AbortController()
    preAborted.abort('already stopped')

    await expect(
      admission.admit({
        scope: 'resource',
        mode: 'shared',
        owner: 'pre-aborted',
        path: 'note.md',
        signal: preAborted.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' })

    const blocker = await admission.admit({
      scope: 'resource',
      mode: 'exclusive',
      owner: 'writer',
      path: 'note.md',
    })
    const queuedAbort = new AbortController()
    const queued = admission.admit({
      scope: 'resource',
      mode: 'shared',
      owner: 'queued-reader',
      path: 'note.md',
      signal: queuedAbort.signal,
    })

    await turn()
    queuedAbort.abort('caller left')
    await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(admission.diagnostics()).toEqual([
      expect.objectContaining({ owner: 'writer', state: 'active' }),
    ])
    blocker.settle()
  })

  it('marks active aborts as cancelling and makes repeated cancel/settle harmless', async () => {
    const admission = new ResourceAdmission()
    const controller = new AbortController()
    const lease = await admission.admit({
      scope: 'resource',
      mode: 'shared',
      owner: 'reader',
      path: 'note.md',
      signal: controller.signal,
    })

    controller.abort(new Error('request disconnected'))
    expect(lease.signal).toMatchObject({ aborted: true })
    expect(admission.diagnostics()).toEqual([
      expect.objectContaining({ owner: 'reader', state: 'cancelling' }),
    ])
    lease.cancel('already cancelling')
    lease.settle()
    lease.cancel('already settled')
    lease.settle()
    expect(admission.diagnostics()).toEqual([])
  })

  it('expires waiting work and aborts active work at their distinct deadlines', async () => {
    vi.useFakeTimers()
    const admission = new ResourceAdmission()
    const active = await admission.admit({
      scope: 'resource',
      mode: 'exclusive',
      owner: 'writer',
      path: 'note.md',
      deadlineMs: 5,
    })
    const waiting = admission.admit({
      scope: 'resource',
      mode: 'shared',
      owner: 'reader',
      path: 'note.md',
      deadlineMs: 3,
    })
    const waitingVerdict = expect(waiting).rejects.toMatchObject({ code: 'DEADLINE' })

    await vi.advanceTimersByTimeAsync(3)
    await waitingVerdict
    expect(active.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(active.signal.aborted).toBe(true)
    expect(active.signal.reason).toMatchObject({ code: 'DEADLINE' })
    expect(admission.diagnostics()).toEqual([
      expect.objectContaining({ owner: 'writer', state: 'cancelling' }),
    ])
    active.settle()
  })

  it('serializes one resource while letting an unrelated resource proceed', async () => {
    const admission = new ResourceAdmission()
    const first = await admission.admit({
      scope: 'resource',
      mode: 'shared',
      owner: 'reader-a',
      path: 'pkg/a.md',
      packagePath: 'pkg',
    })
    let exclusiveGranted = false
    const exclusivePromise = admission
      .admit({
        scope: 'resource',
        mode: 'exclusive',
        owner: 'writer-a',
        path: 'pkg/a.md',
        packagePath: 'pkg',
      })
      .then((lease) => {
        exclusiveGranted = true
        return lease
      })

    const unrelated = await admission.admit({
      scope: 'resource',
      mode: 'exclusive',
      owner: 'writer-b',
      path: 'pkg/b.md',
      packagePath: 'pkg',
    })
    await turn()
    expect(exclusiveGranted).toBe(false)

    unrelated.settle()
    first.settle()
    const exclusive = await exclusivePromise
    expect(exclusiveGranted).toBe(true)
    exclusive.settle()
  })

  it('makes package-exclusive admission cover present and future members', async () => {
    const admission = new ResourceAdmission()
    const member = await admission.admit({
      scope: 'resource',
      mode: 'shared',
      owner: 'member-reader',
      path: 'pkg/a.md',
      packagePath: 'pkg',
    })
    let packageGranted = false
    const packagePromise = admission
      .admit({
        scope: 'package',
        mode: 'exclusive',
        owner: 'package-replace',
        path: 'pkg',
      })
      .then((lease) => {
        packageGranted = true
        return lease
      })

    await turn()
    expect(packageGranted).toBe(false)
    member.settle()
    const packageLease = await packagePromise

    let futureGranted = false
    const futurePromise = admission
      .admit({
        scope: 'resource',
        mode: 'shared',
        owner: 'future-reader',
        path: 'pkg/future.md',
        packagePath: 'pkg',
      })
      .then((lease) => {
        futureGranted = true
        return lease
      })

    await turn()
    expect(futureGranted).toBe(false)
    packageLease.settle()
    const future = await futurePromise
    future.settle()
  })

  it('lets a root-package export cover descendants without serializing sibling packages', async () => {
    const admission = new ResourceAdmission()
    const packageA = await admission.admit({
      scope: 'package',
      mode: 'exclusive',
      owner: 'package-a',
      path: 'skills/a',
    })
    const packageB = await admission.admit({
      scope: 'package',
      mode: 'exclusive',
      owner: 'package-b',
      path: 'skills/b',
    })
    let exportGranted = false
    const exportPromise = admission
      .admit({ scope: 'package', mode: 'shared', owner: 'export', path: 'skills' })
      .then((lease) => {
        exportGranted = true
        return lease
      })

    await turn()
    expect(exportGranted).toBe(false)
    packageA.settle()
    await turn()
    expect(exportGranted).toBe(false)
    packageB.settle()
    const exportLease = await exportPromise
    exportLease.settle()
  })

  it('keeps a cancelled active lease blocking until its owner settles', async () => {
    const admission = new ResourceAdmission()
    const active = await admission.admit({
      scope: 'resource',
      mode: 'exclusive',
      owner: 'slow-writer',
      path: 'note.md',
    })
    let nextGranted = false
    const nextPromise = admission
      .admit({ scope: 'resource', mode: 'shared', owner: 'reader', path: 'note.md' })
      .then((lease) => {
        nextGranted = true
        return lease
      })

    active.cancel('closing')
    await turn()
    expect(active.signal.aborted).toBe(true)
    expect(nextGranted).toBe(false)
    expect(admission.diagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: 'slow-writer', state: 'cancelling' }),
        expect.objectContaining({ owner: 'reader', state: 'waiting' }),
      ]),
    )

    active.settle()
    const next = await nextPromise
    next.settle()
  })
})
