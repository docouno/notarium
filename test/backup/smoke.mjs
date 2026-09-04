// Destructive restore drill, isolated in disposable Docker containers + volumes.
// It proves the shipped production CLIs, live-write retry, a cold rebuild, and that an
// unfinished durable import crosses the archive with its bytes and its queue row intact
// while maintenance runs. canon: docs/backup.md

import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'

import { publishTarget } from '../../scripts/dockerHost.mjs'
import { fixtureArgv } from './fixtureArgv.mjs'

// Both are content-addressed image IDs handed over by `make backup-smoke`; this
// driver never builds, tags or removes an image, so a parallel checkout's run can
// never collide with — or garbage-collect — this one's inputs.
const image = process.env.BACKUP_SMOKE_IMAGE
const fixtureImage = process.env.BACKUP_SMOKE_FIXTURE_IMAGE

if (!image) {
  throw new Error('BACKUP_SMOKE_IMAGE is required')
}
if (!fixtureImage) {
  throw new Error('BACKUP_SMOKE_FIXTURE_IMAGE is required')
}

// Both the bind address and the probe host follow the daemon — see dockerHost.mjs
// for why, and for the security property the local case keeps.
const { publishSpec, probeHost } = publishTarget(process.env.DOCKER_HOST, 3000)

const suffix = `${process.pid}-${Date.now()}`
const sourceContainer = `notarium-backup-source-${suffix}`
const targetContainer = `notarium-backup-target-${suffix}`
// One name per invocation: `--rm` removal is daemon-side and asynchronous, so reusing
// a single name lets a later run collide with an earlier one still being reaped.
const fixtureContainers = {
  create: `notarium-backup-fixture-create-${suffix}`,
  inspectSource: `notarium-backup-fixture-source-${suffix}`,
  inspectTarget: `notarium-backup-fixture-target-${suffix}`,
}
const sourceVolume = `notarium-backup-source-${suffix}`
const targetVolume = `notarium-backup-target-${suffix}`
const importJobId = `backup-smoke-live-${suffix}`
const importOrphanJobId = `backup-smoke-orphan-${suffix}`
const importBytes = 'durable-import-bytes'
const importFilename = 'backup-smoke-import.json'
const work = await mkdtemp(join(tmpdir(), 'notarium-backup-smoke-'))
const archive = join(work, 'notarium.zip')
const password = 'backup-smoke-password'
const username = 'backup-owner'
const activeDockerChildren = new Map()
const checkupSession = process.env.CHECKUP_SESSION_ID
const checkupCpuSet = process.env.CHECKUP_CPUSET
let interruptedSignal = null
let cleanupPromise = null
let cleanupPassPromise = null
let interruptPromise = null
let stopDockerChildrenPromise = null

const spawnDocker = (args, options, { allowInterrupted = false } = {}) => {
  if (interruptedSignal && !allowInterrupted) {
    throw new Error(`backup smoke interrupted by ${interruptedSignal}`)
  }
  const ownsContainer = args[0] === 'run' || args[0] === 'create'

  if (checkupCpuSet && !/^\d+(?:[-,]\d+)*$/u.test(checkupCpuSet)) {
    throw new Error(`invalid CHECKUP_CPUSET=${JSON.stringify(checkupCpuSet)}`)
  }
  const resourceArgs =
    checkupCpuSet && ownsContainer
      ? [args[0], '--cpuset-cpus', checkupCpuSet, ...args.slice(1)]
      : args
  const labelledArgs =
    checkupSession && ownsContainer
      ? [
          resourceArgs[0],
          '--label',
          'notarium.checkup.runner=true',
          '--label',
          `notarium.checkup.session=${checkupSession}`,
          ...resourceArgs.slice(1),
        ]
      : resourceArgs
  const child = spawn('docker', labelledArgs, options)
  const done = new Promise((resolve) => {
    const untrack = () => {
      activeDockerChildren.delete(child)
      resolve()
    }
    child.once('error', untrack)
    child.once('close', untrack)
  })
  activeDockerChildren.set(child, done)
  return child
}

