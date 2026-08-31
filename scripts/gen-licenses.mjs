#!/usr/bin/env node
// Third-party license notices for the distributed artifacts.
//
//   node scripts/gen-licenses.mjs
//
// Two recipients receive third-party code and must receive its notices with it:
//
//   • the IMAGE / source recipient gets the server runtime — Fastify, pg, the
//     vector native stack (transformers → onnxruntime, sharp → libvips, sqlite-vec)
//     and their transitive deps. Their MIT/BSD/ISC/Apache/OFL notices and the
//     weak-copyleft (LGPL/MPL) source pointers go into  → THIRD_PARTY_NOTICES.md
//     (repo root), COPYed into the image at /app.
//
//   • the BROWSER recipient gets the built SPA bundle — React, CodeMirror, KaTeX,
//     Mermaid, … minified, so their embedded notices are stripped. Their corpus
//     goes into → packages/web/public/licenses/THIRD_PARTY_NOTICES.txt, which Vite
//     copies into dist/ and Fastify serves as a plain static file at
//     /licenses/THIRD_PARTY_NOTICES.txt (no route handler, no UI).
//
// First-party code (@notarium/* and the bare-named `notarium` CLI workspace,
// AGPL-3.0-only + commercial) is NOT third-party
// and is covered by the root LICENSE / NOTICE / COMMERCIAL-LICENSE.md — this file
// skips it. Fonts have their own OFL corpus (public/fonts/, gen-reading-faces.mjs).
//
// The set is walked from the FIRST-PARTY roots actually shipped, following each
// package's runtime `dependencies` (not devDependencies) through the installed
// node_modules — so it reflects what is really conveyed, not the whole dev tree.
// Re-run after changing a runtime/bundled dependency; commit the result.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = (name) => join(root, 'packages', name)
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))

// Every workspace whose production dependencies `npm ci --omit=dev` installs in
// the published image. `web` is executed only as a prebuilt SPA, but npm still
// installs its production dependencies (and their required peers) into the image,
// so an image-recipient corpus must cover them too. The desktop shell carries no
// dependencies of its own.
const RUNTIME_WORKSPACE_ROOTS = [
  'server',
  'engine',
  'engine-vector',
  'engine-memory',
  'core',
  'contract',
  'web',
]

// npm 11 installs this devOptional lockfile node in a clean `npm ci --omit=dev`
// image even though its optional production parent is platform-pruned. It is a
// real conveyed file tree (`npm ls` labels it extraneous), so keep the exceptional
// root explicit and covered until npm stops materialising it.
const RUNTIME_EXTRA_ROOTS = ['tslib']

// @notarium/web keeps most bundled libraries in devDependencies, so those direct
// source imports remain explicit. Production dependencies of web and core are
// read from their manifests below. VitePWA emits Workbox code that application
// source never imports directly; those generated-artifact roots are explicit too.
const FRONTEND_ROOTS = [
  'react',
  'react-dom',
  'react-router',
  'react-force-graph-2d',
  'd3-force-3d',
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/lang-markdown',
  '@codemirror/language',
  '@codemirror/language-data',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/highlight',
  'dompurify',
  'highlight.js',
  'katex',
  'marked',
  'marked-footnote',
  'marked-highlight',
  'mermaid',
  'workbox-cacheable-response',
  'workbox-core',
  'workbox-expiration',
  'workbox-precaching',
  'workbox-routing',
  'workbox-strategies',
  'workbox-window',
]

const FRONTEND_WORKSPACE_ROOTS = ['web', 'core']

// Resolve an installed package directory by walking node_modules from `fromDir`
// upward — the same lookup Node does, so it follows hoisting and nesting without
// tripping over packages that block `./package.json` in their exports map.
const findPkgDir = (name, fromDir) => {
  let dir = fromDir

  for (;;) {
    const candidate = join(dir, 'node_modules', name)

    if (existsSync(join(candidate, 'package.json'))) {
      return candidate
    }
    const parent = dirname(dir)

    if (parent === dir) {
      return null
    }
    dir = parent
  }
}

const stableObject = (value) =>
  Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b, 'en')))

