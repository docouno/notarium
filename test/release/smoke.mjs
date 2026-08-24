// Release flow end to end: the real entrypoint, driven against a
// disposable local registry. It exists because the parts that matter most are the
// parts that only happen at publication time — the immutability gate, the digest,
// the version→latest ordering — and meeting those for the first time during an
// actual release is exactly the wrong moment.
//
// What it proves, in order:
//   · a release refuses an unclean tree (the tag / published-source / Changelog gates
//     are pure predicates, covered exhaustively in releaseIdentity.test.ts);
//   · a pre-release build carries the intended identity — including the -rc.N
//     version it must NOT hide — and survives its own smoke;
//   · the image lands in a registry and reports a digest;
//   · a published image's version can be read back out of the registry (the input
//     the `latest` guard decides on);
//   · the forward-only `:latest` rule decides on a version really read back from a
//     registry — the one release-path input that unit tests cannot supply;
//   · a second candidate on the prepared base is named past the published one rather than overwriting it,
//     and the name is decided against what the registry really holds;
//   · a pre-release never moves `latest`.
//
// One thing this no longer proves, and the reason is the change itself: it used to
// re-run the entrypoint and watch the immutability gate refuse the tag it had just
// published. With `-rc.N` a pre-release cannot collide with itself by construction —
// it asks the registry for the first free number — so that refusal is now only
// reachable in a race. The gate is unchanged and still runs twice (pre-build and
// pre-push); what decides the number is covered by firstFreePrerelease's unit tests,
// and "the published candidate is not reused" is asserted below against a real
// registry.
//
// Run: make release-smoke

import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { daemonHostFrom } from '../../scripts/dockerHost.mjs'
import { latestMoveDecision } from '../../scripts/releaseIdentity.mjs'
import { publishedImageVersion } from '../../scripts/releaseImage.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const suffix = `${process.pid}`
const scratchFile = join(root, `release-smoke-scratch-${process.pid}.tmp`)
let publishedRef = null
let latestRef = null
const registryContainer = `notarium-release-registry-${suffix}`
const registryPort = 5000 + (process.pid % 1000)
const daemonHost = daemonHostFrom(process.env.DOCKER_HOST)
let registryForward = null
// THE REGISTRY IS ALWAYS `localhost:<port>`, and that is not cosmetic.
//
// The release flow talks to a registry from BOTH sides: `docker push` goes through
// the daemon, while `docker manifest inspect`, `buildx imagetools inspect` and the
// readiness probe are client-side. `localhost` is the one address both sides accept
// over plain HTTP without being told to: the daemon has `--insecure-registry` for
// other names, but `imagetools inspect` — which reads the version label back out of a
// published tag — has no such flag at all. Any other name therefore fails the
// client-side half with "server gave HTTP response to HTTPS client", which is exactly
// how a sibling `registry:5000` service failed in CI after the push had succeeded.
//
// So the address stays `localhost` and the TOPOLOGY adapts instead: the registry is
// published into the daemon's namespace, and when that daemon is remote this process
// forwards its own localhost:<port> over to it. Both halves then say `localhost` and
// mean the same registry.
const registry = `localhost:${registryPort}`
// Per-run namespace: cleanup enumerates images by `--filter reference=<ns>`, and
// agents share this machine — a shared namespace would let one run's cleanup
// delete another's image.
const imageName = `notarium/release-check-${suffix}`

const run = (command, args, { allowFailure = false, env } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 || allowFailure) {
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed (${code})\n${stderr}`))
      }
    })
  })

const docker = (args, options) => run('docker', args, options)

const releaseImage = (args, options) => run('node', ['scripts/releaseImage.mjs', ...args], options)

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message)
  }
}

const step = (message) => console.log(`\n▸ ${message}`)

const waitForRegistry = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`http://${registry}/v2/`, { signal: AbortSignal.timeout(1000) })
      if (res.status === 200 || res.status === 401) {
        return
      }
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('the local registry never came up')
}

