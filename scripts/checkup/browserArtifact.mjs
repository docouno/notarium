#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { comparePathsBytewise } from './contract.mjs'

export const BROWSER_ARTIFACT_SCHEMA = 1
export const BROWSER_MANIFEST_NAME = '.notarium-checkup-browser.json'

const hashFile = (path) =>
  new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)

    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })

const filesUnder = async (root, directory = root) => {
  const files = []

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      files.push(...(await filesUnder(root, path)))
    } else if (entry.isFile() && entry.name !== BROWSER_MANIFEST_NAME) {
      files.push(relative(root, path).split('\\').join('/'))
    }
  }

  return files.sort(comparePathsBytewise)
}

const artifactRows = async (root) =>
  Promise.all(
    (await filesUnder(root)).map(async (path) => ({
      path,
      size: (await stat(join(root, path))).size,
      sha256: await hashFile(join(root, path)),
    })),
  )

const manifestDigest = (rows) => {
  const hash = createHash('sha256')

  for (const row of rows) {
    hash.update(`${JSON.stringify(row)}\n`)
  }

  return hash.digest('hex')
}

export const writeBrowserArtifact = async ({
  dist = 'packages/web/dist',
  sourceDigest,
  playwrightImage,
}) => {
  if (!sourceDigest || !playwrightImage) {
    throw new Error('browser artifact requires sourceDigest and playwrightImage')
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(playwrightImage)) {
    throw new Error('browser artifact requires an immutable Playwright image ID')
  }
  const root = resolve(dist)
  const rows = await artifactRows(root)

  if (!rows.some(({ path }) => path === 'index.html')) {
    throw new Error('browser artifact has no index.html')
  }
  if (rows.some(({ path }) => path === 'sw.js' || /^workbox-[^/]+[.]js$/u.test(path))) {
    throw new Error('browser artifact contains PWA-on service-worker output')
  }
  const manifest = {
    schemaVersion: BROWSER_ARTIFACT_SCHEMA,
    sourceDigest,
    playwrightImage,
    pwa: false,
    fileCount: rows.length,
    digest: manifestDigest(rows),
    files: rows,
  }

  await writeFile(join(root, BROWSER_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`)

  return manifest
}

export const verifyBrowserArtifact = async ({
  dist = 'packages/web/dist',
  sourceDigest,
  playwrightImage,
}) => {
  if (!/^sha256:[a-f0-9]{64}$/u.test(playwrightImage ?? '')) {
    throw new Error('browser artifact requires an immutable Playwright image ID')
  }
  const root = resolve(dist)
  const manifest = JSON.parse(await readFile(join(root, BROWSER_MANIFEST_NAME), 'utf8'))

  if (
    manifest.schemaVersion !== BROWSER_ARTIFACT_SCHEMA ||
    manifest.sourceDigest !== sourceDigest ||
    manifest.playwrightImage !== playwrightImage ||
    manifest.pwa !== false
  ) {
    throw new Error('browser artifact identity does not match this checkup session')
  }
  const rows = await artifactRows(root)
  const digest = manifestDigest(rows)

  if (digest !== manifest.digest || JSON.stringify(rows) !== JSON.stringify(manifest.files)) {
    throw new Error('browser artifact bytes do not match their manifest')
  }

  return manifest
}

const main = async () => {
  const command = process.argv[2]
  const options = {
    sourceDigest: process.env.CHECKUP_SUBJECT_DIGEST,
    playwrightImage: process.env.CHECKUP_PLAYWRIGHT_IMAGE,
  }
  const manifest =
    command === 'write'
      ? await writeBrowserArtifact(options)
      : command === 'verify'
        ? await verifyBrowserArtifact(options)
        : null

  if (!manifest) {
    console.error('usage: browserArtifact.mjs write|verify')
    process.exitCode = 2
    return
  }
  console.error(
    `browser-artifact: ${command} ${manifest.fileCount} files ${manifest.digest} source=${manifest.sourceDigest}`,
  )
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
