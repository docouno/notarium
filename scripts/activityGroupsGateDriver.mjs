import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const mode = process.env.ACTIVITY_GROUPS_GATE_MODE || 'full'
const dialects = process.env.ACTIVITY_GROUPS_GATE_DIALECTS || 'sqlite'
const outputRelative =
  process.env.ACTIVITY_GROUPS_GATE_OUTPUT || `test-results/activity-groups-gate/${mode}`
const output = resolve(root, outputRelative)
const nodeImage = process.env.ACTIVITY_GROUPS_GATE_NODE_IMAGE || 'node:24-slim'
const pgImage = process.env.ACTIVITY_GROUPS_GATE_PG_IMAGE || 'postgres:16-alpine'
const preCommit = '4d824c336927f52df5a671ad4284c772f7183a01'
const suffix = `${basename(root)
  .replace(/[^a-z0-9_-]/gi, '-')
  .slice(0, 20)}-${process.pid}-${Date.now()}`
const network = `activity-groups-${suffix}-network`
const postgres = `activity-groups-${suffix}-postgres`
const runner = `activity-groups-${suffix}-runner`
const runnerImage = `activity-groups-runner:${suffix}`
const temporary = mkdtempSync(join(tmpdir(), 'notarium-414-gate-driver-'))
const preArchive = join(temporary, 'pre.tar')
const remoteDocker = Boolean(
  process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix:'),
)
const needsPg = mode === 'full' || dialects.split(',').includes('postgres')
const resources = mode === 'full' ? ['--cpus=2', '--memory=2g'] : []
let builtRunner = false

if (!['smoke', 'full'].includes(mode)) {
  throw new Error('ACTIVITY_GROUPS_GATE_MODE must be smoke or full')
}
if (!output.startsWith(`${root}/`) || output === root) {
  throw new Error(`Activity gate output must stay below the checkout: ${output}`)
}

const execute = (command, args, { capture = false, allowFailure = false, cwd = root } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: process.env,
  })

  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? String(result.stderr || result.stdout || '').trim() : ''
    throw new Error(
      `${basename(command)} ${args[0] || ''} exited ${result.status}${detail ? `: ${detail}` : ''}`,
    )
  }

  return capture ? String(result.stdout || '').trim() : result.status
}

const docker = (args, options) => execute('docker', args, options)

const imageIdentity = (image) => {
  const inspected = docker(['image', 'inspect', '--format', '{{.Id}}', image], {
    capture: true,
    allowFailure: true,
  })

  if (inspected) {
    return inspected
  }
  docker(['pull', image])
  return docker(['image', 'inspect', '--format', '{{.Id}}', image], {
    capture: true,
  })
}

const worktreeDigest = () => {
  if (process.env.CI_COMMIT_SHA) {
    return `commit:${process.env.CI_COMMIT_SHA}`
  }
  const hash = createHash('sha256')
  hash.update(execute('git', ['diff', '--binary', 'HEAD'], { capture: true }))
  const untracked = execute('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    capture: true,
  })
    .split('\0')
    .filter(Boolean)
    .sort()

  for (const relative of untracked) {
    hash.update(relative)
    hash.update(readFileSync(join(root, relative)))
  }

  return `worktree:${hash.digest('hex')}`
}

const cleanup = () => {
  docker(['rm', '-f', runner], { allowFailure: true, capture: true })
  docker(['rm', '-f', postgres], { allowFailure: true, capture: true })
  docker(['network', 'rm', network], { allowFailure: true, capture: true })
  if (builtRunner) {
    docker(['image', 'rm', '-f', runnerImage], { allowFailure: true, capture: true })
  }
  rmSync(temporary, { recursive: true, force: true })
}

