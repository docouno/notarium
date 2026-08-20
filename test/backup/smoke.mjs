// Destructive restore drill, isolated in disposable Docker containers + volumes.
// It proves the shipped production CLIs, live-write retry, and a cold rebuild.

import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'

import { publishTarget } from '../../scripts/dockerHost.mjs'

const image = process.env.BACKUP_SMOKE_IMAGE

if (!image) {
  throw new Error('BACKUP_SMOKE_IMAGE is required')
}

// Both the bind address and the probe host follow the daemon — see dockerHost.mjs
// for why, and for the security property the local case keeps.
const { publishSpec, probeHost } = publishTarget(process.env.DOCKER_HOST, 3000)

const suffix = `${process.pid}-${Date.now()}`
const sourceContainer = `notarium-backup-source-${suffix}`
const targetContainer = `notarium-backup-target-${suffix}`
const sourceVolume = `notarium-backup-source-${suffix}`
const targetVolume = `notarium-backup-target-${suffix}`
const work = await mkdtemp(join(tmpdir(), 'notarium-backup-smoke-'))
const archive = join(work, 'notarium.zip')
const password = 'backup-smoke-password'
const username = 'backup-owner'
const activeDockerChildren = new Map()
let interruptedSignal = null
let cleanupPromise = null
let cleanupPassPromise = null
let interruptPromise = null
let stopDockerChildrenPromise = null

const spawnDocker = (args, options, { allowInterrupted = false } = {}) => {
  if (interruptedSignal && !allowInterrupted) {
    throw new Error(`backup smoke interrupted by ${interruptedSignal}`)
  }
  const child = spawn('docker', args, options)
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

const cleanup = async ({ abortOnInterrupt = false } = {}) => {
  for (const container of [sourceContainer, targetContainer]) {
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
      '&& test -f /app/packages/server/dist/catalog/research-evidence/SKILL.md',
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

  await run([
    'exec',
    sourceContainer,
    'sh',
    '-lc',
    `mkdir -p /data/jobs/imports/${space} && printf 'durable-import-bytes' > /data/jobs/imports/${space}/smoke.import`,
  ])
  const spacesBefore = (await request(sourceBase, '/api/spaces', { cookie })).body.spaces.map(
    ({ id, slug }) => ({ id, slug }),
  )

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
    body: { username, password },
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

  const staged = await run([
    'exec',
    targetContainer,
    'sh',
    '-lc',
    `cat /data/jobs/imports/${space}/smoke.import`,
  ])
  assert(staged.stdout === 'durable-import-bytes', 'durable import staging bytes changed')
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
  await run(['exec', targetContainer, 'sh', '-lc', 'test -d /data/engine'])

  console.log(
    JSON.stringify({
      ok: true,
      attempts: backupSummary.attempts,
      noteId,
      revisions: revisions.body.total,
      spaces: spacesAfter,
    }),
  )
} finally {
  await cleanupOnce()
}