const assertWorkspaceManifestsLocked = (workspaces) => {
  for (const workspace of workspaces) {
    const manifest = JSON.parse(readFileSync(join(pkgDir(workspace), 'package.json'), 'utf8'))
    const locked = lock.packages?.[`packages/${workspace}`]

    if (!locked) {
      throw new Error(`package-lock.json has no packages/${workspace} workspace entry`)
    }

    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
      'peerDependenciesMeta',
    ]) {
      if (
        JSON.stringify(stableObject(manifest[field])) !==
        JSON.stringify(stableObject(locked[field]))
      ) {
        throw new Error(
          `packages/${workspace}/package.json ${field} do not match package-lock.json; run \`make deps-vector\``,
        )
      }
    }
  }
}

const lockPathOf = (dir) => relative(root, dir).split(sep).join('/')

const assertInstalledPackageLocked = (dir, pkg) => {
  const lockPath = lockPathOf(dir)
  const locked = lock.packages?.[lockPath]

  if (!locked || locked.version !== pkg.version) {
    throw new Error(
      `${pkg.name || lockPath}@${pkg.version || '?'} does not match package-lock.json at ${lockPath}; run \`make deps-vector\``,
    )
  }
}

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense)(\b|[-_.])/i
const README_FILE = /^readme(\b|[-_.])/i

// Upstream packages mix LF/CRLF and occasionally carry spaces at line ends.
// Canonicalize only that non-semantic whitespace so the committed corpus stays
// deterministic and passes repository whitespace checks without rewriting text.
const normalizeLegalText = (text) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()

const uniqueTexts = (files) => {
  const seen = new Set()

  return files.flatMap((file) => {
    const text = normalizeLegalText(file.text)

    if (!text || seen.has(text)) {
      return []
    }
    seen.add(text)
    return [{ ...file, text }]
  })
}

// LICENSE and NOTICE are independent obligations. Preserve every root companion
// file instead of picking one and accidentally dropping an Apache NOTICE.
const readLicenseFiles = (dir) =>
  uniqueTexts(
    readdirSync(dir)
      .filter((file) => LICENSE_FILE.test(file))
      .sort((a, b) => a.localeCompare(b))
      .flatMap((file) => {
        try {
          return [{ label: file, text: readFileSync(join(dir, file), 'utf8').trim() }]
        } catch {
          return []
        }
      }),
  )

// A few old npm packages put their complete license in README.md while omitting
// a companion file from the tarball. Keep that authored text before falling back
// to a reconstructed SPDX template.
const readReadmeLicense = (dir) => {
  const readme = readdirSync(dir).find((file) => README_FILE.test(file))

  if (!readme) {
    return null
  }
  let text

  try {
    text = readFileSync(join(dir, readme), 'utf8')
  } catch {
    return null
  }
  const heading = text.match(/^#{1,6}\s+licen[cs]e\s*$/im)

  if (heading?.index === undefined) {
    return null
  }
  const rest = text.slice(heading.index + heading[0].length).trimStart()
  const nextHeading = rest.search(/^#{1,6}\s+/m)
  const section = (nextHeading < 0 ? rest : rest.slice(0, nextHeading)).trim()

  return section ? { label: `${readme} — License`, text: section } : null
}

const spdxOf = (pkg) => {
  if (typeof pkg.license === 'string') {
    return pkg.license
  }
  if (pkg.license?.type) {
    return pkg.license.type
  }
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => l.type || l).join(' OR ')
  }

  return 'UNKNOWN'
}

const inferSpdx = (files) => {
  const text = files.map((file) => file.text).join('\n')

  if (/\bMIT License\b/i.test(text)) {
    return 'MIT'
  }
  if (/Apache License\s+Version 2\.0/i.test(text)) {
    return 'Apache-2.0'
  }
  if (/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i.test(text)) {
    return 'AGPL-3.0'
  }
  if (/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i.test(text)) {
    return 'LGPL-3.0'
  }
  if (/Mozilla Public License Version 2\.0/i.test(text)) {
    return 'MPL-2.0'
  }
  if (/Permission to use, copy, modify, and\/or distribute this software/i.test(text)) {
    return 'ISC'
  }

  return 'SEE-LICENSE'
}

const repoOf = (pkg) => {
  const r = pkg.repository
  const url = typeof r === 'string' ? r : r?.url

  if (!url) {
    return pkg.homepage || null
  }

  return url
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
}

const authorOf = (pkg) => {
  const a = pkg.author

  if (!a) {
    return null
  }

  return typeof a === 'string' ? a : [a.name, a.email && `<${a.email}>`].filter(Boolean).join(' ')
}

