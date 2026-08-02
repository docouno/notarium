import type { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { evaluateRuntimeAudit, runRuntimeAudit } from '../../scripts/runtimeAudit.mjs'

type AuditOptions = {
  severity?: string
  packageName?: string
  node?: string
  url?: string
}

type Advisory = {
  source: number
  name: string
  dependency: string
  title: string
  url: string
  severity: string
}

type AuditReport = {
  auditReportVersion: number
  vulnerabilities: Record<
    string,
    {
      name: string
      severity: string
      via: Array<string | Advisory>
      nodes: string[]
    }
  >
  metadata: {
    vulnerabilities: Record<'info' | 'low' | 'moderate' | 'high' | 'critical' | 'total', number>
  }
}

const audit = (options: AuditOptions = {}): AuditReport => {
  const severity = options.severity ?? 'high'
  const packageName = options.packageName ?? 'unsafe-package'
  const node = options.node ?? `node_modules/${packageName}`
  const url = options.url ?? 'https://github.com/advisories/GHSA-2345-6789-cfgh'

  return {
    auditReportVersion: 2,
    vulnerabilities: {
      [packageName]: {
        name: packageName,
        severity,
        via: [
          {
            source: 123,
            name: packageName,
            dependency: packageName,
            title: 'unsafe package accepts hostile input',
            url,
            severity,
          },
        ],
        nodes: [node],
      },
    },
    metadata: {
      vulnerabilities: {
        info: severity === 'info' ? 1 : 0,
        low: severity === 'low' ? 1 : 0,
        moderate: severity === 'moderate' ? 1 : 0,
        high: severity === 'high' ? 1 : 0,
        critical: severity === 'critical' ? 1 : 0,
        total: 1,
      },
    },
  }
}

const lock = (version = '1.2.3', node = 'node_modules/unsafe-package') => ({
  packages: { [node]: { version } },
})

const exception = (overrides: Record<string, unknown> = {}) => ({
  advisory: 'GHSA-2345-6789-cfgh',
  package: 'unsafe-package',
  version: '1.2.3',
  condition: 'The vulnerable parser is unreachable from operator-controlled input.',
  owner: 'notarium-maintainers',
  expires: '2026-08-31',
  ...overrides,
})

const policy = (exceptions: unknown[] = []) => ({ schemaVersion: 1, exceptions })

const emptyAudit = () => ({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    },
  },
})

