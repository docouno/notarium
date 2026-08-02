import { chromium } from '@playwright/test'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp, { type Sharp } from 'sharp'
import { readFont, readHeadline, readMark, readThemeTokens, REPO } from './sources'
import {
  BANNER,
  type Canvas,
  composition,
  OG_DOC,
  OG_HERO,
  type Plate,
  plateComposition,
  SOCIAL,
} from './template'

// Stage two of `make footage`: compose the published artwork out of the stills stage
// one photographed. Stage one owns the product; this owns the plate around it.
//
// It is a plain script rather than a Playwright test because there is nothing to
// assert and no server to boot — just a browser over a static page. It still runs in
// the Playwright container, for the same reason the shoot does: these pixels are
// published, and host fonts differ.

/** Only the dark theme is published in this set — one deliberate look, half the files. */
const THEME = 'dark'

/** The frame the banner is built on. Which one carries a hero is a judgement about the
 *  CROP — the banner shows roughly the window's top half, so a frame whose subject sits
 *  low (the graph's node cloud, the spotlight's result list) arrives half-eaten.
 *  `DEMO_HERO=<frame> make demo-preview` re-cuts it against another candidate without
 *  editing this file, which is how the pick gets made: by looking, not by describing. */
const HERO_FRAME = process.env.DEMO_HERO || 'reader'

/** The frame the OG hero plate is built on. It currently matches the banner's, but it is a
 *  SEPARATE decision, because the crop is: the plate reserves its top 384px for the docs
 *  site's headline, so it shows a shallower band of window than the banner does, and a
 *  frame can read well in one of those and thin in the other. Tried against the landing's
 *  own hero frame (the graph) first — in this crop only the sparse top of the node cloud
 *  survives, which is exactly the failure the banner comment describes. Same override
 *  shape as `DEMO_HERO`. */
const PLATE_FRAME = process.env.DEMO_PLATE_HERO || 'reader'

/** The legible evidence under the banner, in the order the README shows them: one frame
 *  per claim the README makes. It deliberately excludes whatever `HERO_FRAME` is — the
 *  banner is already a crop of that one, and a gallery opening with the picture above it
 *  reads as padding. Change the hero, change this list (and the README's links with it).
 *  `search` is the one frame in neither: it is the spotlight over a blurred dashboard,
 *  so it says less than the dashboard it covers. */
const GALLERY = ['editor', 'history', 'graph', 'dashboard'] as const

/** ONE place for the encode, as in the docs repo's importer: changing these re-cuts
 *  every artifact, so do it here and re-run rather than per file. */
const WEBP = { quality: 82, effort: 6 } as const

/** The social card cannot be WebP — GitHub's social-preview upload takes PNG, JPG or
 *  GIF only, under 1 MB. Of those, JPEG is the honest choice for THIS picture: it is
 *  mostly wide smooth gradient, which is what DCT is good at and what a PNG cannot
 *  compress (lossless: 674 KB) unless you quantise it to a palette, which bands the
 *  gradient by up to 33 levels — measured, not assumed. 4:4:4 keeps the chroma of the
 *  small UI text in the window intact. */
const JPEG = { quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true } as const

/** Published width for the README assets. GitHub renders the README column at ~880
 *  CSS px, so this is ~2× on a retina display — crisp, without paying for pixels no
 *  reader will ever see. */
const README_WIDTH = 2000
const GALLERY_WIDTH = 1760

/** The OG plates are an INTERMEDIATE: the docs build decodes one, sets type over it and
 *  re-encodes the result, so whatever this encode loses is lost again downstream — on
 *  exactly the material (wide smooth gradients, a noise tile) that shows it first.
 *  Lossless was the safe assumption and it is wrong: measured, the plate goes 493 KB →
 *  42 KB at q95, and the CARDS built on the two are indistinguishable — the difference
 *  lands in the turbulence tile (2% of pixels off by more than 3 levels, no banding on
 *  the gradient). A committed file re-cut on every geometry change does not get to cost
 *  half a megabyte of history for a difference nobody can see. */
const PLATE = { quality: 95, effort: 6 } as const

/** Plates are written at 1×: the OG card they end up in is 1200×630, so a 2× plate would
 *  only be downsampled again at the far end, by a renderer with no reason to do it better
 *  than the encoder here does. */
const PLATES = [OG_HERO, OG_DOC] satisfies Plate[]