// Breadth-first over installed dependencies from the given roots. Visit each
// physical directory: two copies of the same name@version can resolve a nested
// dependency to different versions. Output is still deduplicated by name@version,
// but only after both physical dependency contexts have been traversed.
const collect = (roots) => {
  const found = new Map()
  const queue = roots.map((r) => ({ name: r.name, fromDir: r.fromDir, optional: false }))
  const visitedDirs = new Set()

  while (queue.length) {
    const { name, fromDir, optional } = queue.shift()

    if (name === 'notarium' || name.startsWith('@notarium/')) {
      continue
    }
    const dir = findPkgDir(name, fromDir)

    if (!dir) {
      if (!optional) {
        throw new Error(`required package ${name} is not installed (from ${fromDir})`)
      }
      continue
    }
    if (visitedDirs.has(dir)) {
      continue
    }
    visitedDirs.add(dir)
    let pkg

    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch (error) {
      throw new Error(`cannot read ${name} package.json at ${dir}`, { cause: error })
    }
    assertInstalledPackageLocked(dir, pkg)
    const resolvedName = pkg.name || name
    const version = pkg.version || '?'
    const key = `${resolvedName}@${version}`

    if (!found.has(key)) {
      const licenseFiles = readLicenseFiles(dir)
      const readmeLicense = licenseFiles.length ? null : readReadmeLicense(dir)
      const material = readmeLicense ? [readmeLicense] : licenseFiles
      const declaredSpdx = spdxOf(pkg)
      found.set(key, {
        name: resolvedName,
        version,
        dir,
        spdx: declaredSpdx === 'UNKNOWN' ? inferSpdx(material) : declaredSpdx,
        author: authorOf(pkg),
        repo: repoOf(pkg),
        declaration: {
          name: pkg.name,
          version: pkg.version,
          license: pkg.license,
          licenses: pkg.licenses,
          author: pkg.author,
          repository: pkg.repository,
        },
        licenseFiles: material,
      })
    }

    for (const dep of Object.keys(pkg.dependencies || {})) {
      queue.push({ name: dep, fromDir: dir, optional: false })
    }
    for (const dep of Object.keys(pkg.optionalDependencies || {})) {
      queue.push({ name: dep, fromDir: dir, optional: true })
    }
    for (const dep of Object.keys(pkg.peerDependencies || {})) {
      if (!pkg.peerDependenciesMeta?.[dep]?.optional) {
        queue.push({ name: dep, fromDir: dir, optional: false })
      }
    }
  }

  return [...found.values()].sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'),
  )
}

const rootsFromWorkspaces = (workspaces) => {
  const roots = []

  for (const w of workspaces) {
    const dir = pkgDir(w)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

    for (const dep of Object.keys(pkg.dependencies || {})) {
      roots.push({ name: dep, fromDir: dir })
    }
  }

  return roots
}

// A handful of npm tarballs omit a completed license companion. Never turn
// `package.json.author` into a made-up copyright notice. For packages whose
// exact upstream commit does contain the notice, fetch it. For the irreducible
// declaration-only cases, preserve the package's verbatim metadata and an
// unfilled standard template; every such exception is version-pinned so a bump
// fails closed and receives fresh human review.
const UPSTREAM_PACKAGE_MATERIAL = {
  'marked-footnote@1.4.0': {
    repo: 'bent10/marked-extensions',
    ref: 'faab750f00af4788397948286fb8f7fe0c929a7e',
    files: [['marked-extensions license', 'license']],
  },
  'react-force-graph-2d@1.29.1': {
    repo: 'vasturiano/react-force-graph',
    ref: '5ee21b693d83f62da569cba6e3cdf31e028406e1',
    files: [['react-force-graph LICENSE', 'LICENSE']],
  },
}

const MIT_TEMPLATE = `MIT License

Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

const ISC_TEMPLATE = `ISC License

