#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const BLOCKING_SEVERITIES = new Set(['high', 'critical'])
const AUDIT_SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']
const AUDIT_REPORT_VERSION = 2
const AUDIT_REGISTRY = 'https://registry.npmjs.org/'
const EXCEPTION_FIELDS = ['advisory', 'condition', 'expires', 'owner', 'package', 'version']
const POLICY_FIELDS = ['exceptions', 'schemaVersion']
const GHSA_PATTERN =
  /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/i
const EXACT_VERSION_PATTERN = /^[^\s*~^<>=|]+$/
const NPM_GRAPH_CONFIG = new Set([
  'npm_config_also',
  'npm_config_include',
  'npm_config_include_workspace_root',
  'npm_config_omit',
  'npm_config_only',
  'npm_config_production',
  'npm_config_workspace',
  'npm_config_workspaces',
])

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const ghsaFrom = (url) =>
  /GHSA-[23456789cfghjmpqrvwx-]+/i.exec(url ?? '')?.[0]?.toUpperCase() ?? null

const dateError = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return 'must be YYYY-MM-DD'
  }
  const parsed = new Date(`${value}T00:00:00Z`)

  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value
    ? 'is not a real calendar date'
    : null
}

const auditEntriesFrom = (audit, blockers) => {
  if (!isRecord(audit)) {
    blockers.push('audit: response must be an object')
    return new Map()
  }

  if ('error' in audit || 'message' in audit) {
    const summary =
      (typeof audit.message === 'string' && audit.message.trim()) ||
      (isRecord(audit.error) &&
        [audit.error.summary, audit.error.detail]
          .filter((part) => typeof part === 'string' && part.trim())
          .join(': ')) ||
      'the advisory service returned an error'
    blockers.push(`audit: ${summary}`)
    return new Map()
  }

  if (audit.auditReportVersion !== AUDIT_REPORT_VERSION) {
    blockers.push(
      `audit: auditReportVersion must be ${AUDIT_REPORT_VERSION}, got ${JSON.stringify(audit.auditReportVersion)}`,
    )
  }
  if (!isRecord(audit.vulnerabilities)) {
    blockers.push('audit: vulnerabilities must be an object')
    return new Map()
  }

  const entries = new Map()

  for (const [packageName, vulnerability] of Object.entries(audit.vulnerabilities)) {
    const prefix = `audit vulnerability ${packageName}`

    if (!isRecord(vulnerability)) {
      blockers.push(`${prefix}: must be an object`)
      continue
    }
    if (vulnerability.name !== packageName) {
      blockers.push(`${prefix}: name must equal the package key`)
    }
    if (!AUDIT_SEVERITIES.includes(vulnerability.severity)) {
      blockers.push(`${prefix}: has invalid severity ${JSON.stringify(vulnerability.severity)}`)
    }
    if (!Array.isArray(vulnerability.via) || vulnerability.via.length === 0) {
      blockers.push(`${prefix}: via must be a non-empty array`)
      continue
    }
    if (
      !Array.isArray(vulnerability.nodes) ||
      vulnerability.nodes.length === 0 ||
      vulnerability.nodes.some((node) => typeof node !== 'string' || node === '')
    ) {
      blockers.push(`${prefix}: nodes must be a non-empty array of lockfile paths`)
      continue
    }

    const via = []

    for (const source of vulnerability.via) {
      if (typeof source === 'string' && source) {
        via.push(source)
        continue
      }
      if (!isRecord(source)) {
        blockers.push(`${prefix}: each via entry must be a package name or advisory object`)
        continue
      }
      const sourceIdValid =
        (typeof source.source === 'number' && Number.isFinite(source.source)) ||
        (typeof source.source === 'string' && source.source.trim() !== '')

      if (
        !AUDIT_SEVERITIES.includes(source.severity) ||
        typeof source.title !== 'string' ||
        !source.title.trim() ||
        typeof source.url !== 'string' ||
        !source.url.trim() ||
        !sourceIdValid
      ) {
        blockers.push(`${prefix}: advisory entries require source, title, url and valid severity`)
        continue
      }
      via.push(source)
    }

    if (via.length !== vulnerability.via.length) {
      continue
    }
    entries.set(packageName, {
      ...vulnerability,
      nodes: vulnerability.nodes,
      via,
    })
  }

  const metadata = audit.metadata?.vulnerabilities

  if (!isRecord(metadata)) {
    blockers.push('audit: metadata.vulnerabilities must be an object')
    return entries
  }

  for (const field of [...AUDIT_SEVERITIES, 'total']) {
    if (!Number.isInteger(metadata[field]) || metadata[field] < 0) {
      blockers.push(`audit: metadata.vulnerabilities.${field} must be a non-negative integer`)
    }
  }

  if (
    AUDIT_SEVERITIES.every((field) => Number.isInteger(metadata[field])) &&
    Number.isInteger(metadata.total)
  ) {
    const sum = AUDIT_SEVERITIES.reduce((total, field) => total + metadata[field], 0)

    if (sum !== metadata.total) {
      blockers.push(`audit: metadata severity counts sum to ${sum}, total is ${metadata.total}`)
    }
    if (metadata.total !== Object.keys(audit.vulnerabilities).length) {
      blockers.push(
        `audit: metadata total ${metadata.total} does not match ${Object.keys(audit.vulnerabilities).length} vulnerability entries`,
      )
    }

    for (const severity of AUDIT_SEVERITIES) {
      const actual = [...entries.values()].filter((entry) => entry.severity === severity).length

      if (actual !== metadata[severity]) {
        blockers.push(
          `audit: metadata ${severity} count ${metadata[severity]} does not match ${actual} parsed entries`,
        )
      }
    }
  }

  for (const [packageName, vulnerability] of entries) {
    for (const source of vulnerability.via) {
      if (typeof source === 'string' && !entries.has(source)) {
        blockers.push(
          `audit vulnerability ${packageName}: via references missing package ${source}`,
        )
      }
    }
  }

  const reachesBlockingAdvisory = (packageName, seen = new Set()) => {
    if (seen.has(packageName)) {
      return false
    }
    seen.add(packageName)
    const vulnerability = entries.get(packageName)

    return Boolean(
      vulnerability?.via.some((source) =>
        typeof source === 'string'
          ? reachesBlockingAdvisory(source, new Set(seen))
          : BLOCKING_SEVERITIES.has(source.severity),
      ),
    )
  }

  for (const [packageName, vulnerability] of entries) {
    if (BLOCKING_SEVERITIES.has(vulnerability.severity) && !reachesBlockingAdvisory(packageName)) {
      blockers.push(
        `audit vulnerability ${packageName}: blocking severity does not resolve to a concrete blocking advisory`,
      )
    }
  }

  return entries
}

