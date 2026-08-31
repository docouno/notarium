import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { positiveInteger, stableLeaseKeyFor } from './contract.mjs'
import { processGroupIsAlive, processIdIsAlive } from './process.mjs'

const execFileAsync = promisify(execFile)
const LABEL_PREFIX = 'notarium.checkup'
export const DEFAULT_LEASE_HEARTBEAT_MS = 60_000

const leaseInitializationCleanupError = (error, cleanupErrors, sessionId) => {
  const details = cleanupErrors.map((entry) => entry?.message || String(entry))
  const aggregate = new AggregateError(
    [error, ...cleanupErrors],
    `heavy lease initialization failed for ${sessionId}: ${error?.message || String(error)}; cleanup incomplete: ${details.join('; ')}`,
    { cause: error },
  )

  aggregate.name = 'LeaseInitializationCleanupError'
  aggregate.cleanupErrors = details

  return aggregate
}

const sleep = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    const timer = setTimeout(done, milliseconds)

    const aborted = () => {
      clearTimeout(timer)
      const error = new Error('heavy lease wait aborted')
      error.name = 'AbortError'
      reject(error)
    }

    if (signal?.aborted) {
      aborted()
    } else {
      signal?.addEventListener('abort', aborted, { once: true })
    }
  })

const commandFailure = (args, error) => {
  const stderr = String(error?.stderr ?? '').trim()
  const stdout = String(error?.stdout ?? '').trim()
  const detail = stderr || stdout || error?.message || 'unknown docker error'
  const disposition = error?.code === 'ETIMEDOUT' || error?.killed === true ? 'timed out' : 'failed'

  return new Error(`docker ${args.join(' ')} ${disposition}: ${detail}`)
}

const runDocker = async (args, { allowFailure = false, timeoutMs = 15_000 } = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    })

    return { ok: true, stdout, stderr }
  } catch (error) {
    if (allowFailure) {
      return {
        ok: false,
        stdout: String(error?.stdout ?? ''),
        stderr: String(error?.stderr ?? ''),
        timedOut: error?.code === 'ETIMEDOUT' || error?.killed === true,
        error,
      }
    }
    throw commandFailure(args, error)
  }
}

export const leaseNamesFor = (repositoryIdentity) => {
  const key = stableLeaseKeyFor(repositoryIdentity)

  return {
    container: `notarium-checkup-lease-${key}`,
    volume: `notarium-checkup-lease-${key}-state`,
  }
}

export class DockerLeaseBackend {
  constructor({ image = process.env.CHECKUP_LEASE_IMAGE || 'node:24-slim' } = {}) {
    this.image = image
  }

  async ensureVolume(name) {
    await runDocker(['volume', 'create', name])
  }

  async ensureImage() {
    const inspected = await runDocker(['image', 'inspect', this.image], { allowFailure: true })

    if (inspected.timedOut) {
      throw commandFailure(['image', 'inspect', this.image], inspected.error)
    }
    if (inspected.ok) {
      return
    }
    if (!/No such (?:image|object)/iu.test(inspected.stderr)) {
      throw commandFailure(['image', 'inspect', this.image], inspected.error)
    }
    await runDocker(['pull', this.image], { timeoutMs: 5 * 60_000 })
  }

  async createLease(spec) {
    const labels = {
      [`${LABEL_PREFIX}.lease`]: 'true',
      [`${LABEL_PREFIX}.session`]: spec.sessionId,
      [`${LABEL_PREFIX}.subject`]: spec.subjectDigest,
      [`${LABEL_PREFIX}.owner`]: spec.owner,
      [`${LABEL_PREFIX}.ownerHost`]: spec.ownerHost,
      [`${LABEL_PREFIX}.ownerPid`]: String(spec.ownerPid),
      [`${LABEL_PREFIX}.createdAt`]: spec.createdAt,
    }
    const args = [
      'create',
      '--pull=never',
      '--name',
      spec.container,
      '--mount',
      `type=volume,src=${spec.volume},dst=/lease`,
    ]

    for (const [key, value] of Object.entries(labels)) {
      args.push('--label', `${key}=${value}`)
    }
    // The container is only the daemon-scoped atomic owner/sentinel. Heartbeats are
    // written by the owning host process through the archive API: owner death stops
    // time, while avoiding the recurring runc processes created by `docker exec`.
    args.push(
      '--entrypoint',
      'sh',
      this.image,
      '-c',
      "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
    )
    const result = await runDocker(args, { allowFailure: true, timeoutMs: 30_000 })

    if (result.ok) {
      return true
    }
    if (/already in use|Conflict/u.test(result.stderr)) {
      return false
    }
    const error = new Error(
      `could not create heavy lease: ${commandFailure(args, result.error).message}`,
      {
        cause: result.error,
      },
    )

    error.indeterminate = result.timedOut
    throw error
  }