const run = (args, { allowFailure = false, allowInterrupted = false } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawnDocker(args, { stdio: ['ignore', 'pipe', 'pipe'] }, { allowInterrupted })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 || allowFailure) {
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
      } else {
        reject(new Error(`docker ${args.join(' ')} failed (${code})\n${stderr}\n${stdout}`))
      }
    })
  })

const runWithInput = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawnDocker(args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const source = createReadStream(input)
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    source.on('error', reject)
    child.on('error', reject)
    source.pipe(child.stdin)
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
      } else {
        reject(new Error(`docker ${args.join(' ')} failed (${code})\n${stderr}\n${stdout}`))
      }
    })
  })

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message)
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const startContainer = async (name, volume) => {
  await run([
    'run',
    '-d',
    '--name',
    name,
    '-p',
    publishSpec,
    '-e',
    'AUTH_MODE=password',
    '-e',
    'VECTOR_SEARCH=off',
    '-e',
    'PORT=3000',
    '-v',
    `${volume}:/data`,
    image,
  ])
  const published = (await run(['port', name, '3000/tcp'])).stdout.split('\n')[0]
  const port = published.slice(published.lastIndexOf(':') + 1)
  const base = `http://${probeHost}:${port}`
  const deadline = Date.now() + 60_000

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`)

      if (response.ok) {
        return base
      }
    } catch {
      // Container is still starting.
    }
    await wait(250)
  }
  throw new Error(`container ${name} did not become healthy`)
}

const request = async (base, path, { cookie, method = 'GET', body } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${text}`)
  }

  return {
    body: text ? JSON.parse(text) : null,
    cookie: response.headers.getSetCookie?.()[0]?.split(';')[0] ?? null,
  }
}

const beginBackup = (container) => {
  const child = spawnDocker(['exec', container, 'backup'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const destination = createWriteStream(archive, { flags: 'wx', mode: 0o600 })
  let stderr = ''
  let sawAttempt
  const attempt = new Promise((resolve) => (sawAttempt = resolve))

  child.stderr.setEncoding('utf8')
  child.stdout.pipe(destination)
  child.stderr.on('data', (chunk) => {
    stderr += chunk
    if (stderr.includes('consistency attempt 1')) {
      sawAttempt()
    }
  })
  const processDone = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`online backup failed (${code})\n${stderr}`))
      }
    })
  })
  const done = Promise.all([processDone, finished(destination)]).then(() => ({
    stderr: stderr.trim(),
  }))

  return { attempt, done }
}

// One-shot helper off the Docker `builder` stage, which carries the workspace sources
// the shipped runtime deliberately does not. uid 1000 matches the runtime's `node`
// user, so what it writes into /data is what the server can read back.
const runFixture = async (container, volume, mode, options) => {
  const result = await run([
    'run',
    '--rm',
    '--name',
    container,
    '--user',
    '1000:1000',
    '-v',
    `${volume}:/data`,
    '--entrypoint',
    '/app/node_modules/.bin/tsx',
    fixtureImage,
    '/app/test/backup/durableImportFixture.ts',
    ...fixtureArgv(mode, { 'data-dir': '/data', 'job-id': importJobId, ...options }),
  ])
  // The meta-DB logs any migration it applies to stdout, so the fixture's JSON
  // document is the LAST line rather than the whole stream.
  const document = result.stdout
    .split('\n')
    .filter((line) => line.trim())
    .at(-1)

  assert(document, `durable import fixture (${mode}) produced no output`)
  try {
    return JSON.parse(document)
  } catch (err) {
    throw new Error(
      `durable import fixture (${mode}) did not end in a JSON document: ${err.message}\n${result.stdout}`,
    )
  }
}

/** Both staged finals as the container sees them — one probe per poll, so the
 *  live file is re-checked on every iteration of the sweep barrier below. */
