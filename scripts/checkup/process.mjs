import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'

const numberFrom = (value) => {
  const parsed = Number(value)

  return Number.isFinite(parsed) ? parsed : 0
}

export const isLiveLinuxProcessState = (state) =>
  typeof state === 'string' && state.length > 0 && !['X', 'x', 'Z'].includes(state)

const parsedProcessStat = (value) => {
  const commandEnd = value.lastIndexOf(')')

  if (commandEnd < 0) {
    return null
  }
  const fields = value
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u)
  const state = fields[0]
  const processGroupId = Number(fields[2])
  const startTime = fields[19]

  return state && Number.isSafeInteger(processGroupId) && processGroupId >= 0 && startTime
    ? { state, processGroupId, startTime }
    : null
}

const missingProcessError = (error) => error?.code === 'ENOENT' || error?.code === 'ESRCH'

const processStat = async (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: 'missing', value: null }
  }
  if (process.platform !== 'linux') {
    return { status: 'unavailable', value: null }
  }

  try {
    const value = parsedProcessStat(await readFile(`/proc/${pid}/stat`, 'utf8'))

    return value ? { status: 'available', value } : { status: 'unavailable', value: null }
  } catch (error) {
    return missingProcessError(error)
      ? { status: 'missing', value: null }
      : { status: 'unavailable', value: null }
  }
}

const signalTargetExists = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false
    }
    if (error?.code === 'EPERM') {
      return true
    }
    throw error
  }
}

export const processIdIsAlive = async (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !signalTargetExists(pid)) {
    return false
  }
  const current = await processStat(pid)

  if (current.status === 'available') {
    return isLiveLinuxProcessState(current.value.state)
  }

  // A successful signal probe is the only safe answer when Linux /proc is unavailable.
  return true
}

const processGroupStat = async (processGroupId) => {
  let entries

  try {
    entries = await readdir('/proc', { withFileTypes: true })
  } catch {
    return { status: 'unavailable', live: false }
  }
  const results = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
      .map((entry) => processStat(Number(entry.name))),
  )

  // One unreadable member means the scan cannot prove that the group contains only zombies.
  if (results.some((result) => result.status === 'unavailable')) {
    return { status: 'unavailable', live: false }
  }

  return {
    status: 'available',
    live: results.some(
      (result) =>
        result.status === 'available' &&
        result.value.processGroupId === processGroupId &&
        isLiveLinuxProcessState(result.value.state),
    ),
  }
}

const processGroupEmptyScanCount = 3
const processGroupRescanIntervalMs = 5
const waitForProcessGroupRescan = (milliseconds) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))

/**
 * @param {{
 *   groupExists: () => boolean | Promise<boolean>
 *   scanGroup: () => { status: string, live: boolean } | Promise<{ status: string, live: boolean }>
 *   waitForRescan?: (milliseconds: number) => void | Promise<void>
 * }} probes
 */
export const processGroupIsAliveFromProbes = async ({
  groupExists,
  scanGroup,
  waitForRescan = waitForProcessGroupRescan,
}) => {
  for (let emptyScans = 0; emptyScans < processGroupEmptyScanCount; emptyScans += 1) {
    if (!(await groupExists())) {
      return false
    }
    const group = await scanGroup()

    if (group.status !== 'available' || group.live) {
      return true
    }
    if (emptyScans + 1 < processGroupEmptyScanCount) {
      await waitForRescan(processGroupRescanIntervalMs)
    }
  }

  return false
}

export const processGroupIsAlive = async (processGroupId) => {
  if (
    process.platform === 'win32' ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0
  ) {
    return false
  }
  if (process.platform !== 'linux') {
    return signalTargetExists(-processGroupId)
  }

  return processGroupIsAliveFromProbes({
    groupExists: () => signalTargetExists(-processGroupId),
    scanGroup: () => processGroupStat(processGroupId),
  })
}

const processChildren = async (pid) => {
  try {
    const value = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')

    return value.trim().split(/\s+/u).filter(Boolean).map(Number).filter(Number.isSafeInteger)
  } catch {
    return []
  }
}

export const processTree = async (rootPid) => {
  const queue = [rootPid]
  const seen = new Set()

  while (queue.length) {
    const pid = queue.shift()

    if (!Number.isSafeInteger(pid) || pid <= 0 || seen.has(pid)) {
      continue
    }
    seen.add(pid)
    queue.push(...(await processChildren(pid)))
  }

  return [...seen]
}

