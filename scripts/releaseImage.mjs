#!/usr/bin/env node
// The ONE way a Notarium image becomes public. Not a convenience wrapper
// over `docker build && docker push`: it is the gate that makes "this digest came
// from that source" a fact rather than a claim.
//
//   npm run release:image -- [options]      (or `make release`)
//
// Three properties it exists to guarantee, in order:
//
//   1. The build context is `git archive <tag>` exported into a scratch dir, NOT
//      the working tree. Dirty files, a stray untracked script, "I'll just test
//      this one change" — none of them can reach a published layer, because the
//      context is the tag's content by construction. Guards can be forgotten;
//      this cannot.
//   2. Identity is baked in AND read back out. The commit, build time and exact
//      source URL go in as build args and OCI labels, and the freshly built image
//      is then interrogated (`notarium version --json`, `docker inspect`, a live
//      /api/about) and refused if it does not report exactly what we intended.
//   3. Publication is ordered and one-way. A version tag that already exists in
//      the registry is never overwritten; `latest` moves only after the version
//      tag is pushed and its digest is confirmed.
//
// `--prerelease` publishes the SemVer pre-release `X.Y.Z-rc.N` through the very
// same code path, into the very same repository: no release tag required, `latest`
// left alone, and the artifact honestly reports the pre-release version rather than
// impersonating the release it precedes. `N` is the first candidate number the
// registry does not already hold — the revision is NOT in the version string, where
// it made candidates sort alphabetically, but in the labels and the source link,
// where it belongs. That is both how the flow is rehearsed
// before a real cut (`make release-smoke` drives it against a local registry) and
// how a build is handed to someone early.
//
// canon: docs/release.md

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { publishTarget } from './dockerHost.mjs'
import {
  dirtyPathsFrom,
  firstFreePrerelease,
  identityMismatches,
  imageRefFor,
  imageVersionFromInspect,
  latestMoveDecision,
  prereleaseBaseVersion,
  publicSourceUrl,
  publishedTagCommitFrom,
  releaseBlockers,
  releaseIdentity,
  releaseTagFor,
  tagPresence,
} from './releaseIdentity.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SUPPORTED_RELEASE_PLATFORM = 'linux/amd64'

const DEFAULTS = {
  image: process.env.IMAGE_NAME || 'docouno/notarium',
  registry: process.env.REGISTRY || '',
  sourceRepository: process.env.SOURCE_REPO || 'https://github.com/docouno/notarium',
  // Declared, not inferred: the published artifact is amd64-only for now, and a
  // silent host-arch build would hand an arm64 maintainer an image nobody else
  // can run. Multi-arch is its own task. canon: docs/release.md#platform
  platform: process.env.PLATFORM || SUPPORTED_RELEASE_PLATFORM,
}

const die = (message) => {
  console.error(`\nrelease: ${message}\n`)
  process.exit(1)
}

const say = (message) => console.error(message)

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

const gitOk = (...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: result.stderr || '',
  }
}

const dockerResourceArgs = (args) => {
  const cpuSet = process.env.CHECKUP_CPUSET

  if (!cpuSet || !['run', 'create'].includes(args[0])) {
    return args
  }
  if (!/^\d+(?:[-,]\d+)*$/u.test(cpuSet)) {
    die(`invalid CHECKUP_CPUSET=${JSON.stringify(cpuSet)}`)
  }

  return [args[0], '--cpuset-cpus', cpuSet, ...args.slice(1)]
}

const docker = (args, { input, quiet } = {}) => {
  const resolvedArgs = dockerResourceArgs(args)
  const result = spawnSync('docker', resolvedArgs, {
    cwd: root,
    encoding: 'utf8',
    input,
    stdio: quiet ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'inherit'],
  })

  if (result.error) {
    die(`docker ${resolvedArgs[0]} could not run: ${result.error.message}`)
  }

  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: result.stderr || '',
  }
}

const dockerOrDie = (args, what) => {
  const result = docker(args)

  if (!result.ok) {
    die(`${what} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`)
  }

  return result.stdout
}