  async startLease(spec) {
    await runDocker(['start', spec.container])
  }

  async writeHeartbeat(spec, timestamp, phaseState = {}) {
    const heartbeatRoot = await mkdtemp(join(tmpdir(), 'notarium-checkup-heartbeat-write-'))
    const heartbeatPath = join(heartbeatRoot, 'heartbeat')

    try {
      await writeFile(
        heartbeatPath,
        `${JSON.stringify({ at: Math.floor(timestamp / 1000), phases: phaseState })}\n`,
      )
      const container = spec.containerId || spec.container
      const copied = await runDocker(['cp', heartbeatPath, `${container}:/lease/heartbeat`], {
        allowFailure: true,
      })

      if (!copied.ok) {
        throw commandFailure(['cp', heartbeatPath, `${container}:/lease/heartbeat`], copied.error)
      }
    } finally {
      await rm(heartbeatRoot, { recursive: true, force: true })
    }
  }

  async inspectLease(spec) {
    const result = await runDocker(['inspect', spec.container], { allowFailure: true })

    if (result.timedOut) {
      throw commandFailure(['inspect', spec.container], result.error)
    }
    if (!result.ok) {
      return null
    }
    const inspected = JSON.parse(result.stdout)?.[0]
    const containerId = String(inspected?.Id ?? '')
    const labels = inspected?.Config?.Labels ?? {}

    if (!containerId) {
      throw new Error(`docker inspect returned no immutable identity for ${spec.container}`)
    }
    const heartbeatRoot = await mkdtemp(join(tmpdir(), 'notarium-checkup-heartbeat-'))
    const heartbeatPath = join(heartbeatRoot, 'heartbeat')
    let heartbeatSeconds = 0
    let phases = {}

    try {
      const copied = await runDocker(['cp', `${containerId}:/lease/heartbeat`, heartbeatPath], {
        allowFailure: true,
      })

      if (copied.timedOut) {
        throw commandFailure(['cp', `${containerId}:/lease/heartbeat`], copied.error)
      }
      if (copied.ok) {
        const heartbeat = (await readFile(heartbeatPath, 'utf8')).trim()

        try {
          const parsed = JSON.parse(heartbeat)
          heartbeatSeconds = Number(parsed.at)
          phases = parsed.phases && typeof parsed.phases === 'object' ? parsed.phases : {}
        } catch {
          // Backward-compatible recovery for leases written by the seconds-only format.
          heartbeatSeconds = Number(heartbeat)
        }
      }
    } finally {
      await rm(heartbeatRoot, { recursive: true, force: true })
    }

    return {
      containerId,
      sessionId: labels[`${LABEL_PREFIX}.session`] ?? '',
      subjectDigest: labels[`${LABEL_PREFIX}.subject`] ?? '',
      owner: labels[`${LABEL_PREFIX}.owner`] ?? '',
      ownerHost: labels[`${LABEL_PREFIX}.ownerHost`] ?? '',
      ownerPid: Number(labels[`${LABEL_PREFIX}.ownerPid`] ?? 0),
      createdAt: labels[`${LABEL_PREFIX}.createdAt`] ?? '',
      heartbeatAt: Number.isFinite(heartbeatSeconds) ? heartbeatSeconds * 1000 : 0,
      phases,
    }
  }

  async runnerCount(spec, sessionId) {
    const result = await runDocker([
      'ps',
      '-aq',
      '--filter',
      `label=${LABEL_PREFIX}.runner=true`,
      '--filter',
      `label=${LABEL_PREFIX}.session=${sessionId}`,
    ])

    return result.stdout.split('\n').filter(Boolean).length
  }