const signalProcess = (pid, signal) => {
  try {
    process.kill(pid, signal)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

export const processIdentity = async (pid) => {
  const current = await processStat(pid)

  if (current.status !== 'available' || !isLiveLinuxProcessState(current.value.state)) {
    return null
  }

  return { pid, startTime: current.value.startTime }
}

export const processIdentities = async (pids) =>
  (await Promise.all([...new Set(pids)].map(processIdentity))).filter(Boolean)

const currentIdentity = async ({ pid, startTime }, { unavailableIsLive = false } = {}) => {
  const current = await processStat(pid)

  if (current.status === 'unavailable') {
    return unavailableIsLive && signalTargetExists(pid) ? { pid, startTime } : null
  }

  return current.status === 'available' &&
    isLiveLinuxProcessState(current.value.state) &&
    current.value.startTime === startTime
    ? { pid, startTime }
    : null
}

export const liveProcessIdentities = async (identities) =>
  (
    await Promise.all(
      identities.map((identity) => currentIdentity(identity, { unavailableIsLive: true })),
    )
  ).filter(Boolean)

export const signalProcessIdentities = async (identities, signal) => {
  const signalled = []

  for (const identity of [...identities].reverse()) {
    const current = await currentIdentity(identity)

    if (current && signalProcess(current.pid, signal)) {
      signalled.push(current)
    }
  }

  return signalled
}

export const signalProcessTree = async ({ rootPid, signal }) => {
  const identities = await processIdentities(await processTree(rootPid))

  if (!identities.length) {
    return []
  }

  await signalProcessIdentities(identities, signal)

  return identities
}

export const processIdsWithEnvironment = async (name, value) => {
  let entries

  try {
    entries = await readdir('/proc', { withFileTypes: true })
  } catch {
    return []
  }
  const expected = `${name}=${value}`
  const matches = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
      .map(async (entry) => {
        try {
          const environment = await readFile(`/proc/${entry.name}/environ`)

          return environment.toString().split('\0').includes(expected) ? Number(entry.name) : null
        } catch {
          return null
        }
      }),
  )

  return matches.filter((pid) => Number.isSafeInteger(pid))
}

const processSample = async (pid) => {
  try {
    const [stat, status, io] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/status`, 'utf8'),
      readFile(`/proc/${pid}/io`, 'utf8'),
    ])
    const afterCommand = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u)
    const rssKb = numberFrom(/^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1])
    const readBytes = numberFrom(/^read_bytes:\s+(\d+)$/mu.exec(io)?.[1])
    const writeBytes = numberFrom(/^write_bytes:\s+(\d+)$/mu.exec(io)?.[1])

    return {
      pid,
      cpuTicks: numberFrom(afterCommand[11]) + numberFrom(afterCommand[12]),
      rssBytes: rssKb * 1024,
      readBytes,
      writeBytes,
    }
  } catch {
    return null
  }
}

export const createProcessSampler = ({ rootPid, intervalMs = 250 }) => {
  const perPid = new Map()
  const observedPids = new Set()
  let samplesTaken = 0
  let maxBusyProcesses = 0
  let peakRssBytes = 0
  let stopped = false
  let sampling = false

  const sample = async () => {
    if (stopped || sampling) {
      return
    }
    sampling = true
    try {
      const pids = await processTree(rootPid)
      const values = (await Promise.all(pids.map(processSample))).filter(Boolean)

      if (!values.length) {
        return
      }
      samplesTaken += 1
      maxBusyProcesses = Math.max(maxBusyProcesses, values.length)
      peakRssBytes = Math.max(
        peakRssBytes,
        values.reduce((sum, value) => sum + value.rssBytes, 0),
      )

      for (const value of values) {
        observedPids.add(value.pid)
        const previous = perPid.get(value.pid) ?? {
          cpuTicks: 0,
          readBytes: 0,
          writeBytes: 0,
        }

        perPid.set(value.pid, {
          cpuTicks: Math.max(previous.cpuTicks, value.cpuTicks),
          readBytes: Math.max(previous.readBytes, value.readBytes),
          writeBytes: Math.max(previous.writeBytes, value.writeBytes),
        })
      }
    } finally {
      sampling = false
    }
  }
  const timer = setInterval(() => void sample(), intervalMs)
  timer.unref?.()
  void sample()

  return {
    stop: async () => {
      clearInterval(timer)
      await sample()
      stopped = true

      if (!samplesTaken) {
        return {
          capability: 'unavailable',
          reason: 'process-exited-before-first-sample',
          intervalMs,
          samplesTaken: 0,
        }
      }

      return {
        capability: 'sampled',
        semantics: 'sampled-lower-bound',
        intervalMs,
        samplesTaken,
        observedPidCount: observedPids.size,
        maxBusyProcesses,
        peakRssBytes,
        cpuTicksLowerBound: [...perPid.values()].reduce((sum, value) => sum + value.cpuTicks, 0),
        readBytesLowerBound: [...perPid.values()].reduce((sum, value) => sum + value.readBytes, 0),
        writeBytesLowerBound: [...perPid.values()].reduce(
          (sum, value) => sum + value.writeBytes,
          0,
        ),
      }
    },
  }
}

const boundedTimerDuration = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError(`${name} must be a safe integer between 1 and 60000, got ${value}`)
  }

  return value
}

const terminationSignalFrom = (signal) => (signal?.reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM')
const processGroupPollIntervalMs = 20
const processGroupKillWaitMs = 1_000

export class PhaseOwnershipIncompleteError extends Error {
  /**
   * @param {{
   *   phase: string
   *   rootPid?: number | null
   *   leaderFinished: boolean
   *   groupAlive: boolean
   *   phaseResult?: Record<string, unknown> | null
   * }} details
   */
  constructor({ phase, rootPid, leaderFinished, groupAlive, phaseResult = null }) {
    const failures = []

    if (!leaderFinished) {
      failures.push(`leader ${rootPid ?? 'unknown'} did not report exit after SIGKILL`)
    }
    if (groupAlive) {
      failures.push(`process group ${rootPid ?? 'unknown'} survived SIGKILL`)
    }
    super(`checkup phase ${phase} termination timed out: ${failures.join('; ')}`)
    this.name = 'PhaseOwnershipIncompleteError'
    this.code = 'CHECKUP_PHASE_OWNERSHIP_INCOMPLETE'
    this.phase = phase
    this.rootPid = rootPid ?? null
    this.leaderFinished = leaderFinished
    this.groupAlive = groupAlive
    this.phaseResult = phaseResult
    this.ownershipIncomplete = true
  }
}

export const phaseOwnershipIncompleteErrors = (error) => {
  const errors = []
  const seen = new Set()

  const visit = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return
    }
    seen.add(value)

    if (
      value instanceof PhaseOwnershipIncompleteError ||
      (value.name === 'PhaseOwnershipIncompleteError' && value.ownershipIncomplete === true)
    ) {
      errors.push(value)
    }
    if (Array.isArray(value.errors)) {
      for (const nested of value.errors) {
        visit(nested)
      }
    }
    visit(value.cause)
  }

  visit(error)

  return errors
}

export const runPhase = ({
  name,
  command,
  args = /** @type {string[]} */ ([]),
  cwd = process.cwd(),
  env = process.env,
  samplerIntervalMs = 250,
  stdio = /** @type {import('node:child_process').StdioOptions} */ ('inherit'),
  onSpawn = /** @type {(child: import('node:child_process').ChildProcess) => void | Promise<void>} */ (
    () => {}
  ),
  onSpawnFailureKillGraceMs = 1_000,
  terminationSignal = /** @type {AbortSignal | undefined} */ (undefined),
  terminationKillGraceMs = 30_000,
}) =>
  new Promise((resolve, reject) => {
    const spawnFailureGraceMs = boundedTimerDuration(
      onSpawnFailureKillGraceMs,
      'onSpawnFailureKillGraceMs',
    )
    const signalGraceMs = boundedTimerDuration(terminationKillGraceMs, 'terminationKillGraceMs')
    const startedAt = new Date().toISOString()
    const started = process.hrtime.bigint()
    const child = spawn(command, args, {
      cwd,
      env,
      stdio,
      detached: process.platform !== 'win32',
    })
    const sampler = createProcessSampler({ rootPid: child.pid, intervalMs: samplerIntervalMs })
    let settled = false
    let ownershipError = null
    let primaryError = null
    let leaderExit = null
    let leaderFinished = false
    let terminationRequested = false
    let terminationState = null
    let terminationTask = null
    let normalCompletionScheduled = false
    let ownershipSettled = false
    let ownershipSucceeded = false

    const signalChildGroup = (signal) => {
      try {
        if (process.platform === 'win32' || !child.pid) {
          child.kill(signal)
        } else {
          process.kill(-child.pid, signal)
        }
      } catch {
        // The child may have exited between the request and group signal.
      }
    }

    const childProcessGroupAlive = async () => {
      if (process.platform === 'win32' || !child.pid) {
        return false
      }

      return processGroupIsAlive(child.pid)
    }

    const finish = async ({ error = null, result = null }) => {
      if (settled) {
        return
      }
      settled = true
      terminationSignal?.removeEventListener('abort', onTermination)
      const diagnostics = await sampler.stop()

      if (result) {
        result.diagnostics = diagnostics
      }
      const errors = [...new Set([ownershipError, primaryError, error].filter(Boolean))]

      if (result) {
        for (const ownershipIncomplete of errors.flatMap(phaseOwnershipIncompleteErrors)) {
          ownershipIncomplete.phaseResult = result
        }
      }

      if (errors.length > 1) {
        reject(new AggregateError(errors, errors.map((entry) => entry.message).join('; ')))
      } else if (errors.length) {
        reject(errors[0])
      } else {
        resolve(result)
      }
    }

    const phaseResult = () =>
      leaderExit
        ? {
            name,
            command: [command, ...args],
            startedAt,
            endedAt: new Date().toISOString(),
            wallMs: Number(process.hrtime.bigint() - started) / 1_000_000,
            exitCode: leaderExit.exitCode,
            signal: leaderExit.signal,
            diagnostics: null,
          }
        : null

    const terminationFailure = ({ groupAlive }) =>
      new PhaseOwnershipIncompleteError({
        phase: name,
        rootPid: child.pid,
        leaderFinished,
        groupAlive,
        phaseResult: phaseResult(),
      })

    const driveTermination = () => {
      if (terminationTask) {
        return terminationTask
      }

      terminationTask = (async () => {
        try {
          while (!settled) {
            const groupAlive = await childProcessGroupAlive()

            if (leaderFinished && !groupAlive) {
              await finish({ result: phaseResult() })
              return
            }

            const now = Date.now()

            if (!terminationState.forceKillSentAt && now >= terminationState.forceKillAt) {
              terminationState.forceKillSentAt = now
              terminationState.postKillDeadline = now + processGroupKillWaitMs
              signalChildGroup('SIGKILL')
              continue
            }
            if (terminationState.forceKillSentAt && now >= terminationState.postKillDeadline) {
              await finish({ error: terminationFailure({ groupAlive }), result: phaseResult() })
              return
            }

            const deadline = terminationState.forceKillSentAt
              ? terminationState.postKillDeadline
              : terminationState.forceKillAt

            await new Promise((resolveWait) =>
              setTimeout(
                resolveWait,
                Math.min(processGroupPollIntervalMs, Math.max(1, deadline - now)),
              ),
            )
          }
        } catch (error) {
          await finish({ error, result: phaseResult() })
        }
      })()

      return terminationTask
    }

    const terminate = (signal, error = null, graceMs = signalGraceMs) => {
      ownershipError ||= error
      if (settled) {
        return
      }
      if (!terminationRequested) {
        terminationRequested = true
        terminationState = {
          forceKillAt: Date.now() + graceMs,
          forceKillSentAt: 0,
          postKillDeadline: 0,
        }
        signalChildGroup(signal)
      }
      void driveTermination()
    }
    const onTermination = () => terminate(terminationSignalFrom(terminationSignal))

    const scheduleNormalCompletion = () => {
      if (normalCompletionScheduled) {
        return
      }
      normalCompletionScheduled = true
      setImmediate(() => {
        normalCompletionScheduled = false
        if (
          !settled &&
          !terminationRequested &&
          leaderFinished &&
          ownershipSettled &&
          ownershipSucceeded
        ) {
          void finish({ result: phaseResult() })
        }
      })
    }

    const onChildError = (error) => {
      primaryError ||= error

      if (!child.pid) {
        leaderFinished = true
      }
      terminate('SIGTERM')
    }

    child.on('error', onChildError)
    child.once('exit', (exitCode, signal) => {
      leaderExit = { exitCode, signal }
      leaderFinished = true

      if (terminationRequested) {
        void driveTermination()
      } else {
        scheduleNormalCompletion()
      }
    })
    if (terminationSignal?.aborted) {
      onTermination()
    } else {
      terminationSignal?.addEventListener('abort', onTermination, { once: true })
    }
    try {
      const ownership = onSpawn(child)

      void Promise.resolve(ownership).then(
        () => {
          ownershipSettled = true
          ownershipSucceeded = true
          if (leaderFinished && !terminationRequested) {
            scheduleNormalCompletion()
          }
        },
        (error) => {
          ownershipSettled = true
          terminate('SIGTERM', error, spawnFailureGraceMs)
        },
      )
    } catch (error) {
      ownershipSettled = true
      terminate('SIGTERM', error, spawnFailureGraceMs)
    }
  })
