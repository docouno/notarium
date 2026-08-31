import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { acquireHeavyLease, leaseNamesFor } from '../../scripts/checkup/lease.mjs'

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..')

type LeaseSpec = {
  container: string
  volume: string
  sessionId: string
  subjectDigest: string
  owner: string
  ownerHost: string
  ownerPid: number
  createdAt: string
  heartbeatIntervalMs: number
}

type LeaseRecord = LeaseSpec & {
  containerId: string
  heartbeatAt: number
  phases: Record<string, number[]>
}

class FakeLeaseBackend {
  image = 'fake'
  current: LeaseRecord | null = null
  pending: LeaseRecord | null = null
  inspectCalls = 0
  runners = 0
  removed: string[] = []
  heartbeatWrites = 0
  createFailure: 'before' | 'after' | 'delayed' | 'delayed-late' | null = null
  startFailure = false
  heartbeatFailure = false
  volumeRemovals = 0
  volumeRemovalFailure = false
  beforeRemoveLease: (() => void) | null = null
  private nextContainerId = 1

  async ensureImage() {}

  async ensureVolume() {}

  async createLease(spec: LeaseSpec) {
    if (this.createFailure === 'before') {
      throw new Error('create failed')
    }
    if (this.current) {
      return false
    }
    this.current = {
      ...spec,
      containerId: `container-${this.nextContainerId}`,
      heartbeatAt: Date.now(),
      phases: {},
    }
    this.nextContainerId += 1
    if (this.createFailure === 'after') {
      throw new Error('create failed')
    }
    if (this.createFailure === 'delayed' || this.createFailure === 'delayed-late') {
      this.pending = this.current
      this.current = null
      throw Object.assign(new Error('create timed out'), { indeterminate: true })
    }

    return true
  }

  async startLease() {
    if (this.startFailure) {
      throw new Error('start failed')
    }
  }

  async writeHeartbeat(spec: LeaseSpec, timestamp: number, phases: Record<string, number[]> = {}) {
    if (this.heartbeatFailure) {
      throw new Error('heartbeat failed')
    }
    if (this.current?.sessionId !== spec.sessionId) {
      throw new Error('not owner')
    }
    this.heartbeatWrites += 1
    this.current.heartbeatAt = timestamp
    this.current.phases = phases
  }

  async inspectLease() {
    this.inspectCalls += 1
    if (this.pending && this.createFailure === 'delayed' && this.inspectCalls >= 3) {
      this.current = this.pending
      this.pending = null
    }

    return this.current
  }

  async runnerCount() {
    return this.runners
  }

  async removeLease(spec: LeaseSpec, expected?: LeaseRecord) {
    this.beforeRemoveLease?.()
    this.beforeRemoveLease = null
    const matches = expected
      ? this.current?.containerId === expected.containerId
      : this.current?.container === spec.container

    if (matches) {
      this.removed.push(this.current?.sessionId ?? '')
      this.current = null
    }
  }

  completePendingCreate() {
    this.current = this.pending
    this.pending = null
  }

  async removeVolume() {
    if (this.volumeRemovalFailure) {
      throw new Error('volume remove failed')
    }
    this.volumeRemovals += 1
  }
}

const acquire = (
  backend: FakeLeaseBackend,
  sessionId: string,
  overrides: {
    ownerAlive?: () => boolean
    waitTimeoutMs?: number
    heartbeatIntervalMs?: number
    pollIntervalMs?: number
    signal?: AbortSignal
    phaseAlive?: () => boolean
    initializationReconcileMs?: number
  } = {},
) =>
  acquireHeavyLease({
    repositoryIdentity: 'git@example.test:notarium/notarium.git',
    sessionId,
    subjectDigest: sessionId.repeat(64).slice(0, 64),
    command: 'make checkup',
    backend,
    heartbeatIntervalMs: 60_000,
    pollIntervalMs: 1,
    waitTimeoutMs: 200,
    staleAfterMs: 100,
    initializationReconcileMs: 1,
    ...overrides,
  })

