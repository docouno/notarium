import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const STAMP_SCHEMA = 1
const STAMP_PATH = 'node_modules/.notarium-deps.json'
const LEAN_EXCLUDED_WORKSPACE = '@notarium/engine-vector'
const INSTALL_MANIFEST_FIELDS = [
  'name',
  'workspaces',
  'packageManager',
  'engines',
  'devEngines',
  'os',
  'cpu',
  'libc',
  'bin',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundleDependencies',
  'bundledDependencies',
  'overrides',
  'config',
]
const INSTALL_SCRIPT_NAMES = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'predeps:lean',
  'deps:lean',
  'postdeps:lean',
  'predeps:full',
  'deps:full',
  'postdeps:full',
])

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

const exists = async (path) => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

const dependencyInputs = async (root) => {
  const inputs = ['package.json', 'package-lock.json', '.npmrc']
  const packages = join(root, 'packages')
  const entries = await readdir(packages, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isDirectory() && (await exists(join(packages, entry.name, 'package.json')))) {
      inputs.push(join('packages', entry.name, 'package.json'))
    }
  }

  return inputs.sort()
}

const installManifestState = (manifest) => {
  const state = {}

  for (const field of INSTALL_MANIFEST_FIELDS) {
    if (Object.hasOwn(manifest, field)) {
      state[field] = manifest[field]
    }
  }
  const scripts = Object.fromEntries(
    Object.entries(manifest.scripts ?? {}).filter(([name]) => INSTALL_SCRIPT_NAMES.has(name)),
  )

  if (Object.keys(scripts).length) {
    state.scripts = scripts
  }

  return state
}

export const dependencyFingerprint = async (root) => {
  const hash = createHash('sha256')

  hash.update(`schema=${STAMP_SCHEMA}\n`)
  hash.update(`node=${process.versions.node}\n`)
  hash.update(`platform=${process.platform}\n`)
  hash.update(`arch=${process.arch}\n`)
  for (const input of await dependencyInputs(root)) {
    hash.update(`${input}\0`)
    try {
      const bytes = await readFile(join(root, input))

      hash.update(
        input.endsWith('package.json')
          ? JSON.stringify(installManifestState(JSON.parse(bytes.toString('utf8'))))
          : bytes,
      )
    } catch (error) {
      if (input === '.npmrc' && error?.code === 'ENOENT') {
        hash.update('<missing>')
      } else {
        throw error
      }
    }
    hash.update('\0')
  }

  return hash.digest('hex')
}

const workspaceLinksIssue = async (root, profile) => {
  const packages = join(root, 'packages')
  const entries = (await readdir(packages, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    const workspace = join(packages, entry.name)
    const manifestPath = join(workspace, 'package.json')

    if (!(await exists(manifestPath))) {
      continue
    }
    const manifest = await readJson(manifestPath)

    if (profile === 'lean' && manifest.name === LEAN_EXCLUDED_WORKSPACE) {
      continue
    }
    if (typeof manifest.name !== 'string' || !manifest.name) {
      return `workspace ${relative(root, manifestPath)} has no package name`
    }
    const link = join(root, 'node_modules', ...manifest.name.split('/'))

    try {
      if ((await realpath(link)) !== workspace) {
        return `workspace link ${relative(root, link)} points outside this checkout`
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return `workspace link ${relative(root, link)} is missing`
      }
      throw error
    }
  }

  return null
}

const installedTreeIssue = async (root, profile) => {
  for (const required of [
    'node_modules/.package-lock.json',
    'node_modules/.bin/tsc',
    'node_modules/sqlite-vec/package.json',
  ]) {
    if (!(await exists(join(root, required)))) {
      return `${required} is missing`
    }
  }

  return workspaceLinksIssue(root, profile)
}

export const inspectDependencyFreshness = async (root) => {
  let stamp

  try {
    stamp = await readJson(join(root, STAMP_PATH))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { fresh: false, reason: 'dependency stamp is missing' }
    }
    if (error instanceof SyntaxError) {
      return { fresh: false, reason: 'dependency stamp is malformed' }
    }
    throw error
  }
  if (
    stamp?.schema !== STAMP_SCHEMA ||
    (stamp?.profile !== 'lean' && stamp?.profile !== 'full') ||
    typeof stamp?.fingerprint !== 'string'
  ) {
    return { fresh: false, reason: 'dependency stamp has an unsupported shape' }
  }
  if (stamp.fingerprint !== (await dependencyFingerprint(root))) {
    return { fresh: false, reason: 'dependency manifests or lockfile changed' }
  }
  const treeIssue = await installedTreeIssue(root, stamp.profile)

  if (treeIssue) {
    return { fresh: false, reason: treeIssue }
  }

  return { fresh: true, profile: stamp.profile }
}

export const recordDependencyFreshness = async (root, profile) => {
  if (profile !== 'lean' && profile !== 'full') {
    throw new Error(`dependency profile must be lean or full, got ${JSON.stringify(profile)}`)
  }
  const treeIssue = await installedTreeIssue(root, profile)

  if (treeIssue) {
    throw new Error(`cannot record incomplete ${profile} dependency tree: ${treeIssue}`)
  }
  const path = join(root, STAMP_PATH)
  const temporary = `${path}.${process.pid}.tmp`
  const stamp = {
    schema: STAMP_SCHEMA,
    profile,
    fingerprint: await dependencyFingerprint(root),
  }

  // Container builds install as root and run the test stage as `node`. The stamp is
  // dependency metadata, not a credential, so every checkout user must be able to read
  // it without turning a valid image into a false-stale reinstall attempt.
  await writeFile(temporary, `${JSON.stringify(stamp)}\n`, { mode: 0o644 })
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }

  return stamp
}

export const isRuntimeDependencyInstall = (env = process.env) =>
  env.NOTARIUM_DEPS_INSTALL_KIND === 'runtime'

const main = async () => {
  const [command, profile] = process.argv.slice(2)
  const root = process.cwd()

  if (command === 'check' && profile === undefined) {
    const result = await inspectDependencyFreshness(root)

    if (result.fresh) {
      console.log('deps: node_modules ok')
      return
    }
    console.error(`deps: node_modules stale (${result.reason}); reinstalling`)
    process.exitCode = 1
    return
  }
  if (command === 'record' && profile !== undefined) {
    if (isRuntimeDependencyInstall()) {
      if (profile !== 'full') {
        throw new Error(`cannot omit dev dependencies from ${profile} dependency profile`)
      }
      console.log('deps: freshness stamp skipped for production --omit=dev install')
      return
    }
    await recordDependencyFreshness(root, profile)
    return
  }
  throw new Error('usage: depsFreshness.mjs check | record lean|full')
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