Copyright (c) <year> <copyright holders>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`

const DECLARATION_ONLY_MATERIAL = {
  'abstract-logging@2.0.1': { spdx: 'MIT', template: MIT_TEMPLATE },
  'bezier-js@6.1.4': { spdx: 'MIT', template: MIT_TEMPLATE },
  'eastasianwidth@0.2.0': { spdx: 'MIT', template: MIT_TEMPLATE },
  'guid-typescript@1.0.9': { spdx: 'ISC', template: ISC_TEMPLATE },
}

const fetchUpstreamFile = async (label, url) => {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Notarium license-corpus generator' },
  })

  if (!response.ok) {
    throw new Error(`${label}: ${response.status} from ${url}`)
  }

  return { label, text: (await response.text()).trim() }
}

const hasFullPermissionText = (text) =>
  text.length >= 400 &&
  /Permission is hereby granted|Permission to use, copy, modify|Apache License\s+Version 2\.0|Redistribution and use in source and binary forms|GNU (?:AFFERO |LESSER )?GENERAL PUBLIC LICENSE|Mozilla Public License Version 2\.0|Blue Oak Model License|free and unencumbered software released into the public domain|Creative Commons Legal Code/i.test(
    text,
  )

const SHARP_LIBVIPS_SOURCE = {
  '1.2.4': '20b5e899954907a3039d6e3d4c200aaa0ec52c4c',
  '1.3.2': '4da6d14c0d59866adfb9d8cf52bcaa53846dc4f6',
}

const SUPPORTED_LICENSES = new Set([
  '0BSD',
  '(MIT OR CC0-1.0)',
  '(MPL-2.0 OR Apache-2.0)',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'ISC',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT OR Apache',
  'Unlicense',
])

const RECIPROCAL_LICENSE = /\b(?:A?GPL|LGPL|MPL|EPL|CDDL|EUPL|OSL|SSPL|CPAL)-?\d/i
const PERMISSIVE_OR = /\bOR\b.*\b(?:0BSD|MIT|ISC|BSD|Apache|BlueOak|Unlicense|CC0)\b/i

const requiresExactSource = (spdx) => RECIPROCAL_LICENSE.test(spdx) && !PERMISSIVE_OR.test(spdx)

const onnxSourceRef = (entry) => {
  const commitFile = join(entry.dir, '__commit.txt')

  if (existsSync(commitFile)) {
    return readFileSync(commitFile, 'utf8').trim()
  }

  return entry.version.match(/-([0-9a-f]{10,40})$/i)?.[1] || `v${entry.version}`
}

// Native npm packages sometimes omit the legal companions from their tarballs.
// Pull those texts from immutable upstream refs, and record the same ref as the
// exact source offer for the native payload.
const materializeUpstream = async (entry) => {
  const files = [...entry.licenseFiles]
  let exactSource = null
  const upstream = []
  const key = `${entry.name}@${entry.version}`
  const packageMaterial = UPSTREAM_PACKAGE_MATERIAL[key]

  if (!SUPPORTED_LICENSES.has(entry.spdx)) {
    throw new Error(
      `${key}: unsupported or unreviewed license expression ${JSON.stringify(entry.spdx)}`,
    )
  }

  if (packageMaterial) {
    const raw = `https://raw.githubusercontent.com/${packageMaterial.repo}/${packageMaterial.ref}`
    exactSource = `https://github.com/${packageMaterial.repo}/tree/${packageMaterial.ref}`
    upstream.push(...packageMaterial.files.map(([label, path]) => [label, `${raw}/${path}`]))
  }

  if (/^@img\/sharp-libvips-linux-(?:x64|arm64)$/.test(entry.name)) {
    const ref = SHARP_LIBVIPS_SOURCE[entry.version]

    if (!ref) {
      throw new Error(`no exact sharp-libvips source mapping for ${entry.version}`)
    }
    const raw = `https://raw.githubusercontent.com/lovell/sharp-libvips/${ref}`
    exactSource = `https://github.com/lovell/sharp-libvips/tree/${ref}`
    upstream.push(
      ['sharp-libvips LICENSE', `${raw}/LICENSE`],
      ['sharp-libvips THIRD-PARTY-NOTICES.md', `${raw}/THIRD-PARTY-NOTICES.md`],
      [
        'LGPL-3.0-or-later text (SPDX license-list-data v3.28.0)',
        'https://raw.githubusercontent.com/spdx/license-list-data/v3.28.0/text/LGPL-3.0-or-later.txt',
      ],
    )
    const versionsFile = join(entry.dir, 'versions.json')

    if (existsSync(versionsFile)) {
      files.push({
        label: 'versions.json — native build inputs',
        text: readFileSync(versionsFile, 'utf8').trim(),
      })
    }
  } else if (entry.name.startsWith('onnxruntime-')) {
    const ref = onnxSourceRef(entry)
    const raw = `https://raw.githubusercontent.com/microsoft/onnxruntime/${ref}`
    exactSource = `https://github.com/microsoft/onnxruntime/tree/${ref}`
    upstream.push(['ONNX Runtime LICENSE', `${raw}/LICENSE`])

    if (entry.name === 'onnxruntime-node' || entry.name === 'onnxruntime-web') {
      upstream.push(['ONNX Runtime ThirdPartyNotices.txt', `${raw}/ThirdPartyNotices.txt`])
    }
  } else if (entry.name === 'sqlite-vec' || entry.name.startsWith('sqlite-vec-')) {
    const ref = `v${entry.version}`
    const raw = `https://raw.githubusercontent.com/asg017/sqlite-vec/${ref}`
    exactSource = `https://github.com/asg017/sqlite-vec/tree/${ref}`
    upstream.push(
      ['sqlite-vec LICENSE-MIT', `${raw}/LICENSE-MIT`],
      ['sqlite-vec LICENSE-APACHE', `${raw}/LICENSE-APACHE`],
    )
  }

  files.push(...(await Promise.all(upstream.map(([label, url]) => fetchUpstreamFile(label, url)))))

  const hasPermissionText = files.some(({ text }) => hasFullPermissionText(text))

  if (!hasPermissionText && DECLARATION_ONLY_MATERIAL[key]?.spdx === entry.spdx) {
    const fallback = DECLARATION_ONLY_MATERIAL[key]
    files.push({
      label: 'package.json — verbatim upstream license declaration',
      text: JSON.stringify(entry.declaration, null, 2),
    })
    files.push({
      label: `${entry.spdx} standard template — placeholders retained`,
      text:
        'The published package omits a completed copyright notice. No holder or year is inferred here.\n\n' +
        fallback.template,
    })
  }

  const licenseFiles = uniqueTexts(files)

  if (!licenseFiles.length || !licenseFiles.some(({ text }) => hasFullPermissionText(text))) {
    throw new Error(`${entry.name}@${entry.version}: no usable license material (${entry.spdx})`)
  }
  if (requiresExactSource(entry.spdx) && !exactSource) {
    throw new Error(`${key}: reciprocal license needs an exact source mapping`)
  }

  return { ...entry, exactSource, licenseFiles }
}

