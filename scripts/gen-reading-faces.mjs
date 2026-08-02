#!/usr/bin/env node
// Generator for the reading-typography fonts (#27). Downloads the self-hosted
// woff2 subsets for every bundled reading/code font from Fontsource and emits
// the @font-face partial. Re-run to refresh or to add a font.
//
//   node scripts/gen-reading-faces.mjs
//
// It writes:
//   packages/web/public/fonts/*.woff2          (the subsetted font files)
//   packages/web/src/styles/reading-faces.scss (GENERATED @font-face rules)
//
// Why a generator: each font ships a different matrix of {subset × style} files
// (some lack greek, italic, vietnamese …). Probing + emitting only the faces that
// actually exist keeps the CSS honest (no @font-face pointing at a missing file)
// and the 100+ files manageable. Coverage is deliberately the European scripts a
// woff2 subset can carry cheaply (latin, latin-ext, cyrillic, greek, vietnamese);
// CJK/Arabic/etc. are left to the OS font via the fallback stack (reading.scss).

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FONTS_DIR = join(root, 'packages/web/public/fonts')
const SCSS_OUT = join(root, 'packages/web/src/styles/reading-faces.scss')
const CDN = 'https://cdn.jsdelivr.net/fontsource/fonts'
const NPM = 'https://cdn.jsdelivr.net/npm'
// Pin the Fontsource release the vendored woff2 came from — all families share
// the monorepo version. Pinning replaces the mutable `@latest` so a re-run is
// reproducible and the binaries do not churn, and it names the exact upstream a
// font's license text belongs to.
const FONTSOURCE_VERSION = '5.3.0'

// Fontsource's canonical (= Google Fonts') subset unicode-ranges. The browser
// fetches a subset file only when a glyph in its range appears AND the family is
// the active one. Order here is the emit order.
const SUBSETS = {
  latin:
    'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  'latin-ext':
    'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
  cyrillic: 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116',
  greek: 'U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF',
  vietnamese:
    'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB',
}
const STYLES = ['normal', 'italic']

// slug = Fontsource id; family = the CSS font-family name reading.scss references.
const FONTS = [
  // sans
  { slug: 'inter', family: 'Inter' },
  { slug: 'open-sans', family: 'Open Sans' },
  { slug: 'roboto', family: 'Roboto' },
  { slug: 'source-sans-3', family: 'Source Sans 3' },
  { slug: 'noto-sans', family: 'Noto Sans' },
  // serif
  { slug: 'lora', family: 'Lora' },
  { slug: 'literata', family: 'Literata' },
  { slug: 'merriweather', family: 'Merriweather' },
  { slug: 'source-serif-4', family: 'Source Serif 4' },
  { slug: 'noto-serif', family: 'Noto Serif' },
  // mono
  { slug: 'jetbrains-mono', family: 'JetBrains Mono' },
  { slug: 'fira-code', family: 'Fira Code' },
  { slug: 'cascadia-code', family: 'Cascadia Code' },
]