const lockPackagesFrom = (lock, blockers) => {
  if (!isRecord(lock) || !isRecord(lock.packages)) {
    blockers.push('lockfile: packages must be an object')
    return {}
  }

  return lock.packages
}

const findingsFrom = (entries, lockPackages, blockers) => {
  const findings = new Map()

  for (const [packageName, vulnerability] of entries) {
    const advisories = (vulnerability.via ?? []).filter(
      (via) => isRecord(via) && BLOCKING_SEVERITIES.has(via.severity),
    )

    for (const advisory of advisories) {
      const advisoryId = ghsaFrom(advisory.url)

      if (!advisoryId) {
        blockers.push(
          `${packageName}: blocking advisory source ${String(advisory.source)} has no GHSA identifier`,
        )
      }

      for (const node of vulnerability.nodes ?? []) {
        const version = lockPackages[node]?.version

        if (typeof version !== 'string' || !version) {
          blockers.push(`${packageName}: cannot resolve the installed version at ${node}`)
          continue
        }

        const finding = {
          advisory: advisoryId,
          package: packageName,
          version,
          severity: advisory.severity,
          title: advisory.title,
          url: advisory.url,
        }
        const key = `${finding.advisory ?? `source:${advisory.source}`}\0${packageName}\0${version}`
        findings.set(key, finding)
      }
    }
  }

  return [...findings.values()]
}