const renderEntry = (e) => {
  const head = `## ${e.name}  ${e.version}  —  ${e.spdx}`
  const meta = []

  if (e.author) {
    meta.push(e.author)
  }
  if (e.repo) {
    meta.push(e.repo)
  }
  if (e.exactSource) {
    meta.push(`Exact source: ${e.exactSource}`)
  }
  const body = e.licenseFiles
    .map(({ label, text }) => `### ${label}\n\n\`\`\`\`text\n${text}\n\`\`\`\``)
    .join('\n\n')
  return [head, meta.join(' · '), '', body].filter((x) => x !== undefined).join('\n')
}

const reciprocalSection = (entries) => {
  const recip = entries.filter((e) => requiresExactSource(e.spdx))

  if (!recip.length) {
    return ''
  }
  const missingSource = recip.filter((entry) => !entry.exactSource)

  if (missingSource.length) {
    throw new Error(
      `reciprocal packages need exact source mappings: ${missingSource
        .map((entry) => `${entry.name}@${entry.version}`)
        .join(', ')}`,
    )
  }
  const rows = recip
    .map((e) => `- **${e.name} ${e.version}** (${e.spdx}) — Corresponding Source: ${e.exactSource}`)
    .join('\n')
  return (
    '\n## Weak-copyleft components — Corresponding Source\n\n' +
    'These are conveyed as separately linked libraries. The exact upstream refs\n' +
    'below pin and identify the source archives, build recipes and downstream\n' +
    'patches used for the published npm artifacts. Notarium redistributes those\n' +
    'installed artifacts without applying further source or binary modifications.\n\n' +
    rows +
    '\n'
  )
}

const summaryTable = (entries) =>
  '| Package | Version | License |\n| --- | --- | --- |\n' +
  entries.map((e) => `| ${e.name} | ${e.version} | ${e.spdx} |`).join('\n') +
  '\n'

const SENTINELS = ['@huggingface/transformers', 'onnxruntime-node', 'sharp', 'sqlite-vec']