/** Where the committed artwork lands. */
const ASSETS = 'assets'

/** …and the plates, one directory down: they are not README artwork, they are an export
 *  for the docs site, and the manifest beside them is part of the contract. */
const PLATE_DIR = 'assets/og'
const PLATE_MANIFEST = 'plates.json'

type Artifact = {
  file: string
  bytes: number
}

const frameFile = (locale: string, frame: string): string =>
  join(REPO, 'test/demo/out', locale, `${frame}-${THEME}.png`)

/** Fail early and usefully: a missing still means the shoot has not run, and every
 *  message here should name the command that fixes it. */
const requireFrames = async (
  locale: string,
  need: { artwork: boolean; plates: boolean },
): Promise<void> => {
  const dir = join(REPO, 'test/demo/out', locale)
  let present: string[] = []

  try {
    present = await readdir(dir)
  } catch {
    throw new Error(
      `no stills in test/demo/out/${locale} — run \`make demo-shots\` first (or \`make footage\`, which does both)`,
    )
  }

  const wanted = [
    ...(need.artwork ? [HERO_FRAME, ...GALLERY] : []),
    ...(need.plates ? [PLATE_FRAME] : []),
  ]
  const missing = [...new Set(wanted)]
    .map((f) => `${f}-${THEME}.png`)
    .filter((f) => !present.includes(f))

  if (missing.length > 0) {
    throw new Error(
      `test/demo/out/${locale} is missing ${missing.join(', ')} — re-run \`make demo-shots\``,
    )
  }
}

/** Stage one starts from an empty output dir so a failed frame cannot leave the previous
 *  run's PNG behind. The same has to hold here, for a sharper reason: these files are
 *  COMMITTED and linked from the README, so a frame dropped from `GALLERY` would
 *  otherwise sit in git forever, still published, with nothing pointing at it. Only the
 *  gallery is swept — the banner and the card are rewritten every run under fixed names.
 *  What was removed is returned, not swallowed: this deletes tracked files. */
const pruneGallery = async (out: string): Promise<string[]> => {
  const keep = new Set(GALLERY.map((frame) => `app-${frame}.webp`))
  const stale = (await readdir(out).catch(() => [])).filter(
    (file) => /^app-.+\.webp$/.test(file) && !keep.has(file),
  )

  await Promise.all(stale.map((file) => rm(join(out, file))))

  return stale
}

/** Which half of the export to re-cut. Both halves are COMMITTED but answer to different
 *  things — the artwork to the README's copy, the plates to the docs site's layout — and
 *  the world is anchored to the day of the shoot, so re-cutting everything to fix one of
 *  them leaves a binary diff on files nobody meant to touch. */
export type PreviewSet = 'all' | 'artwork' | 'plates'

export type PreviewOptions = {
  locale?: string
  set?: PreviewSet
}

export type PreviewResult = {
  artifacts: Artifact[]
  /** Gallery files that no longer belong to the set and were deleted. */
  removed: string[]
}