// Copyright statements for the families whose Fontsource LICENSE does NOT carry one.
//
// Fontsource builds that header from Google Fonts metadata, and for a few families
// mirrored through Google Fonts the metadata holds only the vendor name — so their
// LICENSE opens with a bare "Google Inc." where the copyright statement belongs. That
// is wrong twice over: OFL-1.1 §2 permits redistribution only with "the above
// copyright notice", and for these three the holder is not Google at all.
//
// So the statement is taken from the font project itself, verbatim, and the URL it
// came from is recorded here rather than in a commit message. Anything not listed
// here must arrive with its own copyright line — see the check in loadProvenance.
//
// These WIN over the upstream header rather than filling in for a missing one. If a
// later Fontsource release starts shipping a copyright line for these families, a
// fallback would silently adopt it — and the failure being guarded against is not "no
// holder" but "the wrong holder", which a present-but-wrong line does not fix. The
// pinned version is what keeps this list honest: it can only go stale on a bump, and
// a bump is when someone is looking.
// The source URL is data, not a comment: it is emitted into LICENSES.md so the
// recipient of the corpus can check the substitution, and a comment does not travel.
const COPYRIGHT_OVERRIDES = {
  'cascadia-code': {
    statement:
      'Copyright (c) 2019 - Present, Microsoft Corporation,\nwith Reserved Font Name Cascadia Code.',
    source: 'https://github.com/microsoft/cascadia-code/blob/main/LICENSE',
  },
  'source-sans-3': {
    statement:
      "Copyright 2010-2024 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. All Rights Reserved. Source is a trademark of Adobe in the United States and/or other countries.",
    source: 'https://github.com/adobe-fonts/source-sans/blob/release/LICENSE.md',
  },
  'source-serif-4': {
    // Typographic quotes around ‘Source’ are upstream's — verbatim means verbatim.
    statement:
      'Copyright 2014 - 2023 Adobe (http://www.adobe.com/), with Reserved Font Name ‘Source’. All Rights Reserved. Source is a trademark of Adobe in the United States and/or other countries.',
    source: 'https://github.com/adobe-fonts/source-serif/blob/release/LICENSE.md',
  },
}

const meta = async (slug) => {
  const pkg = `@fontsource-variable/${slug}`
  const r = await fetch(`${NPM}/${pkg}@${FONTSOURCE_VERSION}/metadata.json`)

  if (!r.ok) {
    throw new Error(`meta ${slug}: ${r.status}`)
  }
  const d = await r.json()
  const w = d.weights || []
  return {
    subsets: new Set(d.subsets || []),
    styles: new Set(d.styles || []),
    wmin: Math.min(...w),
    wmax: Math.max(...w),
  }
}

const download = async (url) => {
  const r = await fetch(url)

  if (!r.ok) {
    throw new Error(`font ${url}: ${r.status}`)
  }

  return Buffer.from(await r.arrayBuffer())
}

// Fetch each family's upstream OFL license text (copyright + Reserved Font Names +
// the full OFL 1.1 body) from its pinned Fontsource package and write it beside the
// woff2, plus a human-readable index. This is the notice OFL-1.1 requires to travel
// with the redistributed fonts — a bare "all fonts are OFL" line is not enough.
const loadProvenance = async () =>
  Promise.all(
    FONTS.map(async ({ slug, family }) => {
      const pkg = `@fontsource-variable/${slug}`
      const r = await fetch(`${NPM}/${pkg}@${FONTSOURCE_VERSION}/LICENSE`)

      if (!r.ok) {
        throw new Error(`license ${slug}: ${r.status}`)
      }
      const upstream = (await r.text()).trim()

      if (!/SIL OPEN FONT LICENSE/i.test(upstream)) {
        throw new Error(`license ${slug}: pinned package did not return an OFL text`)
      }

      // The attribution header is the block before the OFL body, and it is the half
      // the license actually requires us to carry. Where upstream ships a real
      // copyright statement it is used verbatim; where it ships a bare holder name we
      // substitute the font project's own statement and record where it came from.
      const body = upstream
        .split(/This Font Software is licensed/i)
        .slice(1)
        .join('This Font Software is licensed')
      const upstreamHeader = upstream.split(/This Font Software is licensed/i)[0].trim()
      const override = COPYRIGHT_OVERRIDES[slug]
      const header =
        override?.statement ?? (/^copyright\b/i.test(upstreamHeader) ? upstreamHeader : null)

      // Fail rather than degrade. Shipping a font whose notice names no copyright
      // holder — or names the wrong one — is the failure this whole sidecar exists to
      // prevent, and it is invisible in a diff of 120 binaries.
      if (!header) {
        throw new Error(
          `license ${slug}: upstream header carries no copyright statement ("${upstreamHeader.split('\n')[0]}") — ` +
            `add the font project's own statement to COPYRIGHT_OVERRIDES with the URL it came from`,
        )
      }

      const text = `${header}\n\nThis Font Software is licensed${body}`
      // Flattened, not first-line: a statement wrapped across lines upstream would
      // otherwise be cut at the newline with no ellipsis to show it — losing the
      // Reserved Font Name while still looking like a complete notice.
      const line = header
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ')
      const copyright = line.length > 88 ? `${line.slice(0, 88)}…` : line
      return {
        slug,
        family,
        text,
        substituted: Boolean(override),
        source: override?.source,
        row: `| ${family} | \`${pkg}\` | ${FONTSOURCE_VERSION} | OFL-1.1 | ${copyright.replace(/\|/g, '/')}${override ? ' [^s]' : ''} | [licenses/${slug}.txt](licenses/${slug}.txt) |`,
      }
    }),
  )