const waitForPostgres = () => {
  const deadline = Date.now() + 60_000

  while (Date.now() < deadline) {
    if (
      docker(['exec', postgres, 'pg_isready', '-U', 'notarium', '-d', 'notarium_activity_gate'], {
        allowFailure: true,
      }) === 0
    ) {
      return
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  docker(['logs', postgres], { allowFailure: true })
  throw new Error('Activity gate PostgreSQL did not become ready')
}

const commonEnvironment = (runnerIdentity, pgIdentity) => [
  '-e',
  'HOME=/tmp',
  '-e',
  `ACTIVITY_GROUPS_PRE_IMAGE=${runnerIdentity}+git:${preCommit}`,
  '-e',
  `ACTIVITY_GROUPS_POST_IMAGE=${runnerIdentity}+${worktreeDigest()}`,
  '-e',
  `ACTIVITY_GROUPS_PG_IMAGE=${pgIdentity}`,
  '-e',
  'ACTIVITY_GROUPS_PRE_ARCHIVE=/tmp/pre.tar',
  '-e',
  `ACTIVITY_GROUPS_POST_TREE=${worktreeDigest()}`,
  '-e',
  `ACTIVITY_GROUPS_RESOURCES_ENFORCED=${mode === 'full' ? 'true' : 'false'}`,
  '-e',
  `ACTIVITY_GROUPS_RUNNER_CONTAINER=${runner}`,
  ...(needsPg
    ? [
        '-e',
        'ACTIVITY_GROUPS_PG_URL=postgres://notarium:notarium@activity-groups-postgres:5432/notarium_activity_gate',
        '-e',
        `ACTIVITY_GROUPS_PG_CONTAINER=${postgres}`,
      ]
    : []),
]

const runnerCommand = [
  '--import',
  'tsx',
  'scripts/activityGroupsProductionGate.ts',
  `--mode=${mode}`,
  `--dialects=${dialects}`,
  `--output=/app/${outputRelative}`,
]

try {
  mkdirSync(output, { recursive: true })
  execute('git', ['archive', '--format=tar', `--output=${preArchive}`, preCommit])
  const nodeIdentity = imageIdentity(nodeImage)
  const pgIdentity = needsPg ? imageIdentity(pgImage) : ''

  if (needsPg) {
    docker(['network', 'create', network])
    docker([
      'run',
      '-d',
      '--name',
      postgres,
      '--network',
      network,
      '--network-alias',
      'activity-groups-postgres',
      ...resources,
      '-e',
      'POSTGRES_USER=notarium',
      '-e',
      'POSTGRES_PASSWORD=notarium',
      '-e',
      'POSTGRES_DB=notarium_activity_gate',
      pgImage,
    ])
    waitForPostgres()
  }

  if (!remoteDocker) {
    execute('npm', ['run', 'build', '-w', '@notarium/server'])
    const socketGroup = execute('stat', ['-c', '%g', '/var/run/docker.sock'], { capture: true })
    docker([
      'run',
      '--rm',
      '--name',
      runner,
      '--user',
      `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      '--group-add',
      socketGroup,
      ...resources,
      ...(needsPg ? ['--network', network] : []),
      '--mount',
      `type=bind,src=${root},dst=/app`,
      '--mount',
      `type=bind,src=${preArchive},dst=/tmp/pre.tar,readonly`,
      '--mount',
      'type=bind,src=/usr/bin/docker,dst=/usr/local/bin/docker,readonly',
      '--mount',
      'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
      '--workdir',
      '/app',
      ...commonEnvironment(nodeIdentity, pgIdentity),
      '--entrypoint',
      'node',
      nodeImage,
      ...runnerCommand,
    ])
  } else {
    docker(['build', '--target', 'builder', '-t', runnerImage, '-f', 'docker/Dockerfile', '.'])
    builtRunner = true
    const runnerIdentity = imageIdentity(runnerImage)
    const dockerHost = process.env.DOCKER_HOST
    const dockerCertPath = process.env.DOCKER_CERT_PATH || '/certs/client'
    const dockerHostName = new URL(dockerHost).hostname
    const createArgs = [
      'create',
      '--name',
      runner,
      ...resources,
      ...(needsPg ? ['--network', network] : []),
      // The nested runner lives on the corpus network, outside GitLab's service
      // network. Route the service hostname back to the dind daemon's host gateway;
      // keeping the name `docker` also keeps TLS hostname verification intact.
      ...(dockerHostName === 'docker' ? ['--add-host', 'docker:host-gateway'] : []),
      '--workdir',
      '/app',
      ...commonEnvironment(runnerIdentity, pgIdentity),
      '-e',
      `DOCKER_HOST=${dockerHost}`,
      '-e',
      `DOCKER_TLS_VERIFY=${process.env.DOCKER_TLS_VERIFY || '1'}`,
      '-e',
      'DOCKER_CERT_PATH=/certs/client',
      '--mount',
      `type=bind,src=${dockerCertPath},dst=/certs/client,readonly`,
      '--entrypoint',
      'node',
      runnerImage,
      ...runnerCommand,
    ]
    docker(createArgs)
    docker(['cp', `${root}/scripts/.`, `${runner}:/app/scripts`])
    docker(['cp', preArchive, `${runner}:/tmp/pre.tar`])
    const dockerBinary = execute('sh', ['-c', 'command -v docker'], { capture: true })
    docker(['cp', dockerBinary, `${runner}:/usr/local/bin/docker`])
    docker(['start', '--attach', runner])
    mkdirSync(dirname(join(root, outputRelative, 'report.json')), { recursive: true })
    docker([
      'cp',
      `${runner}:/app/${outputRelative}/report.json`,
      join(root, outputRelative, 'report.json'),
    ])
  }
} finally {
  cleanup()
}