describe('checkup heavy lease', () => {
  it('heartbeats through docker cp without a recurring Docker exec loop', async () => {
    const source = await readFile(join(repo, 'scripts/checkup/lease.mjs'), 'utf8')

    expect(source).toContain('heartbeatPath, `${container}:/lease/heartbeat`')
    expect(source).toContain("['cp', `${containerId}:/lease/heartbeat`")
    expect(source).not.toContain("['exec', spec.container")
  })

  it('stops advancing the heartbeat when the owner timer stops', async () => {
    const backend = new FakeLeaseBackend()
    const lease = await acquire(backend, 'owner', { heartbeatIntervalMs: 5 })

    await new Promise((resolve) => setTimeout(resolve, 18))
    expect(backend.heartbeatWrites).toBeGreaterThan(1)
    await lease.stopHeartbeat()
    const stoppedAt = backend.heartbeatWrites
    await new Promise((resolve) => setTimeout(resolve, 18))
    expect(backend.heartbeatWrites).toBe(stoppedAt)
    await lease.release()
  })

  it.each(['start', 'heartbeat'] as const)(
    'cleans the exact lease when %s initialization fails',
    async (stage) => {
      const backend = new FakeLeaseBackend()
      backend.startFailure = stage === 'start'
      backend.heartbeatFailure = stage === 'heartbeat'

      await expect(acquire(backend, 'broken')).rejects.toThrow(`${stage} failed`)
      expect(backend.current).toBeNull()
      expect(backend.removed).toContain('broken')
      expect(backend.volumeRemovals).toBe(1)
    },
  )

  it.each(['before', 'after', 'delayed'] as const)(
    'cleans failed lease creation when ownership is %s the failure',
    async (stage) => {
      const backend = new FakeLeaseBackend()
      backend.createFailure = stage

      await expect(acquire(backend, 'broken-create')).rejects.toThrow(
        /create (?:failed|timed out)/u,
      )
      expect(backend.current).toBeNull()
      expect(backend.volumeRemovals).toBe(1)
      expect(backend.removed).toEqual(stage === 'before' ? [] : ['broken-create'])
    },
  )

  it('reports an unreconciled timed-out create as incomplete cleanup', async () => {
    const backend = new FakeLeaseBackend()
    backend.createFailure = 'delayed-late'

    const error = await acquire(backend, 'late-create').catch((reason) => reason)

    expect(error).toMatchObject({
      name: 'LeaseInitializationCleanupError',
      cleanupErrors: [expect.stringMatching(/indeterminate.*late completion/iu)],
    })
    expect(backend.volumeRemovals).toBe(0)

    backend.completePendingCreate()
    expect(backend.current?.sessionId).toBe('late-create')
  })

  it('surfaces incomplete initialization cleanup as structured lease cleanup', async () => {
    const backend = new FakeLeaseBackend()
    backend.startFailure = true
    backend.volumeRemovalFailure = true

    const error = await acquire(backend, 'broken-cleanup').catch((reason) => reason)

    expect(error).toMatchObject({
      name: 'LeaseInitializationCleanupError',
      cleanupErrors: ['volume remove failed'],
    })
    expect(error.message).toMatch(/start failed.*volume remove failed/u)
  })

  it('coalesces heartbeat pressure to one in-flight write and one latest write', async () => {
    const backend = new FakeLeaseBackend()
    const lease = await acquire(backend, 'coalesced')
    let active = 0
    let maxActive = 0
    let writes = 0
    let releaseWrite!: () => void
    let block = true
    const blocked = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })

    backend.writeHeartbeat = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      writes += 1
      if (block) {
        await blocked
        block = false
      }
      active -= 1
    }
    const updates = Array.from({ length: 10 }, (_, index) =>
      lease.registerPhasePid('browser', 100 + index),
    )

    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(maxActive).toBe(1)
    releaseWrite()
    await Promise.all(updates)
    expect(maxActive).toBe(1)
    expect(writes).toBe(2)
    await lease.release()
  })

  it('uses one stable daemon-scoped name for repository clones', () => {
    expect(leaseNamesFor('git@example.test:notarium/notarium.git')).toEqual(
      leaseNamesFor('git@example.test:notarium/notarium.git'),
    )
    expect(leaseNamesFor('git@example.test:notarium/notarium.git')).not.toEqual(
      leaseNamesFor('git@example.test:other/notarium.git'),
    )
  })

  it('admits one contender and queues the next until release', async () => {
    const backend = new FakeLeaseBackend()
    const first = await acquire(backend, 'first')
    await first.assertHealthy()
    let secondResolved = false
    const secondPromise = acquire(backend, 'second').then((lease) => {
      secondResolved = true
      return lease
    })

    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(secondResolved).toBe(false)

    await first.release()
    const second = await secondPromise

    expect(second.waitMs).toBeGreaterThan(0)
    await second.release()
  })

  it('recovers only a stale owner with no live process and no runner', async () => {
    const backend = new FakeLeaseBackend()
    backend.current = {
      ...leaseNamesFor('git@example.test:notarium/notarium.git'),
      containerId: 'stale-container',
      sessionId: 'stale',
      subjectDigest: 'a'.repeat(64),
      owner: 'dead:10',
      ownerHost: 'dead',
      ownerPid: 10,
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      heartbeatIntervalMs: 60_000,
      heartbeatAt: Date.now() - 10_000,
      phases: {},
    }

    const lease = await acquire(backend, 'fresh', { ownerAlive: () => false })

    expect(lease.recovered).toMatchObject({ sessionId: 'stale', owner: 'dead:10' })
    expect(backend.removed).toContain('stale')
    await lease.release()
  })

  it('never removes a live successor that takes the lease name during stale recovery', async () => {
    const backend = new FakeLeaseBackend()
    backend.current = {
      ...leaseNamesFor('git@example.test:notarium/notarium.git'),
      containerId: 'stale-container',
      sessionId: 'stale',
      subjectDigest: 'a'.repeat(64),
      owner: 'dead:10',
      ownerHost: 'dead',
      ownerPid: 10,
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      heartbeatIntervalMs: 60_000,
      heartbeatAt: Date.now() - 10_000,
      phases: {},
    }
    backend.beforeRemoveLease = () => {
      backend.current = {
        ...leaseNamesFor('git@example.test:notarium/notarium.git'),
        containerId: 'successor-container',
        sessionId: 'successor',
        subjectDigest: 'b'.repeat(64),
        owner: 'live:20',
        ownerHost: 'live',
        ownerPid: 20,
        createdAt: new Date().toISOString(),
        heartbeatIntervalMs: 60_000,
        heartbeatAt: Date.now(),
        phases: {},
      }
    }

    await expect(
      acquire(backend, 'waiting', {
        ownerAlive: () => backend.current?.sessionId === 'successor',
        waitTimeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/u)
    expect(backend.current?.sessionId).toBe('successor')
    expect(backend.removed).not.toContain('successor')
    expect(backend.volumeRemovals).toBe(0)
  })

  it('recovers a stale phase whose owner died before it registered a pid', async () => {
    const backend = new FakeLeaseBackend()
    const abandoned = await acquire(backend, 'abandoned')

    await abandoned.beginPhase('coverage')
    await abandoned.stopHeartbeat()
    if (!backend.current) {
      throw new Error('expected the abandoned lease to exist')
    }
    backend.current.owner = 'dead:10'
    backend.current.ownerHost = 'dead'
    backend.current.ownerPid = 10
    backend.current.heartbeatAt = Date.now() - 10_000

    const fresh = await acquire(backend, 'fresh', { ownerAlive: () => false })

    expect(fresh.recovered).toMatchObject({ sessionId: 'abandoned' })
    expect(backend.removed).toContain('abandoned')
    await fresh.release()
  })

  it('times out rather than stealing a live or still-running owner', async () => {
    const backend = new FakeLeaseBackend()
    backend.current = {
      ...leaseNamesFor('git@example.test:notarium/notarium.git'),
      containerId: 'busy-container',
      sessionId: 'busy',
      subjectDigest: 'a'.repeat(64),
      owner: 'busy:10',
      ownerHost: 'busy',
      ownerPid: 10,
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      heartbeatIntervalMs: 60_000,
      heartbeatAt: Date.now() - 10_000,
      phases: {},
    }
    backend.runners = 1

    await expect(
      acquire(backend, 'waiting', {
        ownerAlive: () => false,
        waitTimeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out.*runners=1/u)
    expect(backend.removed).toEqual([])
  })

  it('does not steal from a detached heavy phase that survived its owner', async () => {
    const backend = new FakeLeaseBackend()
    backend.current = {
      ...leaseNamesFor('git@example.test:notarium/notarium.git'),
      containerId: 'building-container',
      sessionId: 'building',
      subjectDigest: 'a'.repeat(64),
      owner: 'dead:10',
      ownerHost: 'dead',
      ownerPid: 10,
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      heartbeatIntervalMs: 60_000,
      heartbeatAt: Date.now() - 10_000,
      phases: { coverage: [20] },
    }

    await expect(
      acquire(backend, 'waiting', {
        ownerAlive: () => false,
        phaseAlive: () => true,
        waitTimeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/u)
    expect(backend.removed).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a stale lease while the registered leader process group still lives',
    async () => {
      const leaderScript = [
        "const { spawn } = require('node:child_process')",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
        'child.unref()',
        'process.stdout.write(`${child.pid}\\n`)',
        'setImmediate(() => process.exit(0))',
      ].join(';')
      const leader = spawn(process.execPath, ['-e', leaderScript], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const leaderPid = leader.pid ?? 0
      const descendantReady = once(leader.stdout!, 'data')
      const leaderExit = once(leader, 'exit')

      try {
        const [chunk] = await descendantReady
        const descendantPid = Number(chunk)

        await leaderExit
        expect(leaderPid).toBeGreaterThan(0)
        expect(descendantPid).toBeGreaterThan(0)
        expect(() => process.kill(leaderPid, 0)).toThrow(/ESRCH/u)
        expect(() => process.kill(-leaderPid, 0)).not.toThrow()

        const backend = new FakeLeaseBackend()

        backend.current = {
          ...leaseNamesFor('git@example.test:notarium/notarium.git'),
          containerId: 'survivor-container',
          sessionId: 'survivor',
          subjectDigest: 'a'.repeat(64),
          owner: `${hostname()}:${leaderPid}`,
          ownerHost: hostname(),
          ownerPid: leaderPid,
          createdAt: new Date(Date.now() - 10_000).toISOString(),
          heartbeatIntervalMs: 60_000,
          heartbeatAt: Date.now() - 10_000,
          phases: { coverage: [leaderPid] },
        }

        await expect(acquire(backend, 'waiting', { waitTimeoutMs: 20 })).rejects.toThrow(
          /timed out/u,
        )
        expect(backend.removed).toEqual([])
      } finally {
        try {
          process.kill(-leaderPid, 'SIGKILL')
        } catch {
          // The process group may already be gone after a failed setup assertion.
        }
      }
    },
  )

  it('aborts a queued waiter without waiting for the lease timeout', async () => {
    const backend = new FakeLeaseBackend()
    const first = await acquire(backend, 'first')
    const controller = new AbortController()
    const waiting = acquire(backend, 'waiting', {
      signal: controller.signal,
      pollIntervalMs: 1_000,
      waitTimeoutMs: 10_000,
    })
    setTimeout(() => controller.abort(), 10)

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    await first.release()
  })
})
