// The visual baseline protocol: pull the canonical images, publish what a run
// actually rendered as an immutable candidate, and — separately, deliberately —
// move the channel that says which candidate is canonical.
// canon: docs/ci.md#visual-baselines
//
//   node scripts/visualBaseline.mjs pull
//   node scripts/visualBaseline.mjs publish --candidate <slug> --commit <sha>
//   node scripts/visualBaseline.mjs accept  --candidate <slug>
//   node scripts/visualBaseline.mjs verdict            # the answer, published nowhere
//
// What a run decided is read from Playwright's JSON report, so the suite must be run
// with `--reporter=list,json` (PLAYWRIGHT_JSON_OUTPUT_NAME=visual-report.json).
//
// Two properties this is built to have, both learned the expensive way elsewhere:
//
// ACCEPT NEVER RENDERS. The failing run already produced the pixels; re-rendering at
// approval time would be a second, independently non-deterministic pass, and you
// would be accepting something other than what you looked at. So `publish` uploads
// the complete candidate and `accept` only moves a pointer.
//
// UNCHANGED CELLS KEEP THEIR EXACT BYTES. A cell that "passed" passed within
// Playwright's tolerance, not byte-for-byte. Carrying its fresh render into the new
// baseline would let sub-threshold noise accumulate approval by approval until it
// crosses the threshold on its own. So the candidate reuses the existing blob for
// every cell that did not fail.
//
// KNOWN GAP: Playwright reports cells that changed and cells that are new, never
// cells that disappeared. A cell dropped from the matrix keeps its entry in the
// manifest indefinitely. Harmless while the matrix keeps its shape; it needs real
// handling when the responsive work (#26) reshapes the set of frames.

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { getObject, headObject, presignGet, putObject, sha256hex } from './visualBaselineStore.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SNAPSHOT_DIR = join(root, 'test/visual/visual.spec.ts-snapshots')

// Playwright names a baseline `<cell>-<project>-<platform>.png` but its failure
// artefacts only `<cell>-actual.png`, so the two have to be related by a suffix we
// know rather than one we can read off the files. Overridable, and asserted against
// the manifest below — guessing wrong would silently pair a cell with the wrong
// baseline, which is the one mistake this whole protocol exists to prevent.
const SUFFIX = process.env.VISUAL_SNAPSHOT_SUFFIX || '-chromium-linux.png'

// WHERE the baselines live is deployment configuration, not source. No defaults: a
// fork running its own visual lane points these at its own storage, and a default
// would send it at a bucket it does not own — failing, with its own credentials, as an
// unexplained 403 against someone else's name rather than as "you did not configure
// this". The protocol below is S3-compatible and knows nothing else about the provider.
const config = {
  endpoint: process.env.VISUAL_S3_ENDPOINT,
  region: process.env.VISUAL_S3_REGION,
  keyId: process.env.VISUAL_S3_KEY_ID,
  secret: process.env.VISUAL_S3_SECRET,
}
const baselineBucket = process.env.VISUAL_S3_BASELINE_BUCKET
const reviewBucket = process.env.VISUAL_S3_REVIEW_BUCKET

const CHANNEL = 'v1/channels/main.json'

/**
 * What the gate needs, handed over as a dotenv report.
 *
 * `VISUAL_REVIEW` is a BUCKET PATH, not a link, and that is a retreat from something
 * that could not work. A presigned URL cannot be delivered: printed in the log it
 * arrives with [MASKED] where X-Amz-Credential sits (the key id is a masked variable),
 * and as an environment URL it is silently dropped — GitLab caps external_url at 255
 * characters and a SigV4 URL is around 360. A path is short, survives redaction, is
 * still true in a month, and says exactly where to look until there is a service that
 * can serve these pages properly.
 *
 * The two counts are separate because they mean different things: pixels that moved
 * are reviewed and accepted, a test that failed without a screenshot is a red suite
 * and there is nothing to accept.
 */