// -v: the registry container owns an anonymous volume holding the whole pushed
// image, and `docker image prune` never reaches it.
const cleanup = async () => {
  registryForward?.kill()
  await docker(['rm', '-f', '-v', registryContainer], { allowFailure: true })
  rmSync(scratchFile, { force: true })

  // The built image is ~1.5 GB and is tagged against a registry that no longer
  // exists after this run — ten iterations would quietly cost 15 GB. BOTH refs, in
  // one call: `docker image rm` on a multi-tagged image only untags, so removing
  // just one of them leaves the image resident on every failure path.
  // Derived from the registry namespace, not from the run's record: a failure after
  // `docker build` never produces a record, and the image is already on disk by then.
  const built = await docker(
    [
      'image',
      'ls',
      '--format',
      '{{.Repository}}:{{.Tag}}',
      '--filter',
      `reference=${registry}/${imageName}`,
    ],
    { allowFailure: true },
  )
  const refs = [...new Set([publishedRef, latestRef, ...built.stdout.split('\n')].filter(Boolean))]

  if (refs.length) {
    await docker(['image', 'rm', '-f', ...refs], { allowFailure: true })
  }
}

// An interrupted run must not strand the registry container or the scratch file.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void cleanup().then(() => process.exit(130))
  })
}

const baseArgs = [
  '--prerelease',
  '--insecure-registry',
  '--registry',
  registry,
  '--image',
  imageName,
  '--json',
]

let failed = false