export const renderPreview = async ({
  locale = 'en',
  set = 'all',
}: PreviewOptions = {}): Promise<PreviewResult> => {
  const artwork = set !== 'plates'
  const plates = set !== 'artwork'
  await requireFrames(locale, { artwork, plates })

  const [copy, tokens, font, mark] = await Promise.all([
    readHeadline(),
    readThemeTokens(),
    readFont(),
    readMark(),
  ])

  const work = join(REPO, 'test/demo/out', locale, 'preview')
  const out = join(REPO, ASSETS)
  const plateOut = join(REPO, PLATE_DIR)
  await mkdir(work, { recursive: true })
  await mkdir(out, { recursive: true })
  await mkdir(plateOut, { recursive: true })
  // Sweeping the gallery is an artwork concern: a plates-only run has no business
  // deleting a committed file it was never asked to look at.
  const removed = artwork ? await pruneGallery(out) : []

  const browser = await chromium.launch()
  const artifacts: Artifact[] = []

  /** Write the page, photograph its canvas. `scale` is 2 for published artwork (so it
   *  survives a retina display and the downscale on encode cleans up the rasterisation),
   *  1 for plates, which are consumed at their own size. */
  const shoot = async (
    name: string,
    html: string,
    box: { width: number; height: number },
    scale: number,
    /** A plate without a window has no image to decode before the shot. */
    hasShot = true,
  ): Promise<Buffer> => {
    // The composition page is written to disk rather than pushed in with setContent: it
    // keeps the still a plain <img src> (no multi-megabyte data URI), and it leaves an
    // artifact you can open in a browser when a frame looks wrong.
    const pagePath = join(work, `${name}.html`)
    await writeFile(pagePath, html)

    const context = await browser.newContext({ viewport: box, deviceScaleFactor: scale })
    const tab = await context.newPage()
    // pathToFileURL, not `file://` + path: a checkout under a directory with a space
    // or a `#` in its name produces a URL Chromium reads as a different file, or as
    // none. This flow is supposed to run anywhere, so it must not assume a tidy path.
    await tab.goto(pathToFileURL(pagePath).href)
    // Wait for the two things that are not painted yet on load: the inlined face
    // (a shot of fallback metrics is a re-run) and the still itself. Awaited inside
    // the page rather than returned from it — `document.fonts.ready` resolves to a
    // FontFaceSet, which serialises across the wire as a bare `{}` and reads like a
    // wait that is not doing anything.
    await tab.evaluate(async () => {
      await document.fonts.ready
    })
    if (hasShot) {
      await tab.locator('.frame img').evaluate((el: HTMLImageElement) => el.decode())
    }
    const png = await tab.locator('.canvas').screenshot({ type: 'png' })
    await context.close()

    return png
  }

  try {
    for (const canvas of artwork ? ([BANNER, SOCIAL] satisfies Canvas[]) : []) {
      const shot = await shoot(
        canvas.name,
        composition({
          canvas,
          copy,
          tokens,
          font,
          mark,
          // Relative to the page, which sits one directory below the stills.
          shot: `../${HERO_FRAME}-${THEME}.png`,
        }),
        { width: canvas.width, height: canvas.height },
        2,
      )

      artifacts.push(
        canvas === SOCIAL
          ? await encode(
              sharp(shot).resize({ width: canvas.width }).jpeg(JPEG),
              join(out, `${canvas.name}.jpg`),
            )
          : await encode(
              sharp(shot).resize({ width: README_WIDTH }).webp(WEBP),
              join(out, `${canvas.name}.webp`),
            ),
      )
    }

    for (const plate of plates ? PLATES : []) {
      const shot = await shoot(
        plate.name,
        plateComposition({ plate, tokens, font, shot: `../${PLATE_FRAME}-${THEME}.png` }),
        { width: plate.width, height: plate.height },
        1,
        plate.shotWidth !== null,
      )

      artifacts.push(await encode(sharp(shot).webp(PLATE), join(plateOut, `${plate.name}.webp`)))
    }

    if (plates) {
      artifacts.push(await writeManifest(plateOut))
    }
  } finally {
    await browser.close()
  }

  // Guarded like everything else the artwork half owns. Unguarded it re-encoded the four
  // committed, README-linked gallery files on a plates-only run — the exact binary diff this
  // target exists to avoid — and it read stills that `requireFrames` no longer demanded for
  // that set, so a partial shoot died on a raw sharp error instead of naming `make demo-shots`.
  for (const frame of artwork ? GALLERY : []) {
    artifacts.push(
      await encode(
        sharp(frameFile(locale, frame)).resize({ width: GALLERY_WIDTH }).webp(WEBP),
        join(out, `app-${frame}.webp`),
      ),
    )
  }

  return { artifacts, removed }
}

const encode = async (pipeline: Sharp, path: string): Promise<Artifact> => {
  const { size } = await pipeline.toFile(path)

  return { file: relative(REPO, path), bytes: size }
}

/** The plates' contract, written beside them. The consumer sets type over a picture it
 *  cannot see: it needs the canvas it was cut at and the line its text must clear, and it
 *  needs them from the export rather than from a number someone copied into another repo.
 *  Keyed by plate name so a consumer that only knows about one of them still reads cleanly. */
const writeManifest = async (dir: string): Promise<Artifact> => {
  const path = join(dir, PLATE_MANIFEST)
  const manifest = Object.fromEntries(
    PLATES.map((p) => [
      p.name,
      { file: `${p.name}.webp`, width: p.width, height: p.height, textZone: p.textZone },
    ]),
  )
  const body = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(path, body)

  return { file: relative(REPO, path), bytes: Buffer.byteLength(body) }
}