const REVIEW_ENV_FILE = 'review.env'
const REPORT_FILE = 'visual-report.json'

const writeReviewEnv = (path, diffs, failures) =>
  writeFile(
    join(root, REVIEW_ENV_FILE),
    `VISUAL_REVIEW=${path || '—'}\nVISUAL_DIFFS=${diffs}\nVISUAL_FAILURES=${failures}\n`,
  )
const blobKey = (digest) => `v1/blobs/sha256/${digest}`
const snapshotKey = (digest) => `v1/snapshots/sha256/${digest}.json`
const candidateKey = (slug) => `v1/channels/candidates/${slug}.json`

const die = (message) => {
  console.error(`visual-baseline: ${message}`)
  process.exit(1)
}

const say = (message) => console.error(message)

export const flags = (argv) => {
  const out = {}

  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) {
      continue
    }
    const next = argv[i + 1]
    // A valueless flag is `true` — including the LAST argument, where `next` is
    // undefined. Reading that as "no value given, so undefined" turns `--bootstrap`
    // into a silent no-op precisely when it is typed the natural way.
    out[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? true : argv[(i += 1)]
  }

  return out
}

/**
 * The heart of the protocol, kept pure so it can be tested rather than trusted: the
 * cell map of the next candidate, given the current baseline and what this run
 * re-rendered.
 *
 * `rendered` is [cellName, digest] for every cell the run produced a NEW image for —
 * in practice the ones Playwright reported as different. Every other cell keeps the
 * digest it already had, byte for byte. That is the invariant: a cell that "passed"
 * passed within a tolerance, so adopting its fresh render would let sub-threshold
 * noise accumulate approval by approval until it crosses the threshold on its own.
 */
export const mergeCells = (baselineCells, rendered) => {
  const cells = { ...baselineCells }
  const changed = []

  for (const [cell, digest] of rendered) {
    if (cells[cell] === digest) {
      continue
    }
    changed.push({ cell, digest, added: !(cell in cells) })
    cells[cell] = digest
  }

  return { cells, changed }
}

/**
 * What the run actually decided, read from Playwright's own JSON report rather than
 * from the files it left behind.
 *
 * Walking `test-results/` cannot answer the question. With retries on, an attempt
 * writes `<cell>-actual.png` under its own directory, and the directory says nothing
 * about the verdict:
 *
 *   - a cell that failed twice leaves two artefacts, and two independent renders of
 *     one cell differ in bytes — so digest comparison does not collapse them either.
 *     That is how a 60-cell matrix once reported "70 of 60 changed";
 *   - worse, a cell that failed once and PASSED on retry leaves an artefact for the
 *     failed attempt and none for the successful one. Reading the directory publishes
 *     that flake as a change and reddens the gate over pixels Playwright itself
 *     already ruled acceptable — a flake laundered into the baseline by approval.
 *
 * `status` is Playwright's verdict across all attempts: `flaky` is exactly the second
 * case and is dropped here, which is the whole flake guard — the retry already IS the
 * second render, so nothing needs to be rendered twice on purpose.
 *
 * `broken` carries the third possibility, which the pixel count cannot express: a test
 * that failed without producing a screenshot at all (a timeout, a broken page). It has
 * no diff to review, and silently contributing nothing would leave the gate green on a
 * red suite.
 */
export const reportOutcome = (report) => {
  const cells = []
  const flaky = []
  const broken = []

  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status === 'flaky') {
          flaky.push(spec.title)
          continue
        }
        if (test.status !== 'unexpected') {
          continue
        }
        // The last attempt is the one that stood: earlier ones were superseded.
        const attachments = test.results?.[test.results.length - 1]?.attachments ?? []
        const actuals = attachments.filter((a) => a.path?.endsWith('-actual.png'))

        if (!actuals.length) {
          broken.push(spec.title)
          continue
        }
        for (const { path } of actuals) {
          const stem = basename(path, '-actual.png')

          cells.push({
            stem,
            actual: path,
            diff: attachments.find((a) => a.path?.endsWith(`${stem}-diff.png`))?.path,
          })
        }
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child)
    }
  }

  for (const suite of report.suites ?? []) {
    visit(suite)
  }

  return { cells, flaky, broken }
}