const policyEntries = (policy, today, blockers) => {
  if (!isRecord(policy)) {
    blockers.push('policy: must be an object')
    return []
  }

  const fields = Object.keys(policy).sort()

  if (fields.join('\0') !== POLICY_FIELDS.join('\0')) {
    blockers.push(`policy: fields must be exactly ${POLICY_FIELDS.join(', ')}`)
  }
  if (policy.schemaVersion !== 1) {
    blockers.push(`policy: schemaVersion must be 1, got ${JSON.stringify(policy.schemaVersion)}`)
  }
  if (!Array.isArray(policy.exceptions)) {
    blockers.push('policy: exceptions must be an array')
    return []
  }

  const seen = new Set()

  return policy.exceptions.flatMap((entry, index) => {
    const prefix = `policy exception #${index + 1}`

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      blockers.push(`${prefix}: must be an object`)
      return []
    }

    const fields = Object.keys(entry).sort()

    if (fields.join('\0') !== EXCEPTION_FIELDS.join('\0')) {
      blockers.push(`${prefix}: fields must be exactly ${EXCEPTION_FIELDS.join(', ')}`)
      return []
    }

    const stringFields = EXCEPTION_FIELDS.filter((field) => typeof entry[field] !== 'string')

    if (stringFields.length) {
      blockers.push(`${prefix}: ${stringFields.join(', ')} must be strings`)
      return []
    }

    const emptyFields = EXCEPTION_FIELDS.filter((field) => entry[field].trim() === '')

    if (emptyFields.length) {
      blockers.push(`${prefix}: ${emptyFields.join(', ')} must not be empty`)
      return []
    }
    if (!GHSA_PATTERN.test(entry.advisory)) {
      blockers.push(`${prefix}: advisory must be an exact GHSA identifier`)
      return []
    }
    if (!EXACT_VERSION_PATTERN.test(entry.version)) {
      blockers.push(`${prefix}: version must be exact, not a range`)
      return []
    }

    const invalidDate = dateError(entry.expires)

    if (invalidDate) {
      blockers.push(`${prefix}: expires ${invalidDate}`)
      return []
    }

    const normalized = {
      ...entry,
      advisory: entry.advisory.toUpperCase(),
    }
    const key = `${normalized.advisory}\0${normalized.package}\0${normalized.version}`

    if (seen.has(key)) {
      blockers.push(
        `${prefix}: duplicates ${normalized.advisory} ${normalized.package}@${normalized.version}`,
      )
      return []
    }
    seen.add(key)

    if (normalized.expires < today) {
      blockers.push(
        `${prefix}: expired on ${normalized.expires} (${normalized.advisory} ${normalized.package}@${normalized.version})`,
      )
      return []
    }

    return [normalized]
  })
}