const parseArgs = (argv) => {
  const options = {
    ...DEFAULTS,
    prerelease: false,
    dryRun: false,
    json: false,
    insecureRegistry: false,
    firstPublication: false,
    forceLatest: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    const value = () => {
      const next = argv[i + 1]

      if (next === undefined || next.startsWith('--')) {
        die(`${arg} needs a value`)
      }
      i += 1
      return next
    }

    switch (arg) {
      case '--image':
        options.image = value()
        break
      case '--registry':
        options.registry = value()
        break
      case '--source-repo':
        options.sourceRepository = value()
        break
      case '--platform':
        options.platform = value()
        break
      case '--prerelease':
        options.prerelease = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--json':
        options.json = true
        break
      // A local registry served over plain HTTP (the prerelease harness). Never
      // meaningful for a real publication, so it is gated on --prerelease below.
      case '--insecure-registry':
        options.insecureRegistry = true
        break
      case '--first-publication':
        options.firstPublication = true
        break
      case '--force-latest':
        options.forceLatest = true
        break
      case '--help':
      case '-h':
        console.log(
          [
            'Usage: npm run release:image -- [options]',
            '',
            '  --image <repo>        image repository (default docouno/notarium)',
            '  --registry <host>     registry prefix; empty = Docker Hub',
            '  --source-repo <url>   public source repository',
            '  --platform <p>        build platform (currently linux/amd64 only)',
            '  --prerelease          publish X.Y.Z-rc.N; no tag needed, :latest untouched',
            '  --dry-run             build and verify, publish nothing',
            '  --json                print the release record as JSON on stdout',
            '  --first-publication   the image repository does not exist yet (see docs/release.md)',
            '  --force-latest        move :latest even onto an older/unreadable version',
            '  --insecure-registry   registry lookups over plain HTTP (prerelease only)',
          ].join('\n'),
        )
        process.exit(0)
        break
      default:
        die(`unknown option ${arg}`)
    }
  }

  if (options.insecureRegistry && !options.prerelease) {
    die('--insecure-registry is only allowed with --prerelease')
  }
  if (options.platform !== SUPPORTED_RELEASE_PLATFORM) {
    die(
      `unsupported release platform ${options.platform}; the committed native license corpus currently supports ${SUPPORTED_RELEASE_PLATFORM} only`,
    )
  }
  // The normalised form is what gets published, not the string as typed: otherwise the
  // tolerance added above would let padding or an uppercase scheme through the gate and
  // straight into the image label and the source link.
  const normalizedSource = publicSourceUrl(options.sourceRepository)

  if (normalizedSource === null) {
    die(
      `--source-repo must be an http(s) URL people can open, got "${options.sourceRepository}".\n` +
        "  It is published as the image's source link (<repo>/tree/<sha>), so it cannot be an SSH\n" +
        '  remote or a local path, cannot end in `.git` (that link 404s), cannot carry credentials\n' +
        '  (they would ship in the image labels and the job log), and cannot carry a query or fragment.',
    )
  }

  options.sourceRepository = normalizedSource

  return options
}

// --- registry ---------------------------------------------------------------

/** Does this exact tag already exist in the registry? An unreadable answer stops
 *  the release: we would rather refuse than silently overwrite a published tag. */
const registryTagPresence = (ref, { insecure }) => {
  const result = docker(['manifest', 'inspect', ...(insecure ? ['--insecure'] : []), ref], {
    quiet: true,
  })
  return tagPresence(result)
}

const requireTagIsFree = (ref, options, stage) => {
  const presence = registryTagPresence(ref, { insecure: options.insecureRegistry })

  if (presence === 'present') {
    die(
      `${ref} is already published (${stage}). A version tag is immutable: bump the version and cut a new tag instead of republishing this one.`,
    )
  }
  if (presence === 'unknown') {
    // A registry that does not yet HOLD the repository is indistinguishable from
    // one that will not let us look: Docker Hub answers both with `denied`, so it
    // cannot be told apart in code. The very first publication of a repository is
    // therefore an explicit human statement (`--first-publication`) rather than a
    // silent widening of the gate — every later release keeps the strict reading.
    if (options.firstPublication) {
      say(
        `  ! ${ref}: the registry gave no readable answer; proceeding because --first-publication was passed.`,
      )
      return
    }
    die(
      `cannot determine whether ${ref} already exists (${stage}) — log in to the registry, or fix connectivity. If this is the FIRST publication of ${options.image} and the repository does not exist yet, re-run with --first-publication. Refusing to push blind.`,
    )
  }
}

/** The version a published tag declares, read from the registry without pulling
 *  the image. Null both when the tag carries no version label (anything published
 *  before this flow existed) and when the read itself failed — the caller treats either as
 *  "cannot compare", which is the safe reading for both.
 *
 *  No `--insecure` here: `imagetools inspect` has no such flag (unlike `docker
 *  manifest inspect`), and it reaches a plain-HTTP localhost registry anyway. */