/** Every baseline name must carry the suffix we pair failure artefacts by. Guessing
 *  it wrong would silently associate a cell with someone else's baseline. */
export const assertSuffix = (cellNames, suffix) => {
  const stray = cellNames.find((name) => !name.endsWith(suffix))

  if (stray) {
    throw new Error(`baseline cell "${stray}" does not end with "${suffix}"`)
  }
}

/** Say out loud what was dropped and what has no diff to look at. A guard that
 *  silently swallows cells is indistinguishable from one that is not running. */
const sayOutcome = ({ flaky, broken }) => {
  if (flaky.length) {
    say(`visual-baseline: ${flaky.length} cell(s) flaked and passed on retry — not published`)
    for (const title of flaky) {
      say(`  flaky: ${title}`)
    }
  }
  if (broken.length) {
    say(`visual-baseline: ${broken.length} test(s) failed without a screenshot — see the job log`)
    for (const title of broken) {
      say(`  failed: ${title}`)
    }
  }
}

const readJson = async (bucket, key) => {
  const raw = await getObject(config, bucket, key)

  return raw ? JSON.parse(raw.toString('utf8')) : null
}

const writeJson = (bucket, key, value) =>
  putObject(
    config,
    bucket,
    key,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    'application/json',
  )

/** The manifest is addressed by its own digest, which is what makes a snapshot
 *  immutable: the same set of cells and identity always lands on the same key, and a
 *  different one cannot overwrite it. */
const manifestDigest = (manifest) => sha256hex(JSON.stringify(manifest.cells))

const currentManifest = async () => {
  const channel = await readJson(baselineBucket, CHANNEL)

  if (!channel) {
    return null
  }
  const manifest = await readJson(baselineBucket, snapshotKey(channel.snapshot))

  if (!manifest) {
    die(`channel points at snapshot ${channel.snapshot}, which does not exist`)
  }

  return manifest
}

// --- pull --------------------------------------------------------------------
// Into a staging directory, verifying every blob against the digest the manifest
// names, and only then swapping. A half-finished download must never be able to
// leave a partial set of "canonical" images behind for the next run to compare to.
const pull = async () => {
  const manifest = await currentManifest()

  if (!manifest) {
    say('visual-baseline: no channel yet — nothing to compare against (first run)')

    return
  }
  const staging = `${SNAPSHOT_DIR}.staging`

  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })

  const cells = Object.entries(manifest.cells)

  for (const [name, digest] of cells) {
    const blob = await getObject(config, baselineBucket, blobKey(digest))

    if (!blob) {
      die(`blob ${digest} for ${name} is missing — the snapshot is not self-contained`)
    }
    if (sha256hex(blob) !== digest) {
      die(`blob ${digest} for ${name} does not hash to its own name`)
    }
    await writeFile(join(staging, name), blob)
  }

  const previous = `${SNAPSHOT_DIR}.previous`

  await rm(previous, { recursive: true, force: true })
  await mkdir(dirname(SNAPSHOT_DIR), { recursive: true })
  await rename(SNAPSHOT_DIR, previous).catch(() => {})
  await rename(staging, SNAPSHOT_DIR)
  await rm(previous, { recursive: true, force: true })

  say(`visual-baseline: pulled ${cells.length} cells from snapshot ${manifest.snapshot ?? ''}`)
}