describe('runtime dependency audit policy', () => {
  it('passes an empty production audit without exceptions', () => {
    expect(
      evaluateRuntimeAudit({
        audit: emptyAudit(),
        lock: { packages: {} },
        policy: policy(),
        today: '2026-07-25',
      }).blockers,
    ).toEqual([])
  })

  it.each(['high', 'critical'])('blocks a new unreviewed %s advisory', (severity) => {
    const result = evaluateRuntimeAudit({
      audit: audit({ severity }),
      lock: lock(),
      policy: policy(),
      today: '2026-07-25',
    })

    expect(result.blockers.join('\n')).toContain(`${severity}: GHSA-2345-6789-CFGH`)
  })

  it('accepts only an exact current package version', () => {
    const result = evaluateRuntimeAudit({
      audit: audit(),
      lock: lock(),
      policy: policy([exception()]),
      today: '2026-07-25',
    })

    expect(result.blockers).toEqual([])
    expect(result.accepted).toHaveLength(1)
  })

  it('blocks a stale versioned exception and the now-unreviewed finding', () => {
    const result = evaluateRuntimeAudit({
      audit: audit(),
      lock: lock('1.2.4'),
      policy: policy([exception()]),
      today: '2026-07-25',
    })

    expect(result.blockers.join('\n')).toContain('unsafe-package@1.2.4')
    expect(result.blockers.join('\n')).toContain('stale exception')
  })

  it('blocks an expired exception even while the finding still matches', () => {
    const result = evaluateRuntimeAudit({
      audit: audit(),
      lock: lock(),
      policy: policy([exception({ expires: '2026-07-24' })]),
      today: '2026-07-25',
    })

    expect(result.blockers.join('\n')).toContain('expired on 2026-07-24')
    expect(result.blockers.join('\n')).toContain('high: GHSA-2345-6789-CFGH')
  })

  it('blocks exceptions with ranges or missing review metadata', () => {
    const ranged = exception({ version: '^1.2.3' })
    const missingOwner = exception({ owner: '' })
    const result = evaluateRuntimeAudit({
      audit: audit(),
      lock: lock(),
      policy: policy([ranged, missingOwner]),
      today: '2026-07-25',
    })

    expect(result.blockers.join('\n')).toContain('version must be exact')
    expect(result.blockers.join('\n')).toContain('owner must not be empty')
  })

  it('does not make moderate or low findings require a security exception', () => {
    for (const severity of ['moderate', 'low']) {
      expect(
        evaluateRuntimeAudit({
          audit: audit({ severity }),
          lock: lock(),
          policy: policy(),
          today: '2026-07-25',
        }).blockers,
      ).toEqual([])
    }
  })

  it('fails closed when npm reports a blocking advisory without a GHSA id', () => {
    const result = evaluateRuntimeAudit({
      audit: audit({ url: 'https://security.example.test/advisory/123' }),
      lock: lock(),
      policy: policy(),
      today: '2026-07-25',
    })

    expect(result.blockers.join('\n')).toContain('has no GHSA identifier')
  })

  it('fails closed on audit-service errors and incomplete JSON reports', () => {
    const serviceError = evaluateRuntimeAudit({
      audit: {
        message: 'audit endpoint returned an error',
        error: { summary: '', detail: '' },
      },
      lock: { packages: {} },
      policy: policy(),
      today: '2026-07-25',
    })
    const emptyObject = evaluateRuntimeAudit({
      audit: {},
      lock: { packages: {} },
      policy: policy(),
      today: '2026-07-25',
    })

    expect(serviceError.blockers.join('\n')).toContain('audit endpoint returned an error')
    expect(emptyObject.blockers.join('\n')).toContain('auditReportVersion must be 2')
    expect(emptyObject.blockers.join('\n')).toContain('vulnerabilities must be an object')
  })

  it('rejects inconsistent metadata, missing nodes and unresolved transitive sources', () => {
    const missingNodes = audit()
    missingNodes.vulnerabilities['unsafe-package'].nodes = []
    const missingSource = audit()
    missingSource.vulnerabilities['unsafe-package'].via = ['missing-package']

    expect(
      evaluateRuntimeAudit({
        audit: missingNodes,
        lock: lock(),
        policy: policy(),
        today: '2026-07-25',
      }).blockers.join('\n'),
    ).toContain('nodes must be a non-empty array')
    expect(
      evaluateRuntimeAudit({
        audit: missingSource,
        lock: lock(),
        policy: policy(),
        today: '2026-07-25',
      }).blockers.join('\n'),
    ).toContain('via references missing package missing-package')

    const inconsistent = audit()
    inconsistent.metadata.vulnerabilities.high = 0

    expect(
      evaluateRuntimeAudit({
        audit: inconsistent,
        lock: lock(),
        policy: policy(),
        today: '2026-07-25',
      }).blockers.join('\n'),
    ).toContain('metadata severity counts sum to 0, total is 1')
  })

  it('resolves a transitive vulnerability group to its concrete advisory', () => {
    const report = audit()
    report.vulnerabilities.wrapper = {
      name: 'wrapper',
      severity: 'high',
      via: ['unsafe-package'],
      nodes: ['node_modules/wrapper'],
    }
    report.metadata.vulnerabilities.high = 2
    report.metadata.vulnerabilities.total = 2

    const result = evaluateRuntimeAudit({
      audit: report,
      lock: {
        packages: {
          'node_modules/unsafe-package': { version: '1.2.3' },
          'node_modules/wrapper': { version: '4.5.6' },
        },
      },
      policy: policy([exception()]),
      today: '2026-07-25',
    })

    expect(result.blockers).toEqual([])
    expect(result.accepted).toHaveLength(1)
  })

  it('rejects npm error JSON at the process boundary and neutralises graph-narrowing config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-runtime-audit-'))
    const security = join(root, 'security')
    let invocation:
      | {
          args: string[]
          env: Record<string, string | undefined>
        }
      | undefined

    try {
      await mkdir(security)
      await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: {} }))
      await writeFile(join(security, 'runtime-audit-policy.json'), JSON.stringify(policy()))

      const result = runRuntimeAudit({
        cwd: root,
        env: {
          PATH: process.env.PATH,
          npm_config_omit: 'optional',
          npm_config_registry: 'http://127.0.0.1:9',
          npm_config_workspace: '@notarium/server',
        },
        log: () => undefined,
        runAudit: ((
          _command: string,
          args: string[],
          options: { env: Record<string, string | undefined> },
        ) => {
          invocation = { args, env: options.env }
          return {
            error: undefined,
            status: 1,
            stderr: 'npm error audit endpoint returned an error',
            stdout: JSON.stringify({
              message: 'connect ECONNREFUSED 127.0.0.1:9',
              error: { summary: '', detail: '' },
            }),
          }
        }) as unknown as typeof spawnSync,
      })

      expect(result.blockers.join('\n')).toContain('connect ECONNREFUSED')
      expect(invocation?.args).toEqual([
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
        'https://registry.npmjs.org/',
      ])
      expect(invocation?.env.npm_config_workspace).toBe('')
      expect(invocation?.env.npm_config_omit).toBeUndefined()
      expect(invocation?.env.npm_config_registry).toBe('http://127.0.0.1:9')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
