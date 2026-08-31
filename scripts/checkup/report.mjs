import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { arch, availableParallelism, cpus, hostname, platform, totalmem } from 'node:os'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { CHECKUP_DRIVER_VERSION, CHECKUP_REPORT_SCHEMA } from './contract.mjs'

const execFileAsync = promisify(execFile)

const optionalFile = async (path) => {
  try {
    return { capability: 'exact', value: (await readFile(path, 'utf8')).trim() }
  } catch (error) {
    return { capability: 'unavailable', reason: error?.code || 'read-failed' }
  }
}

const commandValue = async (command, args) => {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: 'utf8' })

    return { capability: 'exact', value: stdout.trim() }
  } catch (error) {
    return { capability: 'unavailable', reason: error?.code || 'command-failed' }
  }
}

export const environmentEvidence = async () => ({
  host: hostname(),
  platform: platform(),
  architecture: arch(),
  node: process.version,
  availableParallelism: availableParallelism(),
  visibleCpuCount: cpus().length,
  visibleMemoryBytes: totalmem(),
  cgroup: {
    type: await optionalFile('/sys/fs/cgroup/cgroup.type'),
    cpuMax: await optionalFile('/sys/fs/cgroup/cpu.max'),
    memoryMax: await optionalFile('/sys/fs/cgroup/memory.max'),
    cpuset: await optionalFile('/sys/fs/cgroup/cpuset.cpus.effective'),
  },
  npm: await commandValue('npm', ['--version']),
  glibc: await commandValue('ldd', ['--version']),
  dockerServer: await commandValue('docker', ['version', '--format', '{{.Server.Version}}']),
})

export const newCheckupReport = ({ sessionId, driverDigest, subject, snapshot }) => ({
  schemaVersion: CHECKUP_REPORT_SCHEMA,
  driver: { version: CHECKUP_DRIVER_VERSION, digest: driverDigest },
  sessionId,
  state: 'running',
  startedAt: new Date().toISOString(),
  endedAt: null,
  subject,
  snapshot,
  environment: null,
  profile: null,
  lease: null,
  phases: [],
  cleanup: { completed: false, errors: [] },
  verdict: null,
})

export const writeCheckupReport = async (path, report) => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`

  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`)
  await rename(temporary, path)
}

export const finishCheckupReport = (report, { exitCode, cleanupErrors = [] }) => {
  report.state = 'finished'
  report.endedAt = new Date().toISOString()
  report.cleanup = { completed: cleanupErrors.length === 0, errors: cleanupErrors }
  report.verdict = exitCode === 0 && cleanupErrors.length === 0 ? 'passed' : 'failed'
  report.measurement = report.phases.length
    ? {
        executionWallMs: Date.parse(report.endedAt) - Date.parse(report.phases[0].startedAt),
        phaseWallMs: report.phases.reduce((sum, phase) => sum + phase.wallMs, 0),
        leaseWaitMs: report.lease?.waitMs ?? 0,
      }
    : null

  return report
}

const assertRecord = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`checkup report ${name} must be an object`)
  }

  return value
}

const assertDigest = (value, name) => {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`checkup report ${name} must be a SHA-256 digest`)
  }

  return value
}

const assertMeasurement = (value, name) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`checkup report ${name} must be a non-negative finite number`)
  }

  return value
}

export const assertPassedCheckupReport = (
  value,
  { mode, gitHead, expectedPhases, expectedSnapshotVerificationCount } = {},
) => {
  const report = assertRecord(value, 'root')
  const driver = assertRecord(report.driver, 'driver')
  const subject = assertRecord(report.subject, 'subject')
  const snapshot = assertRecord(report.snapshot, 'snapshot')
  const cleanup = assertRecord(report.cleanup, 'cleanup')
  const measurement = assertRecord(report.measurement, 'measurement')

  if (report.schemaVersion !== CHECKUP_REPORT_SCHEMA) {
    throw new TypeError(
      `checkup report schemaVersion must be ${CHECKUP_REPORT_SCHEMA}, got ${JSON.stringify(report.schemaVersion)}`,
    )
  }
  if (driver.version !== CHECKUP_DRIVER_VERSION) {
    throw new TypeError(
      `checkup report driver.version must be ${CHECKUP_DRIVER_VERSION}, got ${JSON.stringify(driver.version)}`,
    )
  }
  assertDigest(driver.digest, 'driver.digest')
  if (report.state !== 'finished' || report.verdict !== 'passed') {
    throw new Error(
      `checkup report must be finished and passed, got state=${JSON.stringify(report.state)} verdict=${JSON.stringify(report.verdict)}`,
    )
  }
  if (report.error !== undefined && report.error !== null) {
    throw new Error('checkup report cannot be passed while carrying an error')
  }
  if (mode && subject.mode !== mode) {
    throw new Error(
      `checkup report subject.mode must be ${mode}, got ${JSON.stringify(subject.mode)}`,
    )
  }
  if (gitHead && subject.gitHead !== gitHead) {
    throw new Error(
      `checkup report subject.gitHead must be ${gitHead}, got ${JSON.stringify(subject.gitHead)}`,
    )
  }
  if (subject.dirty !== false) {
    throw new Error(`checkup comparison requires a clean subject, got dirty=${subject.dirty}`)
  }
  assertDigest(subject.sourceDigest, 'subject.sourceDigest')
  if (snapshot.verifiedAfterRun !== true) {
    throw new Error('checkup report snapshot must be verified after the run')
  }
  if (snapshot.verifiedBeforeHeavy !== true) {
    throw new Error('checkup report snapshot must be verified before heavy consumption')
  }
  if (
    expectedSnapshotVerificationCount !== undefined &&
    snapshot.verificationsBeforeHeavy !== expectedSnapshotVerificationCount
  ) {
    throw new Error(
      `checkup report snapshot verification count must be ${expectedSnapshotVerificationCount}, got ${JSON.stringify(snapshot.verificationsBeforeHeavy)}`,
    )
  }
  if (cleanup.completed !== true || !Array.isArray(cleanup.errors) || cleanup.errors.length) {
    throw new Error('checkup report cleanup must be complete and error-free')
  }
  if (!Array.isArray(report.phases) || !report.phases.length) {
    throw new TypeError('checkup report phases must be a non-empty array')
  }
  if (expectedPhases) {
    const actualPhases = report.phases.map((phase) => phase?.name)

    if (
      actualPhases.length !== expectedPhases.length ||
      actualPhases.some((name, index) => name !== expectedPhases[index])
    ) {
      throw new Error(
        `checkup report phase contract mismatch: expected=${JSON.stringify(expectedPhases)} actual=${JSON.stringify(actualPhases)}`,
      )
    }
  }
  if (expectedPhases && !Array.isArray(report.lease?.bookkeepingErrors)) {
    throw new TypeError('checkup report lease.bookkeepingErrors must be an array')
  }
  if (report.lease?.bookkeepingErrors?.length) {
    throw new Error('checkup report lease bookkeeping must be error-free')
  }
  for (const value of report.phases) {
    const phase = assertRecord(value, 'phase')

    if (phase.exitCode !== 0 || phase.signal !== null) {
      throw new Error(
        `checkup report passed verdict conflicts with phase ${JSON.stringify(phase.name)}`,
      )
    }
  }
  assertMeasurement(measurement.executionWallMs, 'measurement.executionWallMs')
  assertMeasurement(measurement.phaseWallMs, 'measurement.phaseWallMs')
  assertMeasurement(measurement.leaseWaitMs, 'measurement.leaseWaitMs')

  return report
}
