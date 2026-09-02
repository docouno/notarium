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

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { getObject, headObject, presignGet, putObject, sha256hex } from './visualBaselineStore.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SNAPSHOT_DIR = join(root, 'test/visual/visual.spec.ts-snapshots')

// Playwright failure artefacts are only `<cell>-actual.png`, so config and protocol
// share one fixed canonical renderer/path contract. An environment override here
// could make the publisher name cells differently from the runner that rendered them.
export const VISUAL_SNAPSHOT_SUFFIX = '-chromium-linux.png'
export const VISUAL_SNAPSHOT_PATH_TEMPLATE =
  '{testDir}/visual/visual.spec.ts-snapshots/{arg}-chromium-linux{ext}'

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
 * The three counts are separate because they mean different things: pixels that moved
 * are reviewed and accepted, non-pixel/report-integrity failures are a red suite, and
 * a retry-pass stays red without contributing fresh bytes to a candidate.
 */
const REVIEW_ENV_FILE = 'review.env'
const HANDOFF_FILE = 'visual-handoff.json'
const PULLED_BASE_FILE = 'visual-pulled-base.json'
const REPORT_FILE = 'visual-report.json'

const dotenvValue = (name, value) => {
  const text = String(value ?? '')

  if (!text || /[\r\n]/u.test(text)) {
    throw new Error(`${name} must be a non-empty single-line value`)
  }

  return text
}

export const reviewEnvironment = (path, diffs, failures, flakes, acceptTarget) => {
  const lines = [
    `VISUAL_REVIEW=${path || '—'}`,
    `VISUAL_DIFFS=${diffs}`,
    `VISUAL_FAILURES=${failures}`,
    `VISUAL_FLAKES=${flakes}`,
  ]

  if (acceptTarget) {
    for (const [name, value] of [
      ['VISUAL_CANDIDATE', acceptTarget.candidate],
      ['VISUAL_CANDIDATE_COMMIT', acceptTarget.commit],
      ['VISUAL_CANDIDATE_PIPELINE', acceptTarget.pipeline],
      ['VISUAL_CANDIDATE_JOB', acceptTarget.job],
      ['VISUAL_CANDIDATE_SNAPSHOT', acceptTarget.snapshot],
      ['VISUAL_CANDIDATE_BASE_SNAPSHOT', acceptTarget.baseSnapshot ?? 'none'],
    ]) {
      lines.push(`${name}=${dotenvValue(name, value)}`)
    }
  }

  return `${lines.join('\n')}\n`
}
const writeReviewEnv = (path, diffs, failures, flakes, acceptTarget = null) =>
  writeFile(
    join(root, REVIEW_ENV_FILE),
    reviewEnvironment(path, diffs, failures, flakes, acceptTarget),
  )
export const visualHandoff = (path, diffs, failures, flakes, acceptTarget, flakyCells) => ({
  schema: 2,
  review: path || null,
  counts: { diffs, failures, flakes },
  flakyCells,
  accept: acceptTarget ?? null,
})

export const pulledBaseEvidence = (snapshot) => ({
  schema: 1,
  snapshot: snapshot ?? null,
})

export const assertPulledBaseEvidence = (evidence) => {
  if (evidence?.schema !== 1) {
    throw new Error(
      `pulled visual base schema mismatch: expected 1, got ${evidence?.schema ?? '—'}`,
    )
  }
  if (evidence.snapshot !== null && (typeof evidence.snapshot !== 'string' || !evidence.snapshot)) {
    throw new Error('pulled visual base snapshot must be a non-empty string or null')
  }

  return evidence
}

export const assertChannelMatchesPulledBase = (pulled, currentSnapshot) => {
  assertPulledBaseEvidence(pulled)
  const current = currentSnapshot ?? null

  if (current !== pulled.snapshot) {
    throw new Error(
      `visual channel moved after pull: pulled ${pulled.snapshot ?? 'no channel'}, current ${current ?? 'no channel'}`,
    )
  }
}
const writeVisualOutcome = async (
  path,
  diffs,
  failures,
  flakes,
  acceptTarget = null,
  flakyCells = [],
) => {
  const handoff = assertVisualHandoff(
    visualHandoff(path, diffs, failures, flakes, acceptTarget, flakyCells),
  )

  await Promise.all([
    writeReviewEnv(path, diffs, failures, flakes, acceptTarget),
    writeFile(join(root, HANDOFF_FILE), `${JSON.stringify(handoff, null, 2)}\n`),
  ])
}
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
    // undefined. Keep boolean command flags independent from their position.
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