const writeProvenance = async (materials, fontsDir) => {
  const licensesDir = join(fontsDir, 'licenses')
  const licensesMd = join(fontsDir, 'LICENSES.md')

  await rm(licensesDir, { recursive: true, force: true })
  await mkdir(licensesDir, { recursive: true })
  for (const { slug, text } of materials) {
    await writeFile(join(licensesDir, `${slug}.txt`), text + '\n')
  }

  // The footnote is only emitted when something actually carries it — a marker
  // explained but never used reads as a leftover, and one used but unexplained is
  // worse. It has to travel WITH the corpus: the generator does not ship in the
  // image, so this file is the only place a recipient can learn that three headers
  // did not come from the package named beside them.
  const substituted = materials.filter(({ substituted: s }) => s)
  const footnote = substituted.length
    ? `\n\n[^s]: Copyright statement taken from the font project itself, not from the\n` +
      `Fontsource package: for these families that package's \`LICENSE\` opens with a bare\n` +
      `vendor name where the copyright statement belongs, and the holder it names is not\n` +
      `the right one. The OFL body below each is upstream's, verbatim. Sources —\n` +
      substituted.map(({ family, source }) => `${family}: <${source}>`).join('; ') +
      `.\n`
    : '\n'

  const md =
    `# Bundled fonts — licenses & provenance\n\n` +
    `Every reading/code font vendored in this directory is licensed under the SIL\n` +
    `Open Font License 1.1 (\`OFL-1.1\`). Each family's exact license text — its\n` +
    `copyright statement and any Reserved Font Name — is in \`licenses/<slug>.txt\`,\n` +
    `redistributed with the woff2 as the OFL requires.\n\n` +
    `Generated by \`scripts/gen-reading-faces.mjs\` from the pinned Fontsource variable\n` +
    `packages (\`@fontsource-variable/<slug>@${FONTSOURCE_VERSION}\`) — do not edit by\n` +
    `hand. The license body is theirs verbatim; a copyright statement marked [^s] was\n` +
    `taken from the font project instead. See README.md for the subset/coverage\n` +
    `rationale.\n\n` +
    `| Family | Package | Version | License | Copyright | Text |\n` +
    `| --- | --- | --- | --- | --- | --- |\n` +
    materials.map(({ row }) => row).join('\n') +
    footnote
  await writeFile(licensesMd, md)
}

// Stage every generated path before replacing anything. Each final rename is
// atomic, and an error during the multi-path commit restores all prior targets.
const commitReplacements = async (replacements) => {
  const transaction = randomUUID()
  const applied = []

  try {
    for (const { target, staged } of replacements) {
      const backup = join(dirname(target), `.${basename(target)}.backup-${transaction}`)
      const state = { target, staged, backup, hadTarget: false, installed: false }

      try {
        await rename(target, backup)
        state.hadTarget = true
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error
        }
      }

      applied.push(state)
      await rename(staged, target)
      state.installed = true
    }
  } catch (error) {
    const rollbackErrors = []

    for (const state of applied.reverse()) {
      try {
        if (state.installed) {
          await rm(state.target, { recursive: true, force: true })
        }
        if (state.hadTarget) {
          await rename(state.backup, state.target)
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }

    if (rollbackErrors.length) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'generated-file commit and rollback failed',
      )
    }
    throw error
  }

  for (const { backup, hadTarget } of applied) {
    if (hadTarget) {
      await rm(backup, { recursive: true, force: true })
    }
  }
}