  async removeLease(spec, expected) {
    const containerId = expected?.containerId

    if (!containerId) {
      throw new TypeError(`refusing to remove ${spec.container} without its immutable identity`)
    }
    const result = await runDocker(['rm', '-f', containerId], { allowFailure: true })

    if (result.timedOut) {
      throw commandFailure(['rm', '-f', containerId], result.error)
    }
    if (!result.ok && !/No such (?:container|object)/u.test(result.stderr)) {
      throw commandFailure(['rm', '-f', containerId], result.error)
    }
  }

  async removeVolume(spec) {
    const result = await runDocker(['volume', 'rm', spec.volume], { allowFailure: true })

    if (result.timedOut) {
      throw commandFailure(['volume', 'rm', spec.volume], result.error)
    }
    if (!result.ok && !/no such volume/iu.test(result.stderr)) {
      throw commandFailure(['volume', 'rm', spec.volume], result.error)
    }
  }
}

const processIsAlive = async ({ ownerHost, ownerPid }) => {
  if (ownerHost !== hostname() || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    return false
  }

  return processIdIsAlive(ownerPid)
}

const phaseProcessIsAlive = async ({ ownerHost, ownerPid }) => {
  if (await processIsAlive({ ownerHost, ownerPid })) {
    return true
  }
  if (
    process.platform === 'win32' ||
    ownerHost !== hostname() ||
    !Number.isSafeInteger(ownerPid) ||
    ownerPid <= 0
  ) {
    return false
  }

  return processGroupIsAlive(ownerPid)
}