const stagingState = async (container, live, orphan) => {
  const seen = (
    await run([
      'exec',
      container,
      'sh',
      '-lc',
      `printf '%s %s' "$(test -e '${orphan}' && echo present || echo absent)" ` +
        `"$(test -e '${live}' && echo present || echo absent)"`,
    ])
  ).stdout.split(' ')

  // Orphan first, live second: a sweep landing between the two substitutions is then
  // read as orphan-gone-and-live-gone, which fails, rather than as a clean break-out.
  return { orphan: seen[0], live: seen[1] }
}

const cleanup = async ({ abortOnInterrupt = false } = {}) => {
  for (const container of [sourceContainer, targetContainer, ...Object.values(fixtureContainers)]) {
    if (abortOnInterrupt && interruptedSignal) {
      return
    }
    await run(['rm', '-f', container], { allowFailure: true, allowInterrupted: true })
  }
  for (const volume of [sourceVolume, targetVolume]) {
    if (abortOnInterrupt && interruptedSignal) {
      return
    }
    await run(['volume', 'rm', '-f', volume], { allowFailure: true, allowInterrupted: true })
  }
  if (abortOnInterrupt && interruptedSignal) {
    return
  }
  await rm(work, { recursive: true, force: true })
}

const stopDockerChildren = () => {
  stopDockerChildrenPromise ??= (async () => {
    const activeAtInterrupt = [...activeDockerChildren.entries()]

    for (const [child] of activeAtInterrupt) {
      child.kill('SIGTERM')
    }
    await Promise.race([Promise.all(activeAtInterrupt.map(([, done]) => done)), wait(3_000)])

    const stillActive = activeAtInterrupt.filter(([child]) => activeDockerChildren.has(child))
    for (const [child] of stillActive) {
      child.kill('SIGKILL')
    }
    await Promise.race([Promise.all(stillActive.map(([, done]) => done)), wait(2_000)])
  })()
  return stopDockerChildrenPromise
}

const cleanupOnce = () => {
  if (interruptPromise) {
    return interruptPromise
  }
  cleanupPromise ??= (async () => {
    cleanupPassPromise = cleanup({ abortOnInterrupt: true })
    await cleanupPassPromise
    // A signal may arrive while this ordinary pass is awaiting a Docker child.
    // Keep the original finally waiter alive until signal cleanup completes.
    if (interruptPromise) {
      await interruptPromise
    }
  })()
  return cleanupPromise
}