export const publishedImageVersion = (ref, { platform } = {}) => {
  const result = docker(['buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Image}}'], {
    quiet: true,
  })

  // `readable` separates "the registry answered, this image carries no version
  // label" from "we could not ask at all" (no buildx plugin, no network). Both
  // block the `latest` move, but only the second is worth telling the maintainer
  // to go fix — silently reading it as the documented safety refusal would leave
  // `latest` frozen for every future release on that host.
  return result.ok
    ? { version: imageVersionFromInspect(result.stdout, platform), readable: true }
    : { version: null, readable: false, error: result.stderr.trim() }
}

// --- source export ----------------------------------------------------------

/** The build context: the tag's tree and nothing else. `git archive` writes the
 *  committed content only — no .git, no untracked leftovers, no local config. */
const exportSource = (revision) => {
  const workdir = mkdtempSync(join(tmpdir(), 'notarium-release-'))

  // die() is process.exit, which skips `finally`; without this an aborted build
  // leaves a full source tree in /tmp on every failure.
  process.on('exit', () => rmSync(workdir, { recursive: true, force: true }))
  const archive = execFileSync('git', ['archive', '--format=tar', revision], {
    cwd: root,
    maxBuffer: 1024 * 1024 * 1024,
  })

  const extract = spawnSync('tar', ['-x', '-C', workdir], { input: archive })

  if (extract.status !== 0) {
    rmSync(workdir, { recursive: true, force: true })
    die(`could not unpack the exported source: ${extract.stderr?.toString() ?? 'tar failed'}`)
  }

  return workdir
}

// --- smoke ------------------------------------------------------------------

const waitFor = async (probe, { attempts, intervalMs, what }) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await probe()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Boot the image the way an operator would (fresh volume, nothing pre-seeded)
 *  and read its identity back over HTTP. The CLI already reports the same values
 *  from the same bundle, but only this proves the SERVER a user talks to serves
 *  them — /api/about is where a support conversation actually starts. */
