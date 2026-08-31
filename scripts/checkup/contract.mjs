import { createHash, randomBytes } from 'node:crypto'

export const CHECKUP_REPORT_SCHEMA = 1
export const CHECKUP_DRIVER_VERSION = 1

const ROOT_DENY = new Map([
  ['.git', 'git-metadata'],
  ['.env', 'dotenv'],
  ['review.env', 'review-env'],
  ['visual-handoff.json', 'visual-handoff'],
  ['visual-pulled-base.json', 'visual-pulled-base'],
  ['.data', 'data-root'],
  ['.docs-local', 'local-docs'],
  ['backups', 'backups'],
  ['node_modules', 'dependencies'],
  ['dist', 'generated-dist'],
  ['coverage', 'coverage-output'],
  ['test-results', 'test-output'],
  ['playwright-report', 'playwright-output'],
])

const SEGMENT_DENY = new Map([
  ['node_modules', 'dependencies'],
  ['coverage', 'coverage-output'],
  ['test-results', 'test-output'],
  ['playwright-report', 'playwright-output'],
])

const isPathOrChild = (path, root) => path === root || path.startsWith(`${root}/`)

export const snapshotDenyRule = (path) => {
  const root = path.split('/')[0] ?? ''
  const rootRule = ROOT_DENY.get(root)

  if (rootRule) {
    return rootRule
  }
  if (isPathOrChild(path, 'docker/volumes')) {
    return 'docker-state'
  }
  if (/^packages\/[^/]+\/dist(?:\/|$)/u.test(path)) {
    return 'generated-dist'
  }
  if (/^notarium-[^/]*[.]tar[.]gz$/u.test(path)) {
    return 'image-tarball'
  }
  if (/(?:^|\/)[^/]*[.]log$/u.test(path)) {
    return 'log-output'
  }

  for (const segment of path.split('/')) {
    const segmentRule = SEGMENT_DENY.get(segment)

    if (segmentRule) {
      return segmentRule
    }
  }

  return null
}

export const isExternalVisualBaseline = (path) =>
  /^test\/visual\/visual[.]spec[.]ts-snapshots\/[^/]+[.]png$/u.test(path)

export const comparePathsBytewise = (left, right) =>
  Buffer.compare(Buffer.from(left), Buffer.from(right))

export const canonicalManifestLine = (row) => `${JSON.stringify(row)}\n`

export const sourceDigestOf = (rows) => {
  const hash = createHash('sha256')

  for (const row of rows) {
    hash.update(canonicalManifestLine(row))
  }

  return hash.digest('hex')
}

export const sessionIdFor = (sourceDigest, nonce = randomBytes(5).toString('hex')) =>
  `${sourceDigest.slice(0, 12)}-${nonce}`

export const stableLeaseKeyFor = (repositoryIdentity) =>
  createHash('sha256').update(repositoryIdentity.trim()).digest('hex').slice(0, 20)

export const positiveInteger = (value, fallback, name) => {
  if (value === undefined || value === '') {
    return fallback
  }
  if (!/^[1-9]\d*$/u.test(String(value))) {
    throw new TypeError(`${name} must be a positive integer, got ${JSON.stringify(value)}`)
  }

  return Number(value)
}

export const nonNegativeInteger = (value, fallback, name) => {
  if (value === undefined || value === '') {
    return fallback
  }
  if (!/^\d+$/u.test(String(value))) {
    throw new TypeError(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`)
  }

  return Number(value)
}