// --- publish -----------------------------------------------------------------
// Fail closed: without the report there is no verdict to publish, and defaulting to
// "nothing failed" would announce a green baseline for a run nobody looked at.
const readReport = async (path) => {
  const raw = await readFile(join(root, path), 'utf8').catch(() => null)

  if (!raw) {
    die(`no Playwright report at ${path} — run the suite with --reporter=list,json`)
  }

  return JSON.parse(raw)
}

const publish = async ({ candidate, commit, pipeline, bootstrap, report = REPORT_FILE }) => {
  if (!candidate) {
    die('publish needs --candidate <slug>')
  }
  // Bootstrapping is an EXPLICIT act, not something inferred from a missing pointer.
  // Inferring it means the meaning of a run depends on remote state: the same command
  // publishes a comparison one day and a whole new baseline set the next, and the
  // difference is invisible at the call site.
  const baseline = bootstrap ? null : await currentManifest()

  if (!baseline && !bootstrap) {
    die('no channel yet — pass --bootstrap to publish the rendered set as a first baseline')
  }
  // Bootstrap renders the whole set with --update-snapshots, so every test passes and
  // there is no verdict to read: the snapshot directory IS the candidate.
  const outcome = baseline ? reportOutcome(await readReport(report)) : null

  let cells

  if (baseline) {
    try {
      assertSuffix(Object.keys(baseline.cells), SUFFIX)
    } catch (error) {
      die(`${error.message} — set VISUAL_SNAPSHOT_SUFFIX`)
    }
    cells = { ...baseline.cells }
  } else {
    // Bootstrap: no channel exists, so the run generated the whole set itself and the
    // snapshot directory is the candidate.
    cells = {}
    for (const name of await readdir(SNAPSHOT_DIR).catch(() => [])) {
      if (name.endsWith('.png')) {
        cells[name] = sha256hex(await readFile(join(SNAPSHOT_DIR, name)))
      }
    }
    say(`visual-baseline: bootstrapping a first snapshot from ${Object.keys(cells).length} cells`)
  }

  let changed = []
  const uploads = new Map()

  if (baseline) {
    const rendered = []
    const diffFor = new Map()

    for (const { stem, actual, diff } of outcome.cells) {
      const bytes = await readFile(actual)
      const digest = sha256hex(bytes)

      rendered.push([`${stem}${SUFFIX}`, digest])
      diffFor.set(`${stem}${SUFFIX}`, diff)
      uploads.set(digest, bytes)
    }

    const merged = mergeCells(cells, rendered)

    cells = merged.cells
    changed = merged.changed.map((entry) => ({ ...entry, diff: diffFor.get(entry.cell) }))
    sayOutcome(outcome)
  } else {
    for (const [name, digest] of Object.entries(cells)) {
      uploads.set(digest, await readFile(join(SNAPSHOT_DIR, name)))
    }
  }

  if (baseline && !changed.length) {
    say('visual-baseline: nothing differs from the channel — no candidate published')
    await writeReviewEnv(null, 0, outcome.broken.length)

    return
  }

  for (const [digest, bytes] of uploads) {
    // Content-addressed, so an unchanged cell costs one HEAD instead of an upload.
    // This is what keeps a 240-frame matrix from paying for a full set per approval.
    if (!(await headObject(config, baselineBucket, blobKey(digest)))) {
      await putObject(config, baselineBucket, blobKey(digest), bytes, 'image/png')
    }
  }

  const manifest = {
    schema: 1,
    cells,
    identity: {
      commit: commit ?? null,
      pipeline: pipeline ?? null,
      image: process.env.PLAYWRIGHT_TEST_IMAGE ?? null,
    },
  }
  const digest = manifestDigest(manifest)

  await writeJson(baselineBucket, snapshotKey(digest), { ...manifest, snapshot: digest })
  await writeJson(baselineBucket, candidateKey(candidate), {
    snapshot: digest,
    commit: commit ?? null,
    pipeline: pipeline ?? null,
  })

  const review = await publishReview({ candidate, changed, cells, pipeline, commit })

  const total = Object.keys(cells).length

  say(`visual-baseline: candidate ${candidate} → snapshot ${digest}`)
  say(
    baseline
      ? `visual-baseline: ${changed.length} of ${total} cells changed`
      : `visual-baseline: ${total} cells, all of them new`,
  )
  await writeReviewEnv(review, changed.length, outcome ? outcome.broken.length : 0)
  if (review) {
    say(`visual-baseline: review page at ${review}`)
  }
}

