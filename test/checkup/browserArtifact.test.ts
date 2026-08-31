import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  verifyBrowserArtifact,
  writeBrowserArtifact,
} from '../../scripts/checkup/browserArtifact.mjs'

const roots: string[] = []
const playwrightImage = `sha256:${'b'.repeat(64)}`

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PWA-off browser artifact', () => {
  it('binds exact dist bytes to source and Playwright image identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-browser-artifact-'))
    roots.push(root)
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'index.html'), '<main>ok</main>')
    await writeFile(join(root, 'assets/app.js'), 'export const ok = true')
    const written = await writeBrowserArtifact({
      dist: root,
      sourceDigest: 'a'.repeat(64),
      playwrightImage,
    })

    await expect(
      verifyBrowserArtifact({
        dist: root,
        sourceDigest: 'a'.repeat(64),
        playwrightImage,
      }),
    ).resolves.toEqual(written)
  })

  it('refuses changed bytes, source identity and build mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-browser-artifact-drift-'))
    roots.push(root)
    await writeFile(join(root, 'index.html'), '<main>before</main>')
    await writeBrowserArtifact({
      dist: root,
      sourceDigest: 'a'.repeat(64),
      playwrightImage,
    })
    await writeFile(join(root, 'index.html'), '<main>after</main>')

    await expect(
      verifyBrowserArtifact({
        dist: root,
        sourceDigest: 'a'.repeat(64),
        playwrightImage,
      }),
    ).rejects.toThrow(/bytes do not match/u)
    await expect(
      verifyBrowserArtifact({
        dist: root,
        sourceDigest: 'b'.repeat(64),
        playwrightImage,
      }),
    ).rejects.toThrow(/identity does not match/u)
  })

  it('refuses a mutable Playwright tag as artifact identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-browser-artifact-image-tag-'))
    roots.push(root)
    await writeFile(join(root, 'index.html'), '<main>before</main>')

    await expect(
      writeBrowserArtifact({
        dist: root,
        sourceDigest: 'a'.repeat(64),
        playwrightImage: 'mcr.microsoft.com/playwright:v1.60.0-jammy',
      }),
    ).rejects.toThrow(/immutable Playwright image ID/u)
  })

  it('refuses a production PWA-on dist as a browser test artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notarium-browser-artifact-pwa-'))
    roots.push(root)
    await writeFile(join(root, 'index.html'), '<main>before</main>')
    await writeFile(join(root, 'sw.js'), 'service worker')

    await expect(
      writeBrowserArtifact({
        dist: root,
        sourceDigest: 'a'.repeat(64),
        playwrightImage,
      }),
    ).rejects.toThrow(/PWA-on/u)
  })
})