/** Normalize report artefacts into manifest cells before reading or uploading bytes.
 *  A shared snapshot directory makes screenshot arguments global: two specs/projects
 *  using the same argument would otherwise silently overwrite one manifest entry. */
export const normalizeReportedCells = (reported) => {
  const seen = new Set()

  return reported.map((entry) => {
    const cell = `${entry.stem}${VISUAL_SNAPSHOT_SUFFIX}`

    if (seen.has(cell)) {
      throw new Error(`duplicate rendered cell "${cell}" in Playwright report`)
    }
    seen.add(cell)

    return { ...entry, cell }
  })
}

/** A first candidate has no accepted cells to carry forward, so accepting a partial
 *  run would make omissions canonical. Later runs keep old cells on failures; the
 *  initial transition must contain at least one image and no broken/flaky tests. */
export const assertInitialCandidate = ({ cells, broken, flaky, integrity = [] }) => {
  if (!cells.length) {
    throw new Error('first candidate produced no screenshots')
  }
  if (broken.length || flaky.length || integrity.length) {
    throw new Error(
      `first candidate is incomplete (${broken.length} broken, ${flaky.length} flaky, ${integrity.length} report-integrity failures)`,
    )
  }
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
 * `broken` carries screenshot-less test failures. `integrity` carries failures of the
 * report as evidence: global runner errors, skipped/zero tests and duplicate declared
 * cell names. Neither can be accepted as a pixel change.
 */
export const reportOutcome = (report) => {
  const cells = []
  const flaky = []
  const broken = []
  const integrity = []
  const declared = new Map()
  let testCount = 0
  let observedSkipped = 0

  const titleFor = (spec, test) =>
    `${test.projectName ? `[${test.projectName}] ` : ''}${spec.title || '(untitled test)'}`

  const declareCells = (spec, test) => {
    const lastResult = test.results?.[test.results.length - 1]
    const annotations = test.annotations?.length
      ? test.annotations
      : (lastResult?.annotations ?? [])
    const visualAnnotations = annotations.filter((annotation) => annotation.type === 'visual-cell')
    const cells = []

    if (visualAnnotations.length !== 1) {
      integrity.push(
        `${titleFor(spec, test)} declared ${visualAnnotations.length} visual cells; expected exactly one`,
      )
    }

    for (const annotation of visualAnnotations) {
      const name = annotation.description

      if (typeof name !== 'string' || !name) {
        integrity.push(`${titleFor(spec, test)} declared an empty visual cell`)
        continue
      }
      const cell = `${name}${VISUAL_SNAPSHOT_SUFFIX}`
      const owner = declared.get(cell)

      if (owner) {
        integrity.push(
          `duplicate declared visual cell "${cell}": ${owner} and ${titleFor(spec, test)}`,
        )
      } else {
        declared.set(cell, titleFor(spec, test))
      }
      cells.push(cell)
    }

    return cells
  }

  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        testCount += 1
        const declaredCells = declareCells(spec, test)

        if (test.status === 'skipped') {
          observedSkipped += 1
          integrity.push(`skipped visual test: ${titleFor(spec, test)}`)
          continue
        }
        if (test.status === 'flaky') {
          if (declaredCells.length === 1) {
            flaky.push({ title: titleFor(spec, test), cell: declaredCells[0] })
          }
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
        if (actuals.length !== 1) {
          integrity.push(
            `${titleFor(spec, test)} attached ${actuals.length} actual screenshots; expected exactly one`,
          )
          continue
        }
        if (declaredCells.length !== 1) {
          continue
        }
        const path = actuals[0].path
        const stem = basename(path, '-actual.png')
        const actualCell = `${stem}${VISUAL_SNAPSHOT_SUFFIX}`

        if (actualCell !== declaredCells[0]) {
          integrity.push(
            `${titleFor(spec, test)} declared visual cell "${declaredCells[0]}" but attached "${actualCell}"`,
          )
          continue
        }
        cells.push({
          stem,
          actual: path,
          diff: attachments.find((a) => a.path?.endsWith(`${stem}-diff.png`))?.path,
        })
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child)
    }
  }

  for (const suite of report.suites ?? []) {
    visit(suite)
  }

  for (const error of report.errors ?? []) {
    integrity.push(`Playwright global error: ${error?.message ?? String(error)}`)
  }

  const statsSkipped = Number(report.stats?.skipped ?? 0)

  for (let i = observedSkipped; i < statsSkipped; i += 1) {
    integrity.push(`Playwright stats report skipped visual test ${i + 1} of ${statsSkipped}`)
  }

  const statsTotal = report.stats
    ? ['expected', 'unexpected', 'flaky', 'skipped'].reduce(
        (sum, key) => sum + Number(report.stats[key] ?? 0),
        0,
      )
    : null

  if (statsTotal !== null && statsTotal !== testCount) {
    integrity.push(
      `Playwright stats count ${statsTotal} does not match ${testCount} serialized visual tests`,
    )
  }

  if (testCount === 0 || statsTotal === 0) {
    integrity.push('Playwright report contains zero visual tests')
  }

  return { cells, flaky, broken, integrity }
}