// Failures in here THROW rather than die(): process.exit skips `finally`, which
// would leave the probe container (and the anonymous /data volume Docker mints
// for it) behind on every failed release.
const runtimeAbout = async (ref) => {
  const container = `notarium-release-smoke-${process.pid}`
  const { publishSpec, probeHost } = publishTarget(process.env.DOCKER_HOST, 3000)
  // `docker run -d` hands the container to dockerd, so an interrupted release would
  // strand an AUTH_MODE=none instance. The exit handler covers the paths `finally`
  // cannot (die/signal).
  process.on('exit', () => spawnSync('docker', ['rm', '-f', '-v', container]))
  // -v with rm: the image declares VOLUME /data, so each probe run creates an
  // anonymous volume that nothing will ever reference again.
  const discard = () => docker(['rm', '-f', '-v', container], { quiet: true })

  discard()
  const started = docker(
    [
      'run',
      '-d',
      '--name',
      container,
      // AUTH_MODE=none gives the probe a principal without inventing an account;
      // the released default (password) is unchanged — this container is thrown
      // away seconds later.
      '-e',
      'AUTH_MODE=none',
      // An explicit bind, NOT -P: this container runs with AUTH_MODE=none (every
      // caller is an admin) and release builds happen on shared developer machines.
      // Docker still picks a free ephemeral port; against a local daemon it is simply
      // not reachable from the LAN. Under a remote daemon the address has to follow
      // the daemon — see dockerHost.mjs.
      '-p',
      publishSpec,
      ref,
    ],
    { quiet: true },
  )

  if (!started.ok) {
    throw new Error(`the image did not start: ${started.stderr.trim()}`)
  }

  try {
    const port = docker(['port', container, '3000/tcp'], { quiet: true }).stdout.split('\n')[0]
    const hostPort = port?.split(':').pop()

    if (!hostPort) {
      throw new Error('the container published no port')
    }

    const base = `http://${probeHost}:${hostPort}`

    await waitFor(
      async () => {
        try {
          const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
          return res.ok && (await res.json())?.ok === true
        } catch {
          return false
        }
      },
      { attempts: 60, intervalMs: 1000, what: 'the image to report healthy' },
    )

    const res = await fetch(`${base}/api/about`, { signal: AbortSignal.timeout(5000) })

    if (!res.ok) {
      // The body carries the contract's own reason (a rejected `build.source`, say).
      // Reporting only the status turns a named validation error into a guess.
      const detail = await res.text().catch(() => '')

      throw new Error(
        `/api/about answered ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      )
    }

    const build = (await res.json()).build
    const staticCorpus = [
      ['/licenses/THIRD_PARTY_NOTICES.txt', 'Third-party notices — Notarium web bundle'],
      ['/licenses/NOTARIUM-LICENSE.txt', 'GNU AFFERO GENERAL PUBLIC LICENSE'],
      ['/fonts/LICENSES.md', 'Bundled fonts — licenses & provenance'],
    ]

    for (const [pathname, marker] of staticCorpus) {
      const corpus = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(5000) })
      const text = await corpus.text()

      if (!corpus.ok || !text.includes(marker)) {
        throw new Error(`${pathname} did not serve the expected license corpus`)
      }
    }

    return build
  } finally {
    discard()
  }
}

// `.npmrc` ships in the image because engine-strict has to be in effect for the
// installs the build itself runs. That makes a repo file with a credential shape a
// published artifact, so the appliance states what that file is allowed to contain
// instead of hoping nothing was added: an allowlist, because a denylist of secret
// shapes is a guessing game and npm config has too many legal spellings.
//
// The report prints the KEY only. A detector that echoes the offending line would
// paste the credential it just found into a build log that outlives the build.
const NPMRC_SCRIPT = `
const fs = require('node:fs')
const ALLOWED = new Set(['engine-strict=true'])
const directives = fs
  .readFileSync('/app/.npmrc', 'utf8')
  .split('\\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith(';') && !line.startsWith('#'))

if (!directives.length) {
  throw new Error('/app/.npmrc carries no directives: engine-strict is not in effect here')
}

const unexpected = directives
  .filter((line) => !ALLOWED.has(line))
  .map((line) => line.split('=')[0].slice(0, 60))

if (unexpected.length) {
  throw new Error('unexpected .npmrc directives: ' + unexpected.join(', '))
}
`

const CORPUS_PARITY_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const runtime = fs.readFileSync('/app/THIRD_PARTY_NOTICES.md', 'utf8')
const browserPath = '/app/packages/web/dist/licenses/THIRD_PARTY_NOTICES.txt'
const browser = fs.readFileSync(browserPath, 'utf8')
const firstParty = fs.readFileSync('/app/LICENSE', 'utf8')
const browserFirstParty = fs.readFileSync(
  '/app/packages/web/dist/licenses/NOTARIUM-LICENSE.txt',
  'utf8',
)

if (firstParty !== browserFirstParty) {
  throw new Error('browser first-party license differs from /app/LICENSE')
}

const packages = new Set()
const scanModules = (modulesDir) => {
  let entries
  try {
    entries = fs.readdirSync(modulesDir, { withFileTypes: true })
  } catch {
    return
  }

  const addPackage = (dir) => {
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    } catch {
      return
    }
    // First-party is not the '@notarium/' scope alone: the published CLI workspace
    // carries the bare product name and links into node_modules like any dependency.
    const firstPartyName =
      manifest.name === 'notarium' || String(manifest.name).startsWith('@notarium/')

    if (manifest.name && manifest.version && !firstPartyName) {
      packages.add(manifest.name + '@' + manifest.version)
    }
    scanModules(path.join(dir, 'node_modules'))
  }

  for (const entry of entries) {
    if (entry.name === '.bin' || entry.name === '.package-lock.json') continue
    const candidate = path.join(modulesDir, entry.name)
    if (entry.name.startsWith('@')) {
      let scoped = []
      try {
        scoped = fs.readdirSync(candidate)
      } catch {}
      for (const child of scoped) addPackage(path.join(candidate, child))
    } else {
      addPackage(candidate)
    }
  }
}

scanModules('/app/node_modules')
const runtimePackages = new Set(
  [...runtime.matchAll(/^## (.+?)  (\\S+)  —  /gm)].map(
    (match) => match[1] + '@' + match[2],
  ),
)
const missing = [...packages].filter((key) => !runtimePackages.has(key))
const extra = [...runtimePackages].filter((key) => !packages.has(key))

if (missing.length || extra.length) {
  throw new Error(
    'runtime corpus parity failed; missing: ' +
      missing.sort().join(', ') +
      '; extra: ' +
      extra.sort().join(', '),
  )
}

for (const name of ['graphology', 'workbox-core', 'workbox-precaching', 'workbox-window']) {
  if (!browser.includes('\\n' + name + ' ')) {
    throw new Error('browser corpus is missing ' + name)
  }
}
`

const smoke = async (ref, expected) => {
  say('  · CLI identity …')
  // No --entrypoint: this exercises the shipped appliance contract (ENTRYPOINT
  // notarium, args replace CMD) rather than a path only we know about.
  const reported = docker(['run', '--rm', ref, 'version', '--json'], { quiet: true })

  if (!reported.ok) {
    die(`smoke: \`notarium version --json\` failed: ${reported.stderr.trim()}`)
  }

  let cliBuild

  try {
    cliBuild = JSON.parse(reported.stdout)
  } catch {
    die(`smoke: \`notarium version --json\` did not print JSON: ${reported.stdout}`)
  }

  say('  · image labels …')
  const inspected = dockerOrDie(
    ['image', 'inspect', '--format', '{{json .Config.Labels}}', ref],
    'docker image inspect',
  )
  const labels = JSON.parse(inspected)

  const mismatches = identityMismatches({
    expected,
    reportedBuild: cliBuild,
    actualLabels: labels,
  })

  if (mismatches.length) {
    die(`the built image does not match its release record:\n  - ${mismatches.join('\n  - ')}`)
  }

  // The SPA is a separate bundle with its OWN inlined identity; a build arg that
  // reached tsup but not vite would ship a server and a frontend disagreeing about
  // what they are — which is precisely the stale-bundle symptom About exists to
  // expose. Cheapest honest check: the sha must be present in the built assets.
  say('  · SPA bundle identity …')
  const bundled = docker(
    [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      ref,
      '-c',
      // `commit:<quote><sha>`, not a bare sha: under --prerelease the version string
      // itself contains the sha, so a bare grep passes even when vite never received
      // GIT_SHA — the exact case this check exists to catch. The `.` stands for
      // whichever quote the minifier chose.
      `grep -rlE 'commit:.${expected.shortCommit}' /app/packages/web/dist/assets | head -1`,
    ],
    { quiet: true },
  )

  if (!bundled.stdout) {
    die(`smoke: the SPA bundle does not carry commit ${expected.shortCommit}`)
  }

  say('  · .npmrc directives …')
  const npmrc = docker(['run', '--rm', '--entrypoint', 'node', ref, '-e', NPMRC_SCRIPT], {
    quiet: true,
  })

  if (!npmrc.ok) {
    die(`smoke: ${npmrc.stderr.trim().split('\n').pop()}`)
  }

  say('  · license corpus parity …')
  const corpus = docker(['run', '--rm', '--entrypoint', 'node', ref, '-e', CORPUS_PARITY_SCRIPT], {
    quiet: true,
  })

  if (!corpus.ok) {
    die(`smoke: license corpus mismatch: ${corpus.stderr.trim()}`)
  }

  // --platform is a request, not a guarantee: an old builder or a differently
  // configured buildx can hand back the host architecture instead, and the image
  // would be published under a platform claim nothing ever checked.
  say('  · platform …')
  const architecture = dockerOrDie(
    [
      'image',
      'inspect',
      '--format',
      '{{.Os}}/{{.Architecture}}{{if .Variant}}/{{.Variant}}{{end}}',
      ref,
    ],
    'reading the built platform',
  )

  // `linux/arm64` and `linux/arm64/v8` name the same thing; compare on the os/arch
  // core and only demand the variant when the request spelled one out.
  const core = (platform) => platform.split('/').slice(0, 2).join('/')
  const matches =
    architecture === expected.platform ||
    (expected.platform.split('/').length === 2 && core(architecture) === expected.platform)

  if (!matches) {
    die(`the built image is ${architecture}, expected ${expected.platform}`)
  }

  say('  · live /api/about …')
  const about = await runtimeAbout(ref).catch((error) => die(`smoke: ${error.message}`))
  const liveMismatches = identityMismatches({
    expected,
    reportedBuild: about,
    actualLabels: labels,
    reporter: '/api/about',
  })

  if (liveMismatches.length) {
    die(`/api/about disagrees with the release record:\n  - ${liveMismatches.join('\n  - ')}`)
  }
}

// --- main -------------------------------------------------------------------

const main = async () => {
  const options = parseArgs(process.argv.slice(2))

  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const tag = releaseTagFor(version)
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')

  const headCommit = git('rev-parse', 'HEAD')
  // execFileSync directly, NOT the trimming `git()` helper: porcelain's first
  // status column is a space for unstaged changes, and trimming the output eats it.
  const dirtyPaths = dirtyPathsFrom(
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
  )

  const tagRef = gitOk('rev-parse', '-q', '--verify', `refs/tags/${tag}`)
  const tagExists = tagRef.ok
  // `rev-list -n 1` peels an annotated tag to its commit and passes a lightweight one
  // straight through, so both shapes answer the only question asked of a tag here:
  // which commit is being released. See releaseBlockers for why the shape is not checked.
  const tagCommit = tagExists ? git('rev-list', '-n', '1', tag) : null

  const localState = {
    version,
    dirtyPaths,
    tagExists,
    tagCommit,
    headCommit,
    changelog,
    prerelease: options.prerelease,
  }

  // Everything decidable offline is decided FIRST. The source-repo probe reaches
  // the network and can block on a credential helper; making a dirty tree or a
  // missing tag wait for that (and then report both) wastes the maintainer's time
  // on a run that was never going to proceed.
  const localBlockers = releaseBlockers({ ...localState, publishedTagCommit: undefined })

  if (localBlockers.length) {
    die(`this tree cannot be released:\n  - ${localBlockers.join('\n  - ')}`)
  }

  // `undefined` = not looked up (pre-release); `null` = looked up and absent.
  let publishedTagCommit

  if (!options.prerelease) {
    say(`checking ${options.sourceRepository} for ${tag} …`)
    // BOTH exact patterns: the peeled `^{}` line — the one carrying the COMMIT
    // rather than the annotated tag's own object — is only emitted when the ref
    // pattern matches it as well. canon: docs/release.md#identity
    const remote = gitOk(
      'ls-remote',
      '--tags',
      options.sourceRepository,
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    )

    if (!remote.ok) {
      die(
        `could not read ${options.sourceRepository}: ${remote.stderr.trim() || 'git ls-remote failed'}`,
      )
    }
    publishedTagCommit = publishedTagCommitFrom(remote.stdout, tag)
  }

  const blockers = releaseBlockers({ ...localState, publishedTagCommit })

  if (blockers.length) {
    die(`this tree cannot be released:\n  - ${blockers.join('\n  - ')}`)
  }

  const revision = options.prerelease ? headCommit : tagCommit
  const builtAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  // The artifact's OWN version, which is what the image reports and what its tag
  // is named after. A pre-release is not `X.Y.Z` and must not claim to be: it is the
  // SemVer pre-release of the release it PRECEDES, unique per commit so successive
  // runs never collide. Which release that is depends on whether the manifests'
  // version already shipped — see prereleaseBaseVersion.
  const probe = (tag) =>
    registryTagPresence(imageRefFor({ registry: options.registry, name: options.image, tag }), {
      insecure: options.insecureRegistry,
    })
  const artifactVersion = options.prerelease
    ? (() => {
        const presence = probe(version)
        const base = prereleaseBaseVersion({
          version,
          releasePublished: presence === 'unknown' ? null : presence === 'present',
        })

        try {
          return firstFreePrerelease({ base, probe, blind: options.firstPublication })
        } catch (error) {
          die(error.message)
        }
      })()
    : version
  const identity = releaseIdentity({
    version: artifactVersion,
    revision,
    builtAt,
    sourceRepository: options.sourceRepository,
  })

  const versionRef = imageRefFor({
    registry: options.registry,
    name: options.image,
    tag: artifactVersion,
  })
  const latestRef = imageRefFor({ registry: options.registry, name: options.image, tag: 'latest' })

  say('')
  say(`  version   ${artifactVersion}`)
  say(`  revision  ${revision}`)
  say(`  source    ${identity.source}`)
  say(`  image     ${versionRef}`)
  say(`  platform  ${options.platform}`)
  if (options.prerelease) {
    // A pre-release is publishable to other people, so say plainly what is NOT
    // guaranteed about it: the source link points at a revision this run never
    // checked is reachable in the public repository.
    say('')
    say('  pre-release: source revision is not verified as published, :latest untouched')
  }
  say('')

  if (!options.dryRun) {
    requireTagIsFree(versionRef, options, 'pre-build')
  }

  say(`exporting ${options.prerelease ? headCommit.slice(0, 12) : tag} …`)
  const context = exportSource(revision)

  try {
    // The base digest is a hand-maintained literal in three places (two FROM lines
    // and the base.digest label). Drift there silently publishes an image whose
    // own metadata names a base it was not built on — check the EXPORTED copy, the
    // one actually being built. canon: docs/release.md#base-image
    const dockerfile = readFileSync(join(context, 'docker/Dockerfile'), 'utf8')
    // Parse FROM properly. Taking the first token treats `--platform=…` as the image,
    // and deriving stage aliases from the refs themselves lets any bare name
    // (`FROM alpine`, `FROM node`) alias itself out of the check — both of which mean
    // an unpinned base ships while the gate stays silent.
    const froms = [
      ...dockerfile.matchAll(/^FROM\s+((?:--\S+\s+)*)(\S+)(?:\s+AS\s+(\S+))?\s*$/gim),
    ].map((m) => ({ ref: m[2], alias: m[3] }))
    // Aliases come from `AS <name>` only; `scratch` is the one built-in with no base.
    const aliases = new Set(froms.map((f) => f.alias).filter(Boolean))
    const external = froms.map((f) => f.ref).filter((ref) => !aliases.has(ref) && ref !== 'scratch')
    const unpinned = external.filter((ref) => !/@sha256:[0-9a-f]{64}$/.test(ref))
    const labelled = /org\.opencontainers\.image\.base\.digest="(sha256:[0-9a-f]{64})"/.exec(
      dockerfile,
    )
    const pinned = new Set(external.map((ref) => ref.split('@')[1]).filter(Boolean))

    // Counting distinct digests is not enough: dropping the `@sha256:` from one FROM
    // leaves the remaining literals in agreement and the gate silent, which is exactly
    // the half-done bump it exists to catch.
    if (unpinned.length) {
      die(`docker/Dockerfile has unpinned base image(s): ${unpinned.join(', ')}`)
    }
    if (pinned.size !== 1) {
      die(`docker/Dockerfile pins ${pinned.size} different base digests: ${[...pinned].join(', ')}`)
    }
    if (!labelled || labelled[1] !== [...pinned][0]) {
      die(
        `the base.digest label (${labelled?.[1] ?? 'missing'}) does not match the pinned base (${[...pinned][0]})`,
      )
    }

    // Run the gate FROM the exported revision, with its own script, policy and
    // lockfile. Auditing the working tree here would let an uncommitted policy
    // approve a dependency graph that is not the one entering the image.
    say('auditing the exported production dependency graph …')
    const audited = spawnSync(
      process.execPath,
      [join(context, 'scripts/runtimeAudit.mjs'), '--cwd', context],
      { cwd: context, stdio: 'inherit' },
    )

    if (audited.error) {
      die(`runtime dependency audit could not run: ${audited.error.message}`)
    }
    if (audited.status !== 0) {
      die('runtime dependency audit failed')
    }

    say(`building ${versionRef} …`)
    const buildArgs = Object.entries(identity.buildArgs).flatMap(([key, value]) => [
      '--build-arg',
      `${key}=${value}`,
    ])

    const built = docker([
      'build',
      '--platform',
      options.platform,
      ...buildArgs,
      '-t',
      versionRef,
      // The Dockerfile comes from the EXPORT too. Reading it from the working tree
      // would let a local edit shape a published image whose source says otherwise
      // — the exact hole the export exists to close.
      '-f',
      join(context, 'docker/Dockerfile'),
      context,
    ])

    if (!built.ok) {
      die('docker build failed')
    }
  } finally {
    rmSync(context, { recursive: true, force: true })
  }

  say('verifying the built image …')
  await smoke(versionRef, { ...identity, platform: options.platform })

  const record = {
    version: artifactVersion,
    sourceVersion: version,
    tag: artifactVersion,
    revision,
    source: identity.source,
    sourceRepository: identity.sourceRepository,
    image: versionRef,
    platform: options.platform,
    builtAt,
    prerelease: options.prerelease,
    // Recorded because it names the one release whose immutability could not be
    // machine-verified — worth seeing in an audit trail rather than only in a
    // maintainer's shell history.
    firstPublication: options.firstPublication,
    digest: null,
    latest: false,
    latestSkipped: null,
    latestFinishWith: null,
  }

  if (options.dryRun) {
    say('\ndry run — nothing published.')
    report(record, options)
    return
  }

  // Re-checked after the build: minutes passed, and the whole point is that no
  // published version tag is ever overwritten.
  requireTagIsFree(versionRef, options, 'pre-push')

  say(`pushing ${versionRef} …`)
  const pushed = dockerOrDie(['push', versionRef], 'docker push')

  // PAST THE POINT OF NO RETURN. The version tag is published and immutable, so
  // from here nothing may `die()`: an abort would exit without printing the digest
  // (the artifact identity), and every re-run is then refused by the immutability
  // gate — leaving the maintainer with a published image, no record of it, and no
  // supported way to finish. Later failures are recorded, reported, and reflected
  // in the exit code instead.
  let incomplete = null

  // The digest as the registry accepted it. `docker push` reports it directly;
  // RepoDigests is the fallback, filtered by repository — an image tagged for
  // several registries carries one entry per registry, and the first is not
  // necessarily the one we just published to.
  record.digest =
    /digest:\s*(sha256:[0-9a-f]{64})/.exec(pushed)?.[1] ??
    (() => {
      const repository = versionRef.split(':').slice(0, -1).join(':')
      const inspected = docker(
        ['image', 'inspect', '--format', '{{json .RepoDigests}}', versionRef],
        { quiet: true },
      )

      if (!inspected.ok) {
        return null
      }
      try {
        const match = JSON.parse(inspected.stdout).find((entry) =>
          entry.startsWith(`${repository}@`),
        )
        return match ? match.split('@')[1] : null
      } catch {
        return null
      }
    })()

  if (!record.digest) {
    incomplete = `${versionRef} is published but its digest could not be read — resolve it by hand with \`docker buildx imagetools inspect ${versionRef}\``
    say(`\n  ! ${incomplete}`)
  }

  // `latest` is a promise that the newest image is a good one, so it moves only
  // after the immutable tag exists and its digest is real. A prerelease never
  // touches it — that tag belongs to actual releases.
  //
  // It also moves only FORWARD: releases are not always chronological (a backport
  // to 0.1.x can land after 0.2.0), and a backwards `latest` silently downgrades
  // everyone who pulls without a tag. Refusing here costs one flag; noticing it
  // afterwards costs a re-release.
  if (!options.prerelease) {
    const latestPresence = registryTagPresence(latestRef, { insecure: options.insecureRegistry })
    const published =
      latestPresence === 'present'
        ? publishedImageVersion(latestRef, { platform: options.platform })
        : { version: null, readable: true }

    if (!published.readable) {
      say(
        `\n  ! could not read the current :latest (${published.error || 'docker buildx imagetools failed'}) — this is a tooling problem, not the forward-only guard`,
      )
    }
    const decision = latestMoveDecision({
      presence: latestPresence,
      publishedVersion: published.version,
      version: artifactVersion,
      force: options.forceLatest,
      firstPublication: options.firstPublication,
    })

    if (decision.move) {
      say(`pushing ${latestRef} …`)
      const tagged = docker(['tag', versionRef, latestRef])
      const pushedLatest = tagged.ok && docker(['push', latestRef]).ok

      if (pushedLatest) {
        record.latest = true
      } else {
        // The release itself stands; only the convenience pointer is behind. Say
        // exactly how to finish it, because the entrypoint will not re-run.
        incomplete = `${versionRef} is published, but :latest could not be moved onto it — finish with \`docker pull ${versionRef} && docker tag ${versionRef} ${latestRef} && docker push ${latestRef}\``
        record.latestSkipped = 'push failed'
        say(`\n  ! ${incomplete}`)
      }
    } else {
      // NOT fatal: the version tag is already published and correct. Failing the
      // whole release here would leave a maintainer thinking nothing shipped.
      record.latestSkipped = decision.reason
      record.latestFinishWith = `docker pull ${versionRef} && docker tag ${versionRef} ${latestRef} && docker push ${latestRef}`
      say(`\n  ! :latest left untouched — ${decision.reason}`)
      // NOT "re-run with --force-latest": the version tag is published by now, so the
      // next run dies on the immutability gate and advises bumping the version, which
      // is the wrong answer to "my :latest is stale". These three commands only
      // re-point a tag at an already-verified digest.
      say(
        `    to move it anyway: docker pull ${versionRef} && docker tag ${versionRef} ${latestRef} && docker push ${latestRef}`,
      )
    }
  }

  report(record, options)

  // Non-zero so a scripted caller notices, but only AFTER the record is out.
  if (incomplete) {
    process.exitCode = 1
  }
}

const report = (record, options) => {
  if (options.json) {
    console.log(JSON.stringify(record, null, 2))
    return
  }

  say('')
  say('  ┌─ released ─────────────────────────────────────')
  say(`  │  image     ${record.image}`)
  say(`  │  digest    ${record.digest ?? '—'}`)
  say(`  │  revision  ${record.revision}`)
  say(`  │  source    ${record.source}`)
  say(`  │  platform  ${record.platform}`)
  say(
    `  │  latest    ${record.latest ? 'moved' : `untouched${record.latestSkipped ? ' (see above)' : ''}`}`,
  )
  say('  └────────────────────────────────────────────────')
  say('')
  say('  Record the digest with the release notes — it is the artifact identity.')
  say('')
}

// Only when RUN, not when imported: the prerelease harness imports
// `publishedImageVersion` to check it against a real registry, and importing must
// not kick off a release.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // Only for a direct run, never on import: without a listener SIGINT/SIGTERM kill
  // the process outright and skip every `process.on('exit')` cleanup — but doing
  // this at module scope would hijack Ctrl-C from anything importing the helpers
  // (the smoke harness does), pre-empting ITS cleanup.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => process.exit(130))
  }

  await main()
}