try {
  step('starting a disposable registry')
  await docker(['rm', '-f', '-v', registryContainer], { allowFailure: true })
  await docker([
    'run',
    '-d',
    '--name',
    registryContainer,
    // Loopback when the daemon is our own machine: agents share it, and a throwaway
    // registry has no business being reachable from the LAN. A remote daemon has to
    // publish where its client can reach it, and there that surface is the job-scoped
    // throwaway network — the same rule the product container follows.
    '-p',
    daemonHost ? `0.0.0.0:${registryPort}:5000` : `127.0.0.1:${registryPort}:5000`,
    'registry:2',
  ])
  if (daemonHost) {
    // A CHILD PROCESS, never in-process: releaseImage.mjs drives docker through
    // spawnSync, which blocks this event loop for the whole of the child's life — an
    // in-process forwarder could not accept the connection that child is waiting on,
    // and both would wait forever. That deadlock hung a CI job for twenty minutes.
    step(`forwarding localhost:${registryPort} to the daemon at ${daemonHost}`)
    registryForward = spawn('node', ['scripts/dockerHost.mjs', 'forward', `${registryPort}`], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit'],
    })
  }
  await waitForRegistry()

  // The dirty-tree refusal is the cheapest way to see the gate is real, and it is
  // safe to provoke: an untracked file is removed again immediately.
  step('a release refuses an unclean tree')
  writeFileSync(scratchFile, 'scratch\n')
  try {
    const refused = await releaseImage([...baseArgs, '--dry-run'], { allowFailure: true })
    assert(refused.code !== 0, 'a dirty tree was accepted for release')
    assert(
      /working tree is not clean/.test(refused.stderr),
      `expected a dirty-tree refusal, got:\n${refused.stderr}`,
    )
  } finally {
    rmSync(scratchFile, { force: true })
  }

  // The Changelog / tag / published-source gates are decided by pure predicates
  // and are covered exhaustively in releaseIdentity.test.ts — reproducing them
  // here would mean mutating the repository's own Changelog mid-run.

  step('building, verifying and publishing a pre-release image')
  const published = await releaseImage(baseArgs)
  const record = JSON.parse(published.stdout)
  publishedRef = record.image

  assert(record.prerelease === true, 'the record does not say it was a pre-release')
  assert(record.latest === false, 'a pre-release moved :latest')
  // The artifact must NOT claim to be the release it precedes: tag, reported version
  // and the version label all carry the -rc.N pre-release identifier. The registry is
  // fresh, so the first free candidate is 1.
  assert(record.tag === `${record.sourceVersion}-rc.1`, `unexpected pre-release tag: ${record.tag}`)
  assert(record.version === record.tag, 'the artifact version does not match its tag')
  assert(/^sha256:[0-9a-f]{64}$/.test(record.digest), `unexpected digest: ${record.digest}`)
  assert(
    record.image === `${registry}/${imageName}:${record.tag}`,
    `unexpected image ref: ${record.image}`,
  )

  step('the published image is really in the registry, with its identity intact')
  const tags = await fetch(`http://${registry}/v2/${imageName}/tags/list`).then((r) => r.json())
  assert(
    tags.tags?.includes(record.tag),
    `the registry does not list ${record.tag}: ${JSON.stringify(tags)}`,
  )
  assert(!tags.tags?.includes('latest'), 'a pre-release published a :latest tag')

  const labels = JSON.parse(
    (await docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', record.image]))
      .stdout,
  )
  assert(
    labels['org.opencontainers.image.revision'] === record.revision,
    'the image revision label does not match the release record',
  )
  assert(
    labels['org.opencontainers.image.source'] === record.sourceRepository,
    'the image source label does not match the release record',
  )

  step('the version a published image declares can be read back out of the registry')
  // The `latest` guard decides on this value, so the read itself has to work
  // against a real registry — the decision logic is unit-tested, this is the wire.
  const declared = publishedImageVersion(record.image, { platform: record.platform })
  assert(
    declared.readable && declared.version === record.version,
    `the registry reports ${JSON.stringify(declared)}, expected ${record.version}`,
  )

  // The release path itself (a real tag, a published source, a moving :latest)
  // cannot run here — it needs a public repository and a release tag that only
  // exist at a real cut. What CAN be driven against a live registry is the input
  // that decides it, so drive that: publish a :latest, read its declared version
  // back through the same helper the release uses, and check both directions of
  // the forward-only rule. This is the piece the pure unit tests cannot cover.
  step('the forward-only :latest rule decides on what the registry really holds')
  latestRef = `${registry}/${imageName}:latest`
  await docker(['tag', record.image, latestRef])
  await docker(['push', latestRef])

  const declaredLatest = publishedImageVersion(latestRef, { platform: record.platform })
  assert(
    declaredLatest.readable && declaredLatest.version === record.version,
    `:latest declares ${JSON.stringify(declaredLatest)}, expected ${record.version}`,
  )

  // Both directions, decided against the version REALLY read out of the registry.
  // Here that is the pre-release `X.Y.Z-rc.N` this run just published, so the
  // release it precedes (`X.Y.Z`) legitimately counts as forward — SemVer ranks a
  // pre-release below its release, and the rule has to agree with that.
  const [major, minor, patch] = record.sourceVersion.split('.').map(Number)
  const decide = (version) =>
    latestMoveDecision({
      presence: 'present',
      publishedVersion: declaredLatest.version,
      version,
      force: false,
      firstPublication: false,
    })

  assert(
    decide(record.sourceVersion).move === true,
    `refused to move :latest from ${declaredLatest.version} onto its own release ${record.sourceVersion}`,
  )
  assert(
    decide(`${major}.${minor}.${patch + 1}`).move === true,
    'refused to move :latest onto a newer version',
  )
  assert(decide(declaredLatest.version).move === false, 'moving :latest sideways was allowed')
  // A candidate that is unconditionally lower than any published core. Deriving it
  // by decrementing a field breaks at X.0.0, where the "lower" value collapses onto
  // the published one and the assertion contradicts the forward case above.
  assert(decide('0.0.0').move === false, 'moving :latest backwards was allowed')

  const unreadable = publishedImageVersion(`${registry}/${imageName}:no-such-tag`, {
    platform: record.platform,
  })
  assert(
    unreadable.readable === false,
    'an absent tag reported a readable version instead of an unreadable answer',
  )
  assert(
    latestMoveDecision({
      presence: 'unknown',
      publishedVersion: null,
      version: record.version,
      force: false,
      firstPublication: true,
    }).move === false,
    '--first-publication still widens the forward-only :latest guard',
  )

  // LAST because it costs a second full build (dependency layers hit the cache,
  // bundle and verification do not). The base stays the exact version prepared in
  // the manifests; only the registry-owned counter moves.
  step('the next pre-release keeps the prepared base and takes the next free candidate')
  const nextCandidate = await releaseImage([...baseArgs, '--dry-run'])
  const nextRecord = JSON.parse(nextCandidate.stdout)

  assert(
    nextRecord.version === `${record.sourceVersion}-rc.2`,
    `expected ${record.sourceVersion}-rc.2 after publishing rc.1, got ${nextRecord.version}`,
  )

  console.log('\nrelease flow: ok')
} catch (error) {
  failed = true
  console.error(`\nrelease flow: FAILED\n${error.stack ?? error.message}`)
} finally {
  await cleanup()
}

process.exit(failed ? 1 : 0)