// `--licenses-only` regenerates just the license/provenance sidecar, leaving the
// woff2 binaries untouched — materialize the OFL corpus without re-downloading.
const licensesOnly = process.argv.includes('--licenses-only')

const main = async () => {
  await mkdir(FONTS_DIR, { recursive: true })
  const provenance = await loadProvenance()
  const stagingRoot = await mkdtemp(join(dirname(FONTS_DIR), '.fonts-generation-'))
  const stagedFonts = join(stagingRoot, 'fonts')

  try {
    await cp(FONTS_DIR, stagedFonts, { recursive: true })
    await writeProvenance(provenance, stagedFonts)

    if (licensesOnly) {
      await commitReplacements([{ target: FONTS_DIR, staged: stagedFonts }])
      process.stdout.write(`\nWrote ${FONTS.length} license files + LICENSES.md\n`)
      return
    }

    const faces = []
    const binaries = []
    let count = 0

    for (const { slug, family } of FONTS) {
      const m = await meta(slug)
      const weight = m.wmin === m.wmax ? `${m.wmin}` : `${m.wmin} ${m.wmax}`

      for (const [subset, range] of Object.entries(SUBSETS)) {
        if (!m.subsets.has(subset)) {
          continue
        }
        for (const style of STYLES) {
          if (!m.styles.has(style)) {
            continue
          }
          const file = `${slug}-${subset}-${style}.woff2`
          const url = `${CDN}/${slug}:vf@${FONTSOURCE_VERSION}/${subset}-wght-${style}.woff2`
          const bytes = await download(url)
          count++
          binaries.push({ file, bytes })
          faces.push(
            `@font-face {\n` +
              `  font-family: '${family}';\n` +
              `  font-style: ${style};\n` +
              `  font-weight: ${weight};\n` +
              `  font-display: swap;\n` +
              `  src: url('/fonts/${file}') format('woff2');\n` +
              `  unicode-range: ${range};\n` +
              `}`,
          )
        }
      }
      process.stdout.write(`  ${family}: ${faces.length} faces so far\n`)
    }

    for (const f of await readdir(stagedFonts)) {
      if (f.endsWith('.woff2')) {
        await rm(join(stagedFonts, f))
      }
    }
    for (const { file, bytes } of binaries) {
      await writeFile(join(stagedFonts, file), bytes)
    }

    const header =
      `/* GENERATED by scripts/gen-reading-faces.mjs — do not edit by hand (#27).\n` +
      `   Self-hosted woff2 @font-face for the reading/code fonts, split by subset\n` +
      `   (latin / latin-ext / cyrillic / greek / vietnamese) via unicode-range so the\n` +
      `   browser fetches only the subset a note uses and only when the family is\n` +
      `   active. Preset mappings + sizes live in reading.scss; the fallback stack\n` +
      `   there hands non-European scripts (CJK/Arabic/…) to the OS font. */\n\n`
    const stagedScss = join(stagingRoot, 'reading-faces.scss')

    await writeFile(stagedScss, header + faces.join('\n\n') + '\n')
    await commitReplacements([
      { target: FONTS_DIR, staged: stagedFonts },
      { target: SCSS_OUT, staged: stagedScss },
    ])
    process.stdout.write(
      `\nWrote ${count} woff2 + ${faces.length} @font-face → reading-faces.scss\n` +
        `Wrote ${FONTS.length} license files + LICENSES.md\n`,
    )
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + '\n')
  process.exit(1)
})