export const visualFailureCount = ({ broken, integrity }) => broken.length + integrity.length
export const blocksCandidate = (outcome) => visualFailureCount(outcome) > 0

export const bindCarriedFlakyCells = (flaky, baselineCells) =>
  flaky.map(({ cell, title }) => {
    const digest = baselineCells[cell]

    if (typeof digest !== 'string' || !digest) {
      throw new Error(`flaky visual cell "${cell}" has no accepted baseline to carry`)
    }

    return { cell, digest, title }
  })

export const assertProducerIdentity = ({ candidate, commit, pipeline, job }) => {
  const identity = {
    candidate: dotenvValue('VISUAL_CANDIDATE', candidate),
    commit: dotenvValue('VISUAL_CANDIDATE_COMMIT', commit),
    pipeline: dotenvValue('VISUAL_CANDIDATE_PIPELINE', pipeline),
    job: dotenvValue('VISUAL_CANDIDATE_JOB', job),
  }

  if (!identity.candidate.endsWith(`-${identity.pipeline}-${identity.job}`)) {
    throw new Error('candidate slug must end with its exact pipeline and producer job ids')
  }

  return identity
}

export const candidatePointer = ({
  candidate,
  commit,
  pipeline,
  job,
  snapshot,
  baseSnapshot,
  review,
  carriedFlakyCells,
}) => ({
  schema: 2,
  candidate: dotenvValue('VISUAL_CANDIDATE', candidate),
  commit: dotenvValue('VISUAL_CANDIDATE_COMMIT', commit),
  pipeline: dotenvValue('VISUAL_CANDIDATE_PIPELINE', pipeline),
  job: dotenvValue('VISUAL_CANDIDATE_JOB', job),
  snapshot: dotenvValue('VISUAL_CANDIDATE_SNAPSHOT', snapshot),
  baseSnapshot:
    baseSnapshot === null ? null : dotenvValue('VISUAL_CANDIDATE_BASE_SNAPSHOT', baseSnapshot),
  review: dotenvValue('VISUAL_REVIEW', review),
  carriedFlakyCells,
})

export const assertCandidatePointer = (pointer, expected) => {
  if (pointer?.schema !== 2) {
    throw new Error(`candidate pointer schema mismatch: expected 2, got ${pointer?.schema ?? '—'}`)
  }

  for (const [field, envName] of [
    ['candidate', 'VISUAL_CANDIDATE'],
    ['commit', 'VISUAL_CANDIDATE_COMMIT'],
    ['pipeline', 'VISUAL_CANDIDATE_PIPELINE'],
    ['job', 'VISUAL_CANDIDATE_JOB'],
    ['snapshot', 'VISUAL_CANDIDATE_SNAPSHOT'],
    ['review', 'VISUAL_REVIEW'],
  ]) {
    const wanted = dotenvValue(envName, expected[field])

    if (pointer?.[field] !== wanted) {
      throw new Error(
        `candidate ${field} mismatch: expected ${wanted}, got ${pointer?.[field] ?? '—'}`,
      )
    }
  }
  const wantedBase =
    expected.baseSnapshot === null
      ? null
      : dotenvValue('VISUAL_CANDIDATE_BASE_SNAPSHOT', expected.baseSnapshot)

  if (pointer?.baseSnapshot !== wantedBase) {
    throw new Error(
      `candidate baseSnapshot mismatch: expected ${wantedBase ?? 'none'}, got ${pointer?.baseSnapshot ?? 'none'}`,
    )
  }
  if (JSON.stringify(pointer?.carriedFlakyCells) !== JSON.stringify(expected.carriedFlakyCells)) {
    throw new Error('candidate carriedFlakyCells mismatch')
  }
}