// --- review ------------------------------------------------------------------
// A small page of presigned links, NOT inlined images: a global change (a font, a
// colour token) touches every cell, and at 240 frames an inlined page would be tens
// of megabytes — unusable exactly when review matters most. Expected and actual are
// already content-addressed blobs in the baseline bucket, so only the diff images
// are uploaded here.
//
// The page is reached by opening it OUT of the bucket by hand, so its key has to be
// legible in a listing of hundreds: `<date>-<candidate>` sorts chronologically and
// names the exact ref and commit, where a bare pipeline id ("2334") identifies a
// review only to whoever still remembers that number. It is also literally the
// candidate slug `visual:accept` takes, so the folder name answers "which one do I
// accept" without a lookup.
const publishReview = async ({ candidate, changed, cells, pipeline, commit }) => {
  if (!changed.length) {
    return null
  }
  const day = new Date().toISOString().slice(0, 10)
  const prefix = `reviews/${day}-${candidate}`
  const rows = []

  for (const { cell, digest, diff } of changed) {
    let diffUrl = null

    if (diff) {
      const key = `${prefix}/diff/${cell}`

      await putObject(config, reviewBucket, key, await readFile(diff), 'image/png')
      diffUrl = presignGet(config, reviewBucket, key)
    }
    rows.push({
      cell,
      diffUrl,
      actual: presignGet(config, baselineBucket, blobKey(digest)),
      expected: null,
    })
  }

  const page = renderReview({
    candidate,
    rows,
    total: Object.keys(cells).length,
    commit,
    pipeline,
    day,
  })
  const key = `${prefix}/index.html`

  await putObject(config, reviewBucket, key, Buffer.from(page), 'text/html; charset=utf-8')

  // The BUCKET PATH, not a URL. A presigned link cannot be handed over anyway: it is
  // ~360 characters, and GitLab caps an environment URL at 255, so the button this
  // used to fill silently stayed empty. Until there is a service that can serve these
  // pages, the honest answer is where the file is — short, unmasked, and still true
  // in a month.
  return `${reviewBucket}/${key}`
}

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

export const renderReview = ({ candidate, rows, total, commit, pipeline, day }) => `<!doctype html>
<meta charset="utf-8">
<title>visual review — ${escapeHtml(candidate)}</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; background: #111; color: #eee }
  h1 { font-size: 1rem; font-weight: 600 }
  .lead { color: #f5a97f; margin-bottom: .5rem }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 0 0 2rem;
       font-family: ui-monospace, monospace; color: #9ac }
  dt { color: #667 }
  dd { margin: 0 }
  figure { margin: 0 0 3rem }
  figcaption { font-family: ui-monospace, monospace; margin-bottom: .5rem; color: #9ac }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem }
  img { width: 100%; border: 1px solid #333; background: #000 }
</style>
<h1>visual review — ${escapeHtml(candidate)}</h1>
<p class="lead">${rows.length} of ${total} cells changed.${
  rows.length > total / 2
    ? ' Most of the matrix moved at once — that is usually render drift, not a design change.'
    : ''
}</p>
<!-- Written into the page, not only into the key: whoever opens this file has
     downloaded it out of a bucket and no longer has the folder name in front of them. -->
<dl>
  <dt>candidate</dt><dd>${escapeHtml(candidate)}</dd>
  <dt>commit</dt><dd>${escapeHtml(commit ?? '—')}</dd>
  <dt>pipeline</dt><dd>${escapeHtml(pipeline ?? '—')}</dd>
  <dt>rendered</dt><dd>${escapeHtml(day)}</dd>
  <dt>to accept</dt><dd>run visual:accept on this pipeline</dd>
</dl>
${rows
  .map(
    ({ cell, actual, diffUrl }) => `<figure>
  <figcaption>${escapeHtml(cell)}</figcaption>
  <div class="pair">
    ${diffUrl ? `<img loading="lazy" src="${escapeHtml(diffUrl)}" alt="diff">` : '<div></div>'}
    <img loading="lazy" src="${escapeHtml(actual)}" alt="actual">
  </div>