export const evaluateRuntimeAudit = ({
  audit,
  lock,
  policy,
  today = new Date().toISOString().slice(0, 10),
}) => {
  const blockers = []
  const entries = auditEntriesFrom(audit, blockers)
  const findings = findingsFrom(entries, lockPackagesFrom(lock, blockers), blockers)
  const exceptions = policyEntries(policy, today, blockers)
  const findingKeys = new Set(
    findings.map((finding) => `${finding.advisory}\0${finding.package}\0${finding.version}`),
  )
  const exceptionKeys = new Set(
    exceptions.map((entry) => `${entry.advisory}\0${entry.package}\0${entry.version}`),
  )

  for (const finding of findings) {
    const key = `${finding.advisory}\0${finding.package}\0${finding.version}`

    if (!finding.advisory || !exceptionKeys.has(key)) {
      blockers.push(
        `${finding.severity}: ${finding.advisory ?? 'unidentified advisory'} ${finding.package}@${finding.version} — ${finding.title}`,
      )
    }
  }

  for (const exception of exceptions) {
    const key = `${exception.advisory}\0${exception.package}\0${exception.version}`

    if (!findingKeys.has(key)) {
      blockers.push(
        `stale exception: ${exception.advisory} ${exception.package}@${exception.version} no longer matches the audit`,
      )
    }
  }

  return {
    blockers,
    findings,
    accepted: findings.filter((finding) =>
      exceptionKeys.has(`${finding.advisory}\0${finding.package}\0${finding.version}`),
    ),
    totals: audit.metadata?.vulnerabilities ?? null,
  }
}

const readJson = (path, label) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} ${path} is unreadable: ${error.message}`)
  }
}

const auditEnvironment = (source) => ({
  ...Object.fromEntries(
    Object.entries(source).filter(([key]) => !NPM_GRAPH_CONFIG.has(key.toLowerCase())),
  ),
  // An explicit empty selector overrides a user/project .npmrc `workspace=…`.
  // `--workspaces` below then means every workspace, not "every selected one".
  npm_config_workspace: '',
})

export const runRuntimeAudit = ({
  cwd = process.cwd(),
  env = process.env,
  log = console.error,
  runAudit = spawnSync,
} = {}) => {
  const root = resolve(cwd)
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const auditRun = runAudit(
    npm,
    [
      'audit',
      '--omit=dev',
      '--include=prod',
      '--include=optional',
      '--include=peer',
      '--workspaces',
      '--include-workspace-root',
      '--package-lock=true',
      '--json',
      '--registry',
      AUDIT_REGISTRY,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: auditEnvironment(env),
      maxBuffer: 64 * 1024 * 1024,
    },
  )

  if (auditRun.error) {
    throw new Error(`npm audit could not run: ${auditRun.error.message}`)
  }

  let audit

  try {
    audit = JSON.parse(auditRun.stdout)
  } catch {
    throw new Error(
      `npm audit did not return JSON${auditRun.stderr ? `: ${auditRun.stderr.trim()}` : ''}`,
    )
  }

  if (auditRun.status !== 0 && auditRun.status !== 1) {
    throw new Error(`npm audit exited ${auditRun.status}: ${auditRun.stderr.trim()}`)
  }

  const result = evaluateRuntimeAudit({
    audit,
    lock: readJson(resolve(root, 'package-lock.json'), 'lockfile'),
    policy: readJson(resolve(root, 'security/runtime-audit-policy.json'), 'policy'),
  })

  if (auditRun.status === 1 && result.totals?.total === 0) {
    result.blockers.push('audit: npm exited 1 but reported zero vulnerability groups')
  }

  if (result.blockers.length) {
    log(`runtime audit blocked:\n  - ${result.blockers.join('\n  - ')}`)
  } else {
    const total = result.totals?.total ?? result.findings.length
    const accepted = result.accepted.length
      ? `; ${result.accepted.length} reviewed exception(s)`
      : ''
    log(`runtime audit passed: ${total} production advisory group(s)${accepted}`)
  }

  return result
}

const parseArgs = (argv) => {
  let cwd = process.cwd()

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--cwd' || !argv[index + 1]) {
      throw new Error('usage: node scripts/runtimeAudit.mjs [--cwd <source-root>]')
    }
    cwd = argv[index + 1]
    index += 1
  }

  return { cwd }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = runRuntimeAudit(parseArgs(process.argv.slice(2)))
    process.exitCode = result.blockers.length ? 1 : 0
  } catch (error) {
    console.error(`runtime audit failed: ${error.message}`)
    process.exitCode = 1
  }
}
