import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { itFullDeps } from './fullDepsGate'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const runtimePath = join(root, 'THIRD_PARTY_NOTICES.md')
const frontendPath = join(root, 'packages/web/public/licenses/THIRD_PARTY_NOTICES.txt')
const browserLicensePath = join(root, 'packages/web/public/licenses/NOTARIUM-LICENSE.txt')
const fontsDir = join(root, 'packages/web/public/fonts')
const fontLicensesDir = join(fontsDir, 'licenses')

const installedPackage = async (relativeDir: string) => {
  const dir = join(root, relativeDir)
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
    name: string
    version: string
  }

  return { dir, ...manifest }
}

const optionalText = async (path: string) => {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

describe('license corpus', () => {
  // The only case here that reads installed packages rather than committed files, so
  // the only one the lean profile cannot answer.
  itFullDeps('keeps native source offers exact and all package companion notices', async () => {
    const runtime = await readFile(runtimePath, 'utf8')
    const barePath = runtime.match(/^## bare-path .+?(?=\n---\n)/ms)?.[0]
    const [graphologyTypes, tslib, ...onnxPackages] = await Promise.all([
      installedPackage('node_modules/graphology-types'),
      installedPackage('node_modules/tslib'),
      installedPackage('node_modules/onnxruntime-common'),
      installedPackage('node_modules/onnxruntime-node'),
      installedPackage('node_modules/onnxruntime-web'),
      installedPackage('node_modules/onnxruntime-web/node_modules/onnxruntime-common'),
    ])

    expect(runtime).toContain(
      'Corresponding Source: https://github.com/lovell/sharp-libvips/tree/4da6d14c0d59866adfb9d8cf52bcaa53846dc4f6',
    )
    expect(runtime).toContain('### LGPL-3.0-or-later text (SPDX license-list-data v3.28.0)')
    expect(runtime).toContain('### ONNX Runtime ThirdPartyNotices.txt')
    expect(runtime).toContain(`## ${graphologyTypes.name}  ${graphologyTypes.version}  —  MIT`)
    expect(runtime).toContain(`## ${tslib.name}  ${tslib.version}  —  0BSD`)

    for (const pkg of onnxPackages) {
      const commit = await optionalText(join(pkg.dir, '__commit.txt'))
      const ref = commit || pkg.version.match(/-([0-9a-f]{10,40})$/i)?.[1] || `v${pkg.version}`

      expect(runtime).toContain(`## ${pkg.name}  ${pkg.version}  —  MIT`)
      expect(runtime).toContain(
        `Exact source: https://github.com/microsoft/onnxruntime/tree/${ref}`,
      )
    }

    expect(barePath).toContain('### LICENSE')
    expect(barePath).toContain('### NOTICE')
    expect(runtime).not.toMatch(/No license file|UNKNOWN|SEE-LICENSE|reconstructed/)
  })

  it('ships browser and generated-PWA notices with the first-party license', async () => {
    const [frontend, browserLicense, rootLicense] = await Promise.all([
      readFile(frontendPath, 'utf8'),
      readFile(browserLicensePath, 'utf8'),
      readFile(join(root, 'LICENSE'), 'utf8'),
    ])

    expect(frontend).toContain('Third-party notices — Notarium web bundle')
    expect(frontend).toContain('dompurify ')
    expect(frontend).toContain('katex ')
    expect(frontend).toContain('mermaid ')
    expect(frontend).toContain('graphology ')
    expect(frontend).toContain('graphology-communities-louvain ')
    expect(frontend).toContain('workbox-window ')
    expect(frontend).toContain('workbox-precaching ')
    expect(frontend).toContain('workbox-expiration ')
    expect(frontend).toContain('/licenses/NOTARIUM-LICENSE.txt')
    expect(frontend).not.toMatch(/No license file|UNKNOWN|SEE-LICENSE|reconstructed/)
    expect(browserLicense).toBe(rootLicense)
  })

  it('covers every vendored font with its pinned OFL companion', async () => {
    const [fontFiles, licenseFiles, index] = await Promise.all([
      readdir(fontsDir),
      readdir(fontLicensesDir),
      readFile(join(fontsDir, 'LICENSES.md'), 'utf8'),
    ])
    const woff2 = fontFiles.filter((file) => file.endsWith('.woff2'))
    const licenses = licenseFiles.filter((file) => file.endsWith('.txt'))
    const slugs = licenses.map((file) => file.slice(0, -'.txt'.length))

    expect(licenses).toHaveLength(13)
    expect(index).toContain('@fontsource-variable/<slug>@5.3.0')
    expect(woff2.length).toBeGreaterThan(0)

    for (const file of woff2) {
      expect(
        slugs.some((slug) => file.startsWith(`${slug}-`)),
        file,
      ).toBe(true)
    }

    for (const file of licenses) {
      const text = await readFile(join(fontLicensesDir, file), 'utf8')

      expect(index).toContain(`licenses/${file}`)
      expect(text).toMatch(/SIL OPEN FONT LICENSE/i)

      // The OFL body alone is not the notice. §2 permits redistribution only with
      // "the above copyright notice", and Fontsource ships a few families with a bare
      // vendor name where that statement belongs — which also named the wrong holder.
      // Asserting the first line is what makes that a red suite rather than a silent
      // shipment of 120 binaries under someone else's name.
      const first = text.split('\n')[0].trim()

      expect(first, `${file}: first line is not a copyright statement`).toMatch(/^copyright\b/i)

      // The index quotes that same statement; a corpus that is right on disk and wrong
      // in the table the app serves under /fonts/ is still wrong. Scoped to the row
      // that links this file — asserting against the whole document would pass just as
      // happily if two families had their copyrights swapped.
      const row = index.split('\n').find((line) => line.includes(`licenses/${file}`))

      expect(row, `${file}: no row in LICENSES.md links it`).toBeDefined()
      expect(row, `${file}: the table quotes a different copyright than the file`).toContain(
        first.slice(0, 88),
      )
    }
  })
})
