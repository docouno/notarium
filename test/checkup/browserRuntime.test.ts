import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const stablePlaywright = 'node --no-maglev node_modules/@playwright/test/cli.js'
const stableBrowserEnv =
  "DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? 'disabled:'"

describe('browser runtime stability', () => {
  it('keeps Playwright runners and their long-lived servers off Maglev', async () => {
    const [
      rawPackage,
      rawWebPackage,
      rawServerPackage,
      fakeConfig,
      realConfig,
      realStart,
      demoConfig,
      heavy,
      makefile,
      rawPipeline,
      ciDocs,
      visualSpec,
      providerVisualSpec,
      visualScreenshotHelper,
      visualProtocol,
    ] = await Promise.all([
      readFile(join(repo, 'package.json'), 'utf8'),
      readFile(join(repo, 'packages/web/package.json'), 'utf8'),
      readFile(join(repo, 'packages/server/package.json'), 'utf8'),
      readFile(join(repo, 'playwright.config.ts'), 'utf8'),
      readFile(join(repo, 'playwright.real.config.ts'), 'utf8'),
      readFile(join(repo, 'test/e2e-real/start.ts'), 'utf8'),
      readFile(join(repo, 'playwright.demo.config.ts'), 'utf8'),
      readFile(join(repo, 'scripts/checkup/heavy.mjs'), 'utf8'),
      readFile(join(repo, 'Makefile'), 'utf8'),
      readFile(join(repo, '.gitlab-ci.yml'), 'utf8'),
      readFile(join(repo, 'docs/ci.md'), 'utf8'),
      readFile(join(repo, 'test/visual/visual.spec.ts'), 'utf8'),
      readFile(join(repo, 'test/visual/providers.spec.ts'), 'utf8'),
      readFile(join(repo, 'test/visual/screenshot.ts'), 'utf8'),
      readFile(join(repo, 'scripts/visualBaseline.mjs'), 'utf8'),
    ])
    const scripts = (JSON.parse(rawPackage) as { scripts: Record<string, string> }).scripts
    const webScripts = (JSON.parse(rawWebPackage) as { scripts: Record<string, string> }).scripts
    const serverScripts = (JSON.parse(rawServerPackage) as { scripts: Record<string, string> })
      .scripts
    const pipeline = parse(rawPipeline) as Record<
      string,
      {
        script?: string[]
        needs?: Array<{ job?: string; artifacts?: boolean } | string>
        variables?: Record<string, string>
        resource_group?: string
        artifacts?: { paths?: string[] }
      }
    >

    expect(scripts['e2e:fake']).toContain(stablePlaywright)
    expect(scripts['e2e:real']).toContain(stablePlaywright)
    expect(scripts.visual).toContain(stablePlaywright)
    expect(scripts['visual:update']).toContain(stablePlaywright)
    expect(scripts['demo:shots']).toContain(stablePlaywright)
    expect(scripts['demo:preview']).toContain('node --no-maglev --import tsx')
    expect(webScripts.build).toBe(
      'node --no-maglev ../../node_modules/vite/bin/vite.js build && ' +
        'node --no-maglev ../../scripts/checkWebBundleBudget.mjs',
    )
    expect(serverScripts.build).toBe('node --no-maglev ../../node_modules/tsup/dist/cli-default.js')
    expect(fakeConfig.match(/node --no-maglev --import tsx/gu)).toHaveLength(1)
    expect(fakeConfig.match(/\$\{TSX\}/gu)).toHaveLength(3)
    expect(fakeConfig).toContain('pathTemplate: VISUAL_SNAPSHOT_PATH_TEMPLATE')
    expect(fakeConfig).not.toContain('{projectName}')
    expect(realConfig).toContain('node --no-maglev --import tsx')
    expect(realStart).toContain('spawn(process.execPath, nodeTsxArguments(entry)')
    expect(realStart).toContain(
      "spawn(process.execPath, nodeTsxArguments('packages/server/src/apps/server/main.ts')",
    )
    expect(realStart).toContain('await listenReadiness(readiness, Number(readyPort))')
    expect(realStart).toContain('await shutdown({ exitCode: 1 })')
    expect(demoConfig).toContain('node --no-maglev --import tsx')
    for (const config of [fakeConfig, realConfig, demoConfig]) {
      expect(config).toContain(stableBrowserEnv)
      expect(config).toContain('launchOptions: { env: BROWSER_ENV }')
    }
    expect(heavy).toContain('node --no-maglev ${PLAYWRIGHT_CLI}')
    expect(heavy.match(/'--no-maglev'/gu)).toHaveLength(2)
    expect(makefile).toContain('--no-maglev node_modules/@playwright/test/cli.js')

    expect((pipeline['extended:visual']?.script ?? []).join('\n')).toContain(stablePlaywright)
    expect(pipeline['extended:visual-bootstrap']).toBeUndefined()
    expect(rawPipeline).not.toContain('--bootstrap')
    expect(ciDocs).not.toContain('visual-bootstrap')
    expect(ciDocs).not.toContain('--bootstrap')
    expect(visualSpec).not.toMatch(/[.]toHaveScreenshot\(/u)
    expect(providerVisualSpec).not.toMatch(/[.]toHaveScreenshot\(/u)
    expect(visualScreenshotHelper.match(/[.]toHaveScreenshot\(/gu)).toHaveLength(1)
    expect(visualScreenshotHelper).toContain("type: 'visual-cell', description: name")

    const comparison = (pipeline['extended:visual']?.script ?? []).join('\n')
    const acceptance = (pipeline['visual:accept']?.script ?? []).join('\n')
    const gate = (pipeline['visual:gate']?.script ?? []).join('\n')
    const acceptNeed = pipeline['visual:accept']?.needs?.[0]
    const gateNeed = pipeline['visual:gate']?.needs?.[0]

    expect(comparison).toContain(
      'candidate="$CI_COMMIT_REF_SLUG-$CI_COMMIT_SHORT_SHA-$CI_PIPELINE_ID-$CI_JOB_ID"',
    )
    expect(comparison).toContain('--pipeline "$CI_PIPELINE_ID" --job "$CI_JOB_ID"')
    expect(comparison).toContain(
      'VISUAL_S3_KEY_ID="$VISUAL_S3_READ_KEY_ID" VISUAL_S3_SECRET="$VISUAL_S3_READ_SECRET"',
    )
    expect(comparison).toContain('node scripts/visualBaseline.mjs verdict')
    expect(acceptNeed).toEqual({ job: 'extended:visual', artifacts: true })
    expect(gateNeed).toEqual({ job: 'extended:visual', artifacts: true })
    expect(pipeline['extended:visual']?.artifacts?.paths).toContain('visual-handoff.json')
    expect(pipeline['visual:accept']?.variables).not.toHaveProperty('VISUAL_CANDIDATE')
    expect(pipeline['visual:accept']?.resource_group).toBe('visual-baseline-accept')
    expect(acceptance.trim()).toBe('node scripts/visualBaseline.mjs accept')
    expect(gate.trim()).toBe('node scripts/visualBaseline.mjs gate')

    const publishSource = visualProtocol.slice(
      visualProtocol.indexOf('const publish ='),
      visualProtocol.indexOf('// --- review'),
    )

    expect(publishSource.indexOf('blocksCandidate(outcome)')).toBeLessThan(
      publishSource.indexOf('readFile(actual)'),
    )
    expect(publishSource).not.toContain('currentManifest()')
    expect(publishSource.indexOf('readPulledBase()')).toBeLessThan(
      publishSource.indexOf('currentChannelSnapshot()'),
    )
    expect(publishSource.indexOf('currentChannelSnapshot()')).toBeLessThan(
      publishSource.indexOf('manifestAtSnapshot(pulled.snapshot)'),
    )
    expect(publishSource.indexOf('outcome.flaky.length && !outcome.cells.length')).toBeLessThan(
      publishSource.indexOf('candidateKey(producer.candidate)'),
    )
    expect(publishSource).toContain('bindCarriedFlakyCells(outcome.flaky, baselineCells)')
    expect(publishSource).toContain('carriedFlakyCells')
    expect(publishSource.indexOf('const review = await publishReview')).toBeLessThan(
      publishSource.indexOf('candidateKey(producer.candidate), pointer'),
    )
    expect(visualProtocol).toContain('currentSnapshot !== expected.baseSnapshot')
    expect(visualProtocol).toContain('manifestDigest(manifestBody) !== expected.snapshot')
  })
})