</figure>`,
  )
  .join('\n')}
`

// --- accept ------------------------------------------------------------------
// The only privileged operation, and it does nothing but move a pointer at pixels
// that were uploaded and looked at earlier.
const accept = async ({ candidate }) => {
  if (!candidate) {
    die('accept needs --candidate <slug>')
  }
  const pointer = await readJson(baselineBucket, candidateKey(candidate))

  if (!pointer) {
    die(`no candidate "${candidate}"`)
  }
  if (!(await headObject(config, baselineBucket, snapshotKey(pointer.snapshot)))) {
    die(`candidate points at snapshot ${pointer.snapshot}, which does not exist`)
  }
  await writeJson(baselineBucket, CHANNEL, {
    snapshot: pointer.snapshot,
    commit: pointer.commit ?? null,
    acceptedFrom: candidate,
  })
  say(`visual-baseline: channel now at snapshot ${pointer.snapshot}`)
}

// --- verdict -----------------------------------------------------------------
// The comparison's answer WITHOUT publishing it. The writer credential is protected,
// so on an ordinary branch there is nothing to publish a candidate with — but the
// comparison still ran and still has a verdict, and a lane that could not report it
// would be a gate that quietly stops gating exactly where most work happens.
const verdict = async ({ report = REPORT_FILE }) => {
  const outcome = reportOutcome(await readReport(report))

  sayOutcome(outcome)
  say(`visual-baseline: ${outcome.cells.length} cell(s) differ from the pulled baseline`)
  await writeReviewEnv(null, outcome.cells.length, outcome.broken.length)
}

// --- entry -------------------------------------------------------------------
// Only when RUN, not when imported: the argument parser is a pure function worth a
// unit test, and importing it must not start moving baselines around.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [command, ...rest] = process.argv.slice(2)
  const options = flags(rest)
  const remote = command !== 'verdict'

  // Named one by one rather than as "storage is not configured": a half-set
  // environment is the normal failure here (a credential pair present, the bucket
  // forgotten), and the useful message is which variable is missing.
  if (remote) {
    const missing = [
      ['VISUAL_S3_ENDPOINT', config.endpoint],
      ['VISUAL_S3_REGION', config.region],
      ['VISUAL_S3_KEY_ID', config.keyId],
      ['VISUAL_S3_SECRET', config.secret],
      ['VISUAL_S3_BASELINE_BUCKET', baselineBucket],
      // Only a comparing publish writes a review page. `pull` and `accept` never touch
      // that bucket, and neither does `--bootstrap`: it has no baseline to differ from,
      // so there is nothing to review. Demanding the variable there would block the one
      // command that has to run before the lane can work at all.
      ...(command === 'publish' && !options.bootstrap
        ? [['VISUAL_S3_REVIEW_BUCKET', reviewBucket]]
        : []),
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name)

    if (missing.length > 0) {
      die(
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required — see docs/ci.md#visual-baselines`,
      )
    }
  }

  if (command === 'verdict') {
    await verdict(options)
  } else if (command === 'pull') {
    await pull()
  } else if (command === 'publish') {
    await publish(options)
  } else if (command === 'accept') {
    await accept(options)
  } else {
    die(`unknown command "${command ?? ''}" — expected pull, publish, accept or verdict`)
  }
}