const interrupt = (signal) => {
  if (interruptedSignal) {
    return
  }
  interruptedSignal = signal
  interruptPromise = (async () => {
    // A killed Docker CLI can still finish its daemon-side create before it
    // closes. This runs even if ordinary finally-cleanup had already started:
    // that pass aborts after its current child, then exact cleanup is repeated.
    await stopDockerChildren()
    await cleanupPassPromise?.catch(() => {})
    await cleanup()
  })()
  void interruptPromise.finally(() => {
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

process.once('SIGINT', () => interrupt('SIGINT'))
process.once('SIGTERM', () => interrupt('SIGTERM'))

try {
  const help = await run(['run', '--rm', image, '--help'])
  assert(help.stdout.includes('backup verify'), 'image entrypoint did not expose CLI help')
  await run([
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    image,
    '-c',
    'test -f /app/packages/server/dist/metaDb-migrations/manifest.json ' +
      '&& test -f /app/packages/server/dist/metaDb-migrations/sqlite/0000_baseline.sql ' +
      '&& test -f /app/packages/server/dist/metaDb-migrations/postgres/0000_baseline.sql ' +
      '&& test -f /app/packages/server/dist/catalog/grooming/SKILL.md ' +
      '&& test -f /app/packages/server/dist/catalog/grooming-evidence/SKILL.md ' +
      '&& test -f /app/packages/server/dist/catalog/research/SKILL.md ' +
      '&& test -f /app/packages/server/dist/catalog/research-evidence/SKILL.md ' +
      // The drill's fixture lives in the builder stage; a runtime that grew a copy
      // would be shipping a test surface.
      '&& test ! -e /app/test',
  ])

  await run(['volume', 'create', sourceVolume])
  const sourceBase = await startContainer(sourceContainer, sourceVolume)
  const pidOne = await run(['exec', sourceContainer, 'sh', '-lc', "tr '\\0' ' ' < /proc/1/cmdline"])
  assert(
    pidOne.stdout.startsWith('node /app/packages/server/dist/main.js'),
    `notarium start did not exec the server as PID 1: ${pidOne.stdout}`,
  )
  assert(
    (await run(['exec', sourceContainer, 'healthcheck'])).stdout === 'ok',
    'healthcheck failed',
  )
  assert(
    (await run(['exec', sourceContainer, 'version'])).stdout.startsWith('notarium '),
    'version alias failed',
  )
  const setup = await request(sourceBase, '/api/auth/setup', {
    method: 'POST',
    body: { username, password },
  })
  const cookie = setup.cookie
  const space = setup.body.personalSpace

  assert(cookie, 'setup did not issue a session cookie')
  assert(space, 'setup did not provision a personal space')
  assert(
    (await run(['exec', sourceContainer, 'admin', 'list'])).stdout.includes(username),
    'admin alias did not reach the live metadata DB',
  )

  const created = await request(sourceBase, `/api/s/${space}/notes`, {
    method: 'POST',
    cookie,
    body: { content: '# Backup probe\n\nrevision zero' },
  })
  const noteId = created.body.id
  let versionToken = created.body.versionToken

  const firstEdit = await request(sourceBase, '/api/note', {
    method: 'POST',
    cookie,
    body: {
      originalId: noteId,
      versionToken,
      content: '# Backup probe\n\nrevision one',
    },
  })
  versionToken = firstEdit.body.versionToken

  const spacesBefore = (await request(sourceBase, '/api/spaces', { cookie })).body.spaces.map(
    ({ id, slug }) => ({ id, slug }),
  )
  // Production stages under the STABLE SPACE ID, so the fixture must too: the sweep
  // finds a final wherever it sits and judges it by the job id in its NAME, so what a
  // wrong directory breaks is not visibility but the row's `uploadRef` resolving to
  // the bytes a re-claimed import would re-read.
  const personal = spacesBefore.filter(({ slug }) => slug === space)

  assert(personal.length === 1, `expected exactly one space with slug ${space}`)
  const spaceId = personal[0].id
  const fixture = await runFixture(fixtureContainers.create, sourceVolume, 'create', {
    space: spaceId,
    'orphan-job-id': importOrphanJobId,
    principal: `user:${username}`,
    filename: importFilename,
    content: importBytes,
    // Far enough ahead that no claim loop can touch the row mid-drill; the drill is
    // about what maintenance KEEPS, not about running an import.
    'run-at': new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  })
  const stagedJob = await request(sourceBase, `/api/s/${space}/jobs/${importJobId}`, { cookie })

  assert(stagedJob.body.id === importJobId, 'staged import row is not readable in its space')
  assert(stagedJob.body.kind === 'import', 'staged import row lost its kind')
  assert(stagedJob.body.status === 'pending', 'staged import row is not live')

  // The causal barrier: both finals are older than the staging grace, so the next
  // scheduled maintenance pass judges them on their ROW. The control orphan
  // disappearing is proof that pass ran; the live final surviving it — checked on
  // every poll, not only at the end — is the property the backup must preserve.
  // `create` returning proves both finals existed at these paths, so the barrier only
  // has to watch the control go. Demanding to SEE it first would race the sweep: past
  // its ageing the orphan is reclaimable immediately, and a tick landing before the
  // first probe would fail a run in which everything worked.
  const sweepDeadline = Date.now() + 130_000
  let sweptOrphan = false

  while (Date.now() < sweepDeadline) {
    const staging = await stagingState(sourceContainer, fixture.upload.path, fixture.orphan.path)

    assert(staging.live === 'present', 'maintenance reclaimed the LIVE import staging')
    if (staging.orphan === 'absent') {
      sweptOrphan = true
      break
    }
    await wait(2_000)
  }
  assert(sweptOrphan, 'scheduled maintenance never reclaimed the row-less staging orphan')
  const stagedBefore = await runFixture(fixtureContainers.inspectSource, sourceVolume, 'inspect', {
    'orphan-ref': fixture.orphan.ref,
  })

  // Without this the lifecycle compare below would pass on `null === null`, which is
  // the one way it could report success while proving nothing.
  assert(stagedBefore.job, 'import row is not readable through the staging seams')
  // Named explicitly: a field that failed to persist is null on BOTH sides, so the
  // projection compare below would match it against itself and prove nothing.
  assert(stagedBefore.job.filename === importFilename, 'import row lost its filename')
  assert(stagedBefore.job.principal === `user:${username}`, 'import row lost its principal')
  assert(stagedBefore.job.uploadRef === fixture.upload.ref, 'import row lost its upload ref')
  assert(stagedBefore.upload.bytes === importBytes, 'durable import staging bytes changed')
  assert(!stagedBefore.orphan.present, 'control orphan reappeared before the backup')

  const backup = beginBackup(sourceContainer)
  await Promise.race([
    backup.attempt,
    wait(10_000).then(() => {
      throw new Error('backup CLI did not begin its first consistency attempt')
    }),
  ])
  await wait(150)
  const secondEdit = await request(sourceBase, '/api/note', {
    method: 'POST',
    cookie,
    body: {
      originalId: noteId,
      versionToken,
      content: '# Backup probe\n\nrevision two during backup',
    },
  })
  await wait(150)
  await request(sourceBase, '/api/note', {
    method: 'POST',
    cookie,
    body: {
      originalId: noteId,
      versionToken: secondEdit.body.versionToken,
      content: '# Backup probe\n\nFINAL committed during online backup',
    },
  })
  await request(sourceBase, '/api/health')

  const backupResult = await backup.done
  const summaryLine = backupResult.stderr
    .split('\n')
    .find((line) => line.startsWith('backup complete: '))

  assert(summaryLine, 'image-native backup did not emit its completion summary')
  const backupSummary = JSON.parse(summaryLine.slice('backup complete: '.length))

  assert(backupSummary.attempts > 1, 'concurrent writes did not force a consistency retry')
  const revisionsBefore = await request(
    sourceBase,
    `/api/note/revisions?id=${encodeURIComponent(noteId)}`,
    { cookie },
  )
  const sourceMtime = (
    await run([
      'exec',
      sourceContainer,
      'node',
      '-e',
      `const{statSync}=require('node:fs');process.stdout.write(String(statSync('/data/spaces/${space}/backup-probe.md').mtimeMs))`,
    ])
  ).stdout
  const verification = await runWithInput(['run', '--rm', '-i', image, 'backup', 'verify'], archive)
  const verificationSummary = JSON.parse(verification.stdout)

  assert(verificationSummary.valid === true, 'backup verify did not validate the archive')
  assert(
    verificationSummary.files === backupSummary.files,
    'backup verify reported a different file count',
  )

  const sseController = new AbortController()
  const liveSse = await fetch(`${sourceBase}/api/s/${space}/events`, {
    headers: { cookie },
    signal: sseController.signal,
  })
  assert(
    liveSse.ok && liveSse.headers.get('content-type')?.startsWith('text/event-stream'),
    'could not hold a live SSE connection for the shutdown drill',
  )

  // The CLI execs the Node host as PID 1, so the ordinary Docker stop signal is
  // the lifecycle contract too; preClose must terminate ordinary live UI SSE
  // before Docker's grace period, and no wrapper process may swallow SIGTERM.
  await run(['stop', '--time', '10', sourceContainer])
  sseController.abort()
  assert(
    (await run(['inspect', '--format', '{{.State.ExitCode}}', sourceContainer])).stdout === '0',
    'server did not complete graceful SIGTERM shutdown',
  )
  await run(['rm', sourceContainer])
  await run(['volume', 'rm', sourceVolume])
  await run(['volume', 'create', targetVolume])
  await runWithInput(
    ['run', '--rm', '-i', '-v', `${targetVolume}:/data`, image, 'restore'],
    archive,
  )

  await run([
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    '-v',
    `${targetVolume}:/data`,
    image,
    '-lc',
    'test ! -e /data/engine',
  ])

  const targetBase = await startContainer(targetContainer, targetVolume)
  const login = await request(targetBase, '/api/auth/login', {
    method: 'POST',
    body: { identifier: username, password },
  })
  const restoredCookie = login.cookie

  assert(restoredCookie, 'restored owner could not log in')
  const spacesAfter = (
    await request(targetBase, '/api/spaces', { cookie: restoredCookie })
  ).body.spaces.map(({ id, slug }) => ({ id, slug }))
  assert(JSON.stringify(spacesAfter) === JSON.stringify(spacesBefore), 'space ids/slugs changed')

  const note = await request(targetBase, `/api/note?id=${encodeURIComponent(noteId)}`, {
    cookie: restoredCookie,
  })
  assert(note.body.id === noteId, 'note id changed after restore')
  assert(
    note.body.content.includes('FINAL committed during online backup'),
    'final body is missing',
  )

  const revisions = await request(
    targetBase,
    `/api/note/revisions?id=${encodeURIComponent(noteId)}`,
    { cookie: restoredCookie },
  )
  assert(
    JSON.stringify(revisions.body) === JSON.stringify(revisionsBefore.body),
    'revision chain ids/order/content changed after restore',
  )

  const restoredMtime = (
    await run([
      'exec',
      targetContainer,
      'node',
      '-e',
      `const{statSync}=require('node:fs');process.stdout.write(String(statSync('/data/spaces/${space}/backup-probe.md').mtimeMs))`,
    ])
  ).stdout
  assert(
    Math.abs(Number(restoredMtime) - Number(sourceMtime)) <= 1,
    `note mtime changed: ${sourceMtime} -> ${restoredMtime}`,
  )
  // The causal proof that maintenance spares a live upload is the SOURCE barrier
  // above; the restored runtime's boot pass is fire-and-forget, so nothing here can
  // wait on it. What this side proves is narrower and still the point: the archive
  // carried the bytes and the row across unchanged.
  const restoredJob = await request(targetBase, `/api/s/${space}/jobs/${importJobId}`, {
    cookie: restoredCookie,
  })

  assert(restoredJob.body.id === importJobId, 'import job id changed after restore')
  assert(restoredJob.body.kind === stagedJob.body.kind, 'import job kind changed after restore')
  assert(
    restoredJob.body.status === stagedJob.body.status,
    'import job status changed after restore',
  )
  const stagedAfter = await runFixture(fixtureContainers.inspectTarget, targetVolume, 'inspect', {
    'orphan-ref': fixture.orphan.ref,
  })

  assert(stagedAfter.job, 'import row did not survive the restore')

  assert(
    JSON.stringify(stagedAfter.job) === JSON.stringify(stagedBefore.job),
    `import lifecycle changed: ${JSON.stringify(stagedBefore.job)} -> ${JSON.stringify(stagedAfter.job)}`,
  )
  assert(stagedAfter.upload.bytes === importBytes, 'durable import staging bytes changed')
  assert(!stagedAfter.orphan.present, 'restore resurrected the reclaimed staging orphan')
  await run(['exec', targetContainer, 'sh', '-lc', 'test -d /data/engine'])

  console.log(
    JSON.stringify({
      ok: true,
      attempts: backupSummary.attempts,
      noteId,
      revisions: revisions.body.total,
      spaces: spacesAfter,
      durableImport: stagedAfter.job,
    }),
  )
} finally {
  await cleanupOnce()
}