export const acquireHeavyLease = async ({
  repositoryIdentity,
  sessionId,
  subjectDigest,
  command,
  backend = new DockerLeaseBackend(),
  waitTimeoutMs = positiveInteger(
    process.env.CHECKUP_LEASE_WAIT_MS,
    30 * 60 * 1000,
    'CHECKUP_LEASE_WAIT_MS',
  ),
  staleAfterMs = positiveInteger(
    process.env.CHECKUP_LEASE_STALE_MS,
    2 * 60 * 1000,
    'CHECKUP_LEASE_STALE_MS',
  ),
  heartbeatIntervalMs = positiveInteger(
    process.env.CHECKUP_LEASE_HEARTBEAT_MS,
    DEFAULT_LEASE_HEARTBEAT_MS,
    'CHECKUP_LEASE_HEARTBEAT_MS',
  ),
  initializationReconcileMs = positiveInteger(
    process.env.CHECKUP_LEASE_RECONCILE_MS,
    1_000,
    'CHECKUP_LEASE_RECONCILE_MS',
  ),
  pollIntervalMs = 1_000,
  now = () => Date.now(),
  ownerAlive = /** @type {(lease: { ownerHost: string, ownerPid: number }) => boolean | Promise<boolean>} */ (
    processIsAlive
  ),
  phaseAlive = /** @type {(lease: { ownerHost: string, ownerPid: number }) => boolean | Promise<boolean>} */ (
    phaseProcessIsAlive
  ),
  onWait = () => {},
  signal = /** @type {AbortSignal | undefined} */ (undefined),
}) => {
  if (!repositoryIdentity || !sessionId || !subjectDigest) {
    throw new TypeError('heavy lease requires repositoryIdentity, sessionId and subjectDigest')
  }

  const names = leaseNamesFor(repositoryIdentity)
  const createdAt = new Date(now()).toISOString()
  const spec = {
    ...names,
    sessionId,
    subjectDigest,
    command: command || 'checkup',
    owner: `${hostname()}:${process.pid}`,
    ownerHost: hostname(),
    ownerPid: process.pid,
    createdAt,
    heartbeatIntervalMs,
  }
  const startedWaitingAt = now()
  let recovered = null
  const isOwnedLease = (lease) =>
    Boolean(
      lease?.containerId &&
      lease.sessionId === spec.sessionId &&
      lease.subjectDigest === spec.subjectDigest &&
      lease.owner === spec.owner &&
      lease.ownerHost === spec.ownerHost &&
      lease.ownerPid === spec.ownerPid &&
      lease.createdAt === spec.createdAt,
    )

  const failInitialization = async (error) => {
    const cleanupErrors = []
    let current = null
    const attempts = error?.indeterminate ? 5 : 1

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        current = await backend.inspectLease(spec)
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
        break
      }
      if (current || attempt === attempts - 1) {
        break
      }
      await sleep(initializationReconcileMs)
    }
    if (cleanupErrors.length === 0 && current && isOwnedLease(current)) {
      const failedLease = current

      try {
        await backend.removeLease(spec, failedLease)
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
      if (cleanupErrors.length === 0) {
        let remaining = null

        try {
          remaining = await backend.inspectLease(spec)
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
        if (remaining?.containerId === failedLease.containerId) {
          cleanupErrors.push(
            new Error(
              `lease container ${failedLease.containerId} remains for session ${sessionId}`,
            ),
          )
        } else if (!remaining && cleanupErrors.length === 0) {
          try {
            await backend.removeVolume(spec)
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError)
          }
        }
      }
    } else if (cleanupErrors.length === 0 && error?.indeterminate) {
      cleanupErrors.push(
        new Error(
          `indeterminate lease creation for ${sessionId} was not reconciled; cleanup is incomplete because a late completion can still create the lease container`,
        ),
      )
    } else if (cleanupErrors.length === 0 && !current) {
      try {
        await backend.removeVolume(spec)
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (cleanupErrors.length) {
      throw leaseInitializationCleanupError(error, cleanupErrors, sessionId)
    }
    throw error
  }

  await backend.ensureImage?.()
  await backend.ensureVolume(spec.volume)

  for (;;) {
    if (signal?.aborted) {
      const error = new Error('heavy lease wait aborted')
      error.name = 'AbortError'
      throw error
    }
    let created

    try {
      created = await backend.createLease(spec)
    } catch (error) {
      await failInitialization(error)
    }
    if (created) {
      let acquiredLease

      try {
        await backend.startLease(spec)
        await backend.writeHeartbeat(spec, now(), {})
        acquiredLease = await backend.inspectLease(spec)
        if (!isOwnedLease(acquiredLease)) {
          throw new Error(`heavy lease ownership could not be verified for session ${sessionId}`)
        }
      } catch (error) {
        await failInitialization(error)
      }
      const ownedSpec = { ...spec, containerId: acquiredLease.containerId }
      let heartbeatError = null
      let heartbeatTask = Promise.resolve()
      let heartbeatInFlight = false
      let heartbeatPending = false
      let heartbeatStopped = false
      const phases = new Map()

      const phaseSnapshot = () =>
        Object.fromEntries([...phases].map(([name, pids]) => [name, [...pids]]))

      const publishHeartbeat = () => {
        heartbeatPending = true
        if (!heartbeatInFlight) {
          heartbeatInFlight = true
          heartbeatTask = (async () => {
            while (heartbeatPending) {
              heartbeatPending = false
              try {
                await backend.writeHeartbeat(ownedSpec, now(), phaseSnapshot())
              } catch (error) {
                heartbeatError = error
              }
            }
          })().finally(() => {
            heartbeatInFlight = false
          })
        }

        return heartbeatTask
      }

      const tick = () => {
        if (heartbeatStopped) {
          return
        }
        void publishHeartbeat()
      }
      const timer = setInterval(tick, heartbeatIntervalMs)
      timer.unref?.()
      const stopHeartbeat = async () => {
        if (heartbeatStopped) {
          return
        }
        heartbeatStopped = true
        clearInterval(timer)
        await heartbeatTask
      }

      const updatePhase = async (name, updater) => {
        const pids = new Set(phases.get(name) ?? [])
        updater(pids)
        if (pids.size) {
          phases.set(name, pids)
        } else if (phases.has(name)) {
          phases.set(name, pids)
        }
        await publishHeartbeat()
        if (heartbeatError) {
          throw new Error(`heavy lease heartbeat failed: ${heartbeatError.message}`)
        }
      }
      let released = false

      return {
        ...ownedSpec,
        recovered,
        waitMs: now() - startedWaitingAt,
        assertHealthy: async () => {
          if (heartbeatError) {
            throw new Error(`heavy lease heartbeat failed: ${heartbeatError.message}`)
          }
          const current = await backend.inspectLease(ownedSpec)
          const heartbeatAt = current?.heartbeatAt || Date.parse(current?.createdAt ?? '') || 0

          if (current?.containerId !== acquiredLease.containerId || !isOwnedLease(current)) {
            throw new Error(`heavy lease ownership was lost by session ${sessionId}`)
          }
          if (now() - heartbeatAt > staleAfterMs) {
            throw new Error(`heavy lease heartbeat became stale for session ${sessionId}`)
          }
        },
        stopHeartbeat,
        beginPhase: async (name) => {
          phases.set(name, new Set())
          await publishHeartbeat()
          if (heartbeatError) {
            throw new Error(`heavy lease heartbeat failed: ${heartbeatError.message}`)
          }
        },
        registerPhasePid: (name, pid) => updatePhase(name, (pids) => pids.add(pid)),
        endPhase: async (name) => {
          phases.delete(name)
          await publishHeartbeat()
          if (heartbeatError) {
            throw new Error(`heavy lease heartbeat failed: ${heartbeatError.message}`)
          }
        },
        release: async () => {
          if (released) {
            return
          }
          released = true
          await stopHeartbeat()
          await backend.removeLease(ownedSpec, acquiredLease)
          let remaining = await backend.inspectLease(ownedSpec)

          if (remaining?.containerId === acquiredLease.containerId) {
            throw new Error(
              `lease container ${acquiredLease.containerId} remains for session ${sessionId}`,
            )
          }
          if (!remaining) {
            try {
              await backend.removeVolume(ownedSpec)
            } catch (error) {
              remaining = await backend.inspectLease(ownedSpec)
              if (!remaining) {
                throw error
              }
            }
          }
        },
      }
    }

    const current = await backend.inspectLease(spec)
    const elapsed = now() - startedWaitingAt

    if (!current) {
      continue
    }
    const heartbeatAt = current.heartbeatAt || Date.parse(current.createdAt) || 0
    const heartbeatAgeMs = now() - heartbeatAt
    const runners = await backend.runnerCount(spec, current.sessionId)
    const liveOwner = await ownerAlive(current)
    const phasePidRows = Object.values(current.phases ?? {})
    const phasePids = phasePidRows.flatMap((pids) => (Array.isArray(pids) ? pids : []))
    const livePhase = (
      await Promise.all(
        phasePids.map((pid) => phaseAlive({ ownerHost: current.ownerHost, ownerPid: Number(pid) })),
      )
    ).some(Boolean)
    const uncertainPhase = phasePids.length > 0 && current.ownerHost !== hostname()

    if (
      heartbeatAgeMs > staleAfterMs &&
      !liveOwner &&
      !livePhase &&
      !uncertainPhase &&
      runners === 0
    ) {
      const staleLease = current
      const recovery = {
        sessionId: current.sessionId,
        owner: current.owner,
        heartbeatAgeMs,
      }
      await backend.removeLease(spec, staleLease)
      let remaining = await backend.inspectLease(spec)

      if (remaining?.containerId === staleLease.containerId) {
        throw new Error(
          `stale lease container ${staleLease.containerId} remains for session ${staleLease.sessionId}`,
        )
      }
      if (remaining) {
        continue
      }
      try {
        await backend.removeVolume(spec)
      } catch (error) {
        remaining = await backend.inspectLease(spec)
        if (remaining) {
          continue
        }
        throw error
      }
      await backend.ensureVolume(spec.volume)
      recovered = recovery
      continue
    }
    if (elapsed >= waitTimeoutMs) {
      throw new Error(
        `heavy lease wait timed out after ${elapsed}ms; owner=${current.owner || 'unknown'} session=${current.sessionId || 'unknown'} heartbeatAgeMs=${heartbeatAgeMs} runners=${runners}`,
      )
    }

    onWait({ elapsed, heartbeatAgeMs, liveOwner, livePhase, uncertainPhase, runners, current })
    await sleep(Math.min(pollIntervalMs, waitTimeoutMs - elapsed), signal)
  }
}