export const assertVisualHandoff = (handoff) => {
  if (handoff?.schema !== 2) {
    throw new Error(`visual handoff schema mismatch: expected 2, got ${handoff?.schema ?? '—'}`)
  }
  for (const name of ['diffs', 'failures', 'flakes']) {
    const value = handoff.counts?.[name]

    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`visual handoff ${name} must be a non-negative integer`)
    }
  }
  if (handoff.review !== null) {
    dotenvValue('VISUAL_REVIEW', handoff.review)
  }
  if (!Array.isArray(handoff.flakyCells) || handoff.flakyCells.length !== handoff.counts.flakes) {
    throw new Error('visual handoff flaky cell list does not match its count')
  }
  for (const row of handoff.flakyCells) {
    dotenvValue('visual flaky cell', row.cell)
    dotenvValue('visual flaky title', row.title)
    if (row.digest !== undefined) {
      dotenvValue('visual flaky digest', row.digest)
    }
  }
  if (handoff.accept) {
    assertProducerIdentity(handoff.accept)
    assertCandidatePointer(handoff.accept, handoff.accept)
    if (handoff.review !== handoff.accept.review) {
      throw new Error('visual handoff review does not match its candidate pointer')
    }
    if (handoff.counts.diffs === 0 || handoff.counts.failures) {
      throw new Error('visual handoff exposes an accept target without clean stable diffs')
    }
    if (handoff.counts.flakes && handoff.accept.baseSnapshot === null) {
      throw new Error('visual handoff cannot carry flaky cells without an accepted base')
    }
    if (JSON.stringify(handoff.flakyCells) !== JSON.stringify(handoff.accept.carriedFlakyCells)) {
      throw new Error('visual handoff flaky cells do not match its candidate pointer')
    }
    if (handoff.flakyCells.some(({ digest }) => typeof digest !== 'string' || !digest)) {
      throw new Error('accepted visual handoff must bind every carried flaky digest')
    }
  }

  return handoff
}

export const visualGateSummary = (handoff) => {
  const evidence = assertVisualHandoff(handoff)
  const { diffs, failures, flakes } = evidence.counts
  const lines = []

  if (failures) {
    lines.push(
      `visual: ${failures} non-pixel failure(s) — broken/skipped tests or invalid report evidence.`,
      "visual: read extended:postgres+visual's log; accepting a baseline cannot fix these.",
    )
  }
  if (flakes) {
    lines.push(
      `visual: ${flakes} test(s) passed only on retry — their fresh pixels were excluded and retry keeps this gate red.`,
      ...evidence.flakyCells.map(({ cell, title }) => `visual: flaky — ${title} (${cell})`),
    )
  }
  if (diffs) {
    lines.push(
      `visual: ${diffs} cells differ from the accepted baseline.`,
      `visual: review page — ${evidence.review ?? '—'}`,
      'visual: open it out of the bucket, and run visual:accept if the new rendering is right.',
    )
  }

  return {
    red: Boolean(failures || flakes || diffs),
    lines: lines.length ? lines : ['visual: matches the accepted baseline'],
  }
}