const renderPlainEntry = (entry) => {
  const meta = [entry.author, entry.repo, entry.exactSource && `Exact source: ${entry.exactSource}`]
    .filter(Boolean)
    .join(' · ')
  const files = entry.licenseFiles
    .map(({ label, text }) => `${label}\n${'-'.repeat(label.length)}\n${text}`)
    .join('\n\n')

  return `${entry.name} ${entry.version} — ${entry.spdx}\n${meta}\n${'='.repeat(70)}\n${files}`
}

const main = async () => {
  assertWorkspaceManifestsLocked([
    ...new Set([...RUNTIME_WORKSPACE_ROOTS, ...FRONTEND_WORKSPACE_ROOTS]),
  ])

  const runtimeInventory = collect([
    ...rootsFromWorkspaces(RUNTIME_WORKSPACE_ROOTS),
    ...RUNTIME_EXTRA_ROOTS.map((name) => ({ name, fromDir: root })),
  ])
  const frontendInventory = collect([
    ...rootsFromWorkspaces(FRONTEND_WORKSPACE_ROOTS),
    ...FRONTEND_ROOTS.map((name) => ({ name, fromDir: pkgDir('web') })),
  ])

  // The lightweight install omits the vector native stack, while the image ships
  // it. Refuse to emit a corpus from that incomplete profile.
  const missing = SENTINELS.filter((name) => !runtimeInventory.some((entry) => entry.name === name))

  if (missing.length) {
    throw new Error(
      `runtime set is missing ${missing.join(', ')}; run \`make deps-vector\` before generating`,
    )
  }

  const [runtime, frontend] = await Promise.all([
    Promise.all(runtimeInventory.map(materializeUpstream)),
    Promise.all(frontendInventory.map(materializeUpstream)),
  ])

  const runtimeDoc =
    `# Third-party notices — runtime (server & native)\n\n` +
    `Generated by \`scripts/gen-licenses.mjs\` — do not edit by hand. Covers the\n` +
    `third-party components installed into the published image's \`node_modules\`\n` +
    `by \`npm ci --omit=dev\`, including required peers, the prebuilt web workspace's\n` +
    `production packages and the optional vector native stack. First-party code is under\n` +
    `the root LICENSE / NOTICE / COMMERCIAL-LICENSE.md. Browser-bundle notices live\n` +
    `in packages/web/public/licenses/THIRD_PARTY_NOTICES.txt.\n\n` +
    `${runtime.length} components.\n\n` +
    summaryTable(runtime) +
    reciprocalSection(runtime) +
    '\n' +
    runtime.map(renderEntry).join('\n\n---\n\n') +
    '\n'

  const frontendDoc =
    `Third-party notices — Notarium web bundle\n` +
    `=========================================\n\n` +
    `Generated by scripts/gen-licenses.mjs — do not edit by hand. These libraries are\n` +
    `bundled into the SPA served to your browser; their licenses require their notices\n` +
    `to travel with the (minified) code. Notarium itself is AGPL-3.0-only + commercial\n` +
    `(see /licenses/NOTARIUM-LICENSE.txt). Server-side runtime notices: THIRD_PARTY_NOTICES.md in the source\n` +
    `tree / at /app in the image.\n\n` +
    `${frontend.length} components.\n\n` +
    frontend.map(renderPlainEntry).join('\n\n' + '='.repeat(70) + '\n\n') +
    '\n'

  writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), runtimeDoc)
  const frontendOut = join(root, 'packages/web/public/licenses')
  mkdirSync(frontendOut, { recursive: true })
  writeFileSync(join(frontendOut, 'THIRD_PARTY_NOTICES.txt'), frontendDoc)
  writeFileSync(
    join(frontendOut, 'NOTARIUM-LICENSE.txt'),
    readFileSync(join(root, 'LICENSE'), 'utf8'),
  )

  process.stdout.write(
    `runtime: ${runtime.length} components → THIRD_PARTY_NOTICES.md\n` +
      `frontend: ${frontend.length} components → packages/web/public/licenses/THIRD_PARTY_NOTICES.txt\n` +
      `first-party: LICENSE → packages/web/public/licenses/NOTARIUM-LICENSE.txt\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`gen-licenses: ${String(error?.stack || error)}\n`)
  process.exit(1)
})
