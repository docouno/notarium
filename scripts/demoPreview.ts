// Compose the README banner, the social card and the gallery out of the demo stills, plus
// the background plates the docs site sets its own type over: `make demo-preview` (or
// `make footage`, which shoots them first). See docs/demo-screenshots.md; the composition
// lives in test/demo/preview.
import { type PreviewSet, renderPreview } from '../test/demo/preview'

const SETS: PreviewSet[] = ['all', 'artwork', 'plates']

const set = (process.env.DEMO_SET || 'all') as PreviewSet

if (!SETS.includes(set)) {
  process.stderr.write(`DEMO_SET must be one of ${SETS.join(', ')} — got "${set}"\n`)
  process.exit(1)
}

const { artifacts, removed } = await renderPreview({ locale: process.env.LOCALE, set })

for (const { file, bytes } of artifacts) {
  process.stdout.write(`  ${file.padEnd(28)} ${(bytes / 1024).toFixed(0).padStart(5)} KB\n`)
}

// The two halves land in different repositories, so one "total (committed)" would be a
// lie about half of them: the plates are git-ignored here and committed by the docs site.
const size = (files: typeof artifacts): number => files.reduce((sum, a) => sum + a.bytes, 0)
const plateFiles = artifacts.filter((a) => a.file.startsWith('assets/og/'))
const artworkFiles = artifacts.filter((a) => !a.file.startsWith('assets/og/'))

for (const [label, files] of [
  ['total (committed)', artworkFiles],
  ['total (for the docs repo)', plateFiles],
] as const) {
  if (files.length > 0) {
    process.stdout.write(
      `  ${label.padEnd(28)} ${(size(files) / 1024).toFixed(0).padStart(5)} KB\n`,
    )
  }
}

// Deleting a tracked, README-linked file is not something a run gets to do quietly.
if (removed.length > 0) {
  process.stdout.write(
    `\n  removed ${removed.length} stale gallery file(s): ${removed.join(', ')}\n` +
      `  the README may still link them — check before committing\n`,
  )
}