export const assertCarriedFlakyDigests = (carriedFlakyCells, candidateCells, baseCells) => {
  for (const { cell, digest } of carriedFlakyCells) {
    if (baseCells?.[cell] !== digest) {
      throw new Error(`flaky visual cell "${cell}" no longer matches its accepted base digest`)
    }
    if (candidateCells?.[cell] !== digest) {
      throw new Error(`candidate changed carried flaky cell "${cell}"`)
    }
  }
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
const sayOutcome = ({ flaky, broken, integrity = [] }) => {
  if (flaky.length) {
    say(
      `visual-baseline: ${flaky.length} cell(s) flaked and passed on retry — fresh bytes excluded`,
    )
    for (const { title, cell } of flaky) {
      say(`  flaky: ${title} (${cell})`)
    }
  }
  if (broken.length) {
    say(`visual-baseline: ${broken.length} test(s) failed without a screenshot — see the job log`)
    for (const title of broken) {
      say(`  failed: ${title}`)
    }
  }
  if (integrity.length) {
    say(`visual-baseline: ${integrity.length} report-integrity failure(s) — not published`)
    for (const failure of integrity) {
      say(`  invalid: ${failure}`)
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
export const manifestDigest = (manifest) => sha256hex(JSON.stringify(manifest))

export const bindManifestToChannel = (channelSnapshot, manifest) => {
  if (manifest.snapshot && manifest.snapshot !== channelSnapshot) {
    throw new Error(
      `channel points at snapshot ${channelSnapshot}, but the manifest identifies itself as ${manifest.snapshot}`,
    )
  }

  // Legacy manifests already contain this field, but the channel is the authority for
  // their address. Materializing it here keeps the stale-base guard correct even for a
  // pre-field manifest instead of weakening "no channel" and "unknown base" into the
  // same state.
  return { ...manifest, snapshot: channelSnapshot }
}

const currentChannelSnapshot = async () => {
  const channel = await readJson(baselineBucket, CHANNEL)

  if (!channel) {
    return null
  }
  if (typeof channel.snapshot !== 'string' || !channel.snapshot) {
    throw new Error('visual channel has no valid snapshot identity')
  }

  return channel.snapshot
}

const manifestAtSnapshot = async (snapshot) => {
  if (snapshot === null) {
    return null
  }
  const manifest = await readJson(baselineBucket, snapshotKey(snapshot))

  if (!manifest) {
    throw new Error(`snapshot ${snapshot} does not exist`)
  }

  return bindManifestToChannel(snapshot, manifest)
}

const currentManifest = async () => {
  const snapshot = await currentChannelSnapshot()

  return manifestAtSnapshot(snapshot)
}

// --- pull --------------------------------------------------------------------
// Into a staging directory, verifying every blob against the digest the manifest
// names, and only then swapping. A half-finished download must never be able to
// leave a partial set of "canonical" images behind for the next run to compare to.
const writePulledBase = async (snapshot) => {
  const path = join(root, PULLED_BASE_FILE)
  const staging = `${path}.staging`
  const evidence = assertPulledBaseEvidence(pulledBaseEvidence(snapshot))

  await writeFile(staging, `${JSON.stringify(evidence, null, 2)}\n`)
  await rename(staging, path)
}

const pull = async () => {
  await Promise.all([
    rm(join(root, PULLED_BASE_FILE), { force: true }),
    rm(join(root, `${PULLED_BASE_FILE}.staging`), { force: true }),
  ])
  const manifest = await currentManifest()

  if (!manifest) {
    say('visual-baseline: no channel yet — nothing to compare against (first run)')
    // `pull` materializes the remote channel locally. If the remote has no channel,
    // stale files from an earlier local pull must not become an undeclared baseline:
    // the ordinary run should render every cell as new and publish one reviewable
    // candidate through the same flow used for later additions.
    await rm(SNAPSHOT_DIR, { recursive: true, force: true })
    await writePulledBase(null)

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
  await writePulledBase(manifest.snapshot)

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

const readVisualHandoff = async (path = HANDOFF_FILE) => {
  const raw = await readFile(join(root, path), 'utf8').catch(() => null)

  if (!raw) {
    throw new Error(`no visual handoff at ${path}`)
  }

  return assertVisualHandoff(JSON.parse(raw))
}

const readPulledBase = async () => {
  const raw = await readFile(join(root, PULLED_BASE_FILE), 'utf8').catch(() => null)

  if (!raw) {
    throw new Error('no successful visual pull evidence')
  }

  return assertPulledBaseEvidence(JSON.parse(raw))
}

const publish = async ({ candidate, commit, pipeline, job, report = REPORT_FILE }) => {
  let producer

  try {
    producer = assertProducerIdentity({ candidate, commit, pipeline, job })
  } catch (error) {
    die(error.message)
  }

  const outcome = reportOutcome(await readReport(report))
  const failures = visualFailureCount(outcome)

  sayOutcome(outcome)

  // Broken/report-integrity failures never produce a candidate. Flakes need the exact
  // pulled baseline before they can be classified as safe carry-forward cells.
  if (blocksCandidate(outcome)) {
    say('visual-baseline: non-pixel failures — no candidate published')
    await writeVisualOutcome(null, 0, failures, outcome.flaky.length, null, outcome.flaky)

    return
  }

  // The rendered pixels belong to the channel pulled before Playwright started. Never
  // silently rebase them onto a channel that moved during the run: compare first, then
  // fetch exactly the pulled manifest, before reading a PNG or writing remote state.
  let pulled
  let baseline

  try {
    pulled = await readPulledBase()
    assertChannelMatchesPulledBase(pulled, await currentChannelSnapshot())
    baseline = await manifestAtSnapshot(pulled.snapshot)
  } catch (error) {
    say(`visual-baseline: ${error.message} — no candidate published`)
    await writeVisualOutcome(null, 0, failures + 1, outcome.flaky.length, null, outcome.flaky)

    return
  }
  const baselineCells = baseline?.cells ?? {}
  const initial = pulled.snapshot === null

  try {
    assertSuffix(Object.keys(baselineCells), VISUAL_SNAPSHOT_SUFFIX)
  } catch (error) {
    die(error.message)
  }

  if (initial) {
    try {
      assertInitialCandidate(outcome)
    } catch (error) {
      say(`visual-baseline: ${error.message} — no candidate published`)
      await writeVisualOutcome(
        null,
        0,
        Math.max(1, failures),
        outcome.flaky.length,
        null,
        outcome.flaky,
      )

      return
    }
  }

  let carriedFlakyCells

  try {
    carriedFlakyCells = bindCarriedFlakyCells(outcome.flaky, baselineCells)
  } catch (error) {
    say(`visual-baseline: ${error.message} — no candidate published`)
    await writeVisualOutcome(null, 0, failures + 1, outcome.flaky.length, null, outcome.flaky)

    return
  }

  if (outcome.flaky.length && !outcome.cells.length) {
    say('visual-baseline: flakes only — no stable pixel changes to publish')
    await writeVisualOutcome(null, 0, failures, outcome.flaky.length, null, carriedFlakyCells)

    return
  }

  let reported

  try {
    reported = normalizeReportedCells(outcome.cells)
  } catch (error) {
    say(`visual-baseline: ${error.message} — no candidate published`)
    await writeVisualOutcome(null, 0, failures + 1, outcome.flaky.length, null, carriedFlakyCells)

    return
  }

  if (await headObject(config, baselineBucket, candidateKey(producer.candidate))) {
    die(`candidate "${producer.candidate}" already exists; producer identities are immutable`)
  }

  const uploads = new Map()
  const rendered = []
  const diffFor = new Map()

  for (const { cell, actual, diff } of reported) {
    const bytes = await readFile(actual)
    const digest = sha256hex(bytes)

    rendered.push([cell, digest])
    diffFor.set(cell, diff)
    uploads.set(digest, bytes)
  }
  const merged = mergeCells(baselineCells, rendered)
  const cells = merged.cells
  const changed = merged.changed.map((entry) => ({ ...entry, diff: diffFor.get(entry.cell) }))

  if (!changed.length) {
    say('visual-baseline: no reviewable screenshot changes — no candidate published')
    await writeVisualOutcome(null, 0, failures, outcome.flaky.length, null, carriedFlakyCells)

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
    // Schema 2 hashes the complete manifest identity. Schema 1 snapshots remain valid
    // read-only bases, but their digest covered only the cell map.
    schema: 2,
    cells,
    identity: {
      commit: producer.commit,
      pipeline: producer.pipeline,
      job: producer.job,
      baseSnapshot: pulled.snapshot,
      carriedFlakyCells,
      image: process.env.PLAYWRIGHT_TEST_IMAGE ?? null,
    },
  }
  const digest = manifestDigest(manifest)

  await writeJson(baselineBucket, snapshotKey(digest), { ...manifest, snapshot: digest })
  const review = await publishReview({
    candidate: producer.candidate,
    changed,
    cells,
    pipeline: producer.pipeline,
    job: producer.job,
    commit: producer.commit,
    carriedFlakyCells,
  })
  const pointer = candidatePointer({
    ...producer,
    snapshot: digest,
    baseSnapshot: pulled.snapshot,
    review,
    carriedFlakyCells,
  })

  // The review must exist before an accept address does. If any review upload fails,
  // the immutable snapshot may be orphaned, but there is no pointer anyone can accept.
  await writeJson(baselineBucket, candidateKey(producer.candidate), pointer)

  const total = Object.keys(cells).length

  say(`visual-baseline: candidate ${producer.candidate} → snapshot ${digest}`)
  say(
    initial
      ? `visual-baseline: ${total} cells, all of them new`
      : `visual-baseline: ${changed.length} of ${total} cells changed`,
  )
  await writeVisualOutcome(
    review,
    changed.length,
    failures,
    outcome.flaky.length,
    pointer,
    carriedFlakyCells,
  )
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
// review only to whoever still remembers that number. The fixed handoff carries this
// same job-unique slug, so the folder and privileged accept address cannot drift.
const publishReview = async ({
  candidate,
  changed,
  cells,
  pipeline,
  job,
  commit,
  carriedFlakyCells,
}) => {
  if (!changed.length) {
    return null
  }
  const day = new Date().toISOString().slice(0, 10)
  const prefix = `reviews/${day}-${candidate}`
  const rows = []

  for (const { cell, digest, diff, added } of changed) {
    let diffUrl = null

    if (diff) {
      const key = `${prefix}/diff/${cell}`

      await putObject(config, reviewBucket, key, await readFile(diff), 'image/png')
      diffUrl = presignGet(config, reviewBucket, key)
    }
    rows.push({
      cell,
      added,
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
    job,
    carriedFlakyCells,
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

const reviewLead = (rows, total, carriedFlakyCells) => {
  const added = rows.filter((row) => row.added).length
  const changed = rows.length - added

  const counts =
    added === rows.length
      ? `${added} new cells.`
      : added
        ? `${changed} changed and ${added} new cells (${rows.length} of ${total}).`
        : `${changed} of ${total} cells changed.`
  const drift =
    changed > total / 2
      ? ' Most of the matrix moved at once — that is usually render drift, not a design change.'
      : ''
  const flaky = carriedFlakyCells.length
    ? ` ${carriedFlakyCells.length} flaky cell(s) were excluded; their exact accepted digests are carried from the base. Accepting the stable diffs does not make this run green.`
    : ''

  return `${counts}${drift}${flaky}`
}

export const renderReview = ({
  candidate,
  rows,
  total,
  commit,
  pipeline,
  job,
  carriedFlakyCells,
  day,
}) => `<!doctype html>
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
<p class="lead">${reviewLead(rows, total, carriedFlakyCells)}</p>
${
  carriedFlakyCells.length
    ? `<p>carried flaky cells: ${carriedFlakyCells.map(({ cell }) => escapeHtml(cell)).join(', ')}</p>`
    : ''
}
<!-- Written into the page, not only into the key: whoever opens this file has
     downloaded it out of a bucket and no longer has the folder name in front of them. -->
<dl>
  <dt>candidate</dt><dd>${escapeHtml(candidate)}</dd>
  <dt>commit</dt><dd>${escapeHtml(commit ?? '—')}</dd>
  <dt>pipeline</dt><dd>${escapeHtml(pipeline ?? '—')}</dd>
  <dt>producer job</dt><dd>${escapeHtml(job ?? '—')}</dd>
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
const accept = async ({ handoff = HANDOFF_FILE }) => {
  let evidence

  try {
    evidence = await readVisualHandoff(handoff)
  } catch (error) {
    die(error.message)
  }
  const expected = evidence.accept

  if (!expected) {
    die('visual handoff contains no acceptable candidate')
  }
  const pointer = await readJson(baselineBucket, candidateKey(expected.candidate))

  if (!pointer) {
    die(`no candidate "${expected.candidate}"`)
  }
  try {
    assertCandidatePointer(pointer, expected)
  } catch (error) {
    die(error.message)
  }
  const manifest = await readJson(baselineBucket, snapshotKey(expected.snapshot))

  if (!manifest) {
    die(`candidate points at snapshot ${expected.snapshot}, which does not exist`)
  }
  if (manifest.schema !== 2) {
    die(`candidate snapshot schema mismatch: expected 2, got ${manifest.schema ?? '—'}`)
  }
  const { snapshot: manifestSnapshot, ...manifestBody } = manifest

  if (
    manifestSnapshot !== expected.snapshot ||
    manifestDigest(manifestBody) !== expected.snapshot
  ) {
    die(`snapshot ${expected.snapshot} does not match its immutable content address`)
  }
  for (const field of ['commit', 'pipeline', 'job', 'baseSnapshot']) {
    if (manifest.identity?.[field] !== expected[field]) {
      die(
        `snapshot ${field} mismatch: expected ${expected[field]}, got ${manifest.identity?.[field] ?? '—'}`,
      )
    }
  }
  if (
    JSON.stringify(manifest.identity?.carriedFlakyCells) !==
    JSON.stringify(expected.carriedFlakyCells)
  ) {
    die('snapshot carriedFlakyCells mismatch')
  }
  const channel = await readJson(baselineBucket, CHANNEL)
  const currentSnapshot = channel?.snapshot ?? null

  if (currentSnapshot !== expected.baseSnapshot) {
    die(
      `candidate is stale: based on ${expected.baseSnapshot ?? 'no channel'}, current channel is ${currentSnapshot ?? 'absent'}`,
    )
  }
  try {
    const baseManifest = await manifestAtSnapshot(expected.baseSnapshot)

    assertCarriedFlakyDigests(expected.carriedFlakyCells, manifest.cells, baseManifest?.cells ?? {})
  } catch (error) {
    die(error.message)
  }
  await writeJson(baselineBucket, CHANNEL, {
    snapshot: expected.snapshot,
    commit: expected.commit,
    acceptedFrom: expected.candidate,
    acceptedPipeline: expected.pipeline,
    acceptedJob: expected.job,
  })
  say(`visual-baseline: channel now at snapshot ${expected.snapshot}`)
}

// The verify job reads the fixed artifact, not dotenv variables: GitLab lets manual,
// project and pipeline variables override dotenv, so environment counts are useful UI
// metadata but cannot be the authority for a red/green decision.
export const gate = async ({ handoff = HANDOFF_FILE, ifPresent = false }) => {
  let evidence

  try {
    evidence = await readVisualHandoff(handoff)
  } catch (error) {
    if (ifPresent && error.message === `no visual handoff at ${handoff}`) {
      say('visual: producer handoff absent — no visual verdict')
      return
    }
    die(error.message)
  }
  const summary = visualGateSummary(evidence)

  for (const line of summary.lines) {
    say(line)
  }
  if (summary.red) {
    process.exitCode = 1
  }
}

// --- verdict -----------------------------------------------------------------
// The comparison's answer WITHOUT publishing it. The writer credential is protected,
// so on an ordinary branch there is nothing to publish a candidate with — but the
// comparison still ran and still has a verdict, and a lane that could not report it
// would be a gate that quietly stops gating exactly where most work happens.
const verdict = async ({ report = REPORT_FILE }) => {
  const outcome = reportOutcome(await readReport(report))
  const failures = visualFailureCount(outcome)

  sayOutcome(outcome)
  try {
    const pulled = await readPulledBase()

    assertChannelMatchesPulledBase(pulled, await currentChannelSnapshot())
  } catch (error) {
    say(`visual-baseline: ${error.message} — comparison is stale`)
    await writeVisualOutcome(null, 0, failures + 1, outcome.flaky.length, null, outcome.flaky)

    return
  }
  say(`visual-baseline: ${outcome.cells.length} cell(s) differ from the pulled baseline`)
  await writeVisualOutcome(
    null,
    outcome.cells.length,
    failures,
    outcome.flaky.length,
    null,
    outcome.flaky,
  )
}

// --- entry -------------------------------------------------------------------
// Only when RUN, not when imported: the argument parser is a pure function worth a
// unit test, and importing it must not start moving baselines around.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [command, ...rest] = process.argv.slice(2)
  const options = flags(rest)
  const remote = command !== 'gate'

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
      // Every publish is reviewable, including the first one against an empty channel.
      ...(command === 'publish' ? [['VISUAL_S3_REVIEW_BUCKET', reviewBucket]] : []),
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
  } else if (command === 'gate') {
    await gate({ ...options, ifPresent: options['if-present'] === true })
  } else if (command === 'pull') {
    await pull()
  } else if (command === 'publish') {
    await publish(options)
  } else if (command === 'accept') {
    await accept(options)
  } else {
    die(`unknown command "${command ?? ''}" — expected pull, publish, accept, verdict or gate`)
  }
}
