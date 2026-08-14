// [#302] The Markdown-tree import at its SUPPORTED scale: 10 000 small `.md`
// files with nested folders, authored metadata and internal exact links, driven
// through the production composition — a real `createServer` (CachedStore over
// NotariumStore on localfs + sqlite, embed off), the real HTTP route, the real
// durable job — into a disposable data root.
//
// It is a checked-in artifact rather than a one-off command because the numbers
// it prints are the ones the task is accountable for, and because its
// CORRECTNESS half is a test: exact totals, a bounded result, monotonic progress,
// a reader served inside the import window without falling silent for a third of
// it, and a cancel that lands strictly part-way through a corpus are asserted, and
// a failure exits non-zero. The timings are diagnostics — they are recorded, never
// asserted, since a threshold pinned to one machine is a flaky test wearing a
// benchmark's clothes. The two assertions that DO read a clock are deliberately
// scale-free: both are shares of the run's own measured window, not durations.
//
// The corollary, stated so nobody reads more into the green than is there: a
// bound that wide does not discriminate the yielding that makes the server
// responsive. It catches a server that stopped answering, not one that answers
// slowly. Cooperativeness is watched through `eventLoopMaxMs`,
// `parallelReadP99Ms` and `parallelReadMaxGapMs` below — printed every run and
// compared by eye against the recorded ones, which is a judgement rather than
// a gate on purpose (docs/import.md#resource-limits-on-a-markdown-tree-302).
//
//   npm run bench:import-markdown-tree            # defaults: 10 000 notes
//   NOTES=2000 npm run bench:import-markdown-tree # a quicker shape
//   make import-bench                             # the same, in a container
// canon: docs/import.md#importing-a-markdown-tree-302

import AdmZip from 'adm-zip'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

import { createServer } from '../packages/server/src/apps/server/server'

const NOTES = Number(process.env.NOTES || 10_000)
const IGNORED = Number(process.env.IGNORED || 20)
/** How often the parallel reader hits the server while the import runs. */
const PROBE_EVERY_MS = Number(process.env.PROBE_EVERY_MS || 100)
/** Below this the second import is over before a cancel can reach the worker, and
 *  a check that races the thing it measures is worse than an honest skip. Both the
 *  default 10 000-note corpus and the trimmed shape documented above (`NOTES=2000`)
 *  are far above it. */
const MIN_CANCELLABLE_NOTES = 25
/** The import window divided by this is how long a single unanswered stretch may
 *  last — a third of the run. A DIVISOR of the window, not a duration: nothing here
 *  is pinned to one machine's speed, since a faster host shrinks the window and the
 *  allowance with it. It is a wide bound deliberately, and what it can and cannot
 *  catch is stated in docs/import.md#resource-limits-on-a-markdown-tree-302. */
const UNANSWERED_WINDOW_DIVISOR = 3
/** …with one absolute floor, because on a corpus small enough that the whole
 *  import is a few probe periods long the ratio would be measuring the probe
 *  cadence rather than the server. A floor can only ever RELAX the check, so it
 *  cannot make it flaky; on the supported 10 000-note corpus the ratio dominates
 *  it by three orders of magnitude. */
const MIN_UNANSWERED_ALLOWANCE_MS = PROBE_EVERY_MS * 8
const SPACE = 'bench'

const percentile = (values: readonly number[], p: number): number => {
  if (!values.length) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)

  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
}

/** A deterministic corpus: nested folders, authored frontmatter, source
 *  identities and exact links that form a cycle — so the identity map, the link
 *  rewrite and the date fallback are all exercised at scale, not just the
 *  parser. A bounded non-Markdown tail proves the ignored path too. */
const buildCorpus = async (path: string, notes: number): Promise<void> => {
  const zip = new AdmZip()

  for (let i = 0; i < notes; i++) {
    // >=3 levels of nesting, several branches — a flat archive would not
    // exercise the directory reproduction the feature exists for.
    const dir = `vault/${i % 11}/${i % 7}/${i % 3}`
    const next = (i + 1) % notes
    const body = [
      '---',
      `notarium-id: source-${i}`,
      `title: Note ${i}`,
      'tags: [bench, imported]',
      'type: note',
      ...(i % 4 === 0 ? [`created: 20${10 + (i % 10)}-0${1 + (i % 9)}-14T09:00:00Z`] : []),
      `plugin-field: kept-${i}`,
      '---',
      '',
      `# Note ${i}`,
      '',
      `Forward to [[notarium-id:source-${next}|Next]] and back to [[notarium-id:source-${(i + notes - 1) % notes}]].`,
      '',
      'A copy that must NOT be rewritten:',
      '',
      '```md',
      `[[notarium-id:source-${next}]]`,
      '```',
      '',
      `Ordinary links stay put: [[Note ${next}]] and [x](other.md).`,
    ].join('\n')

    zip.addFile(`${dir}/note-${i}.md`, Buffer.from(body, 'utf8'))
  }
  for (let i = 0; i < IGNORED; i++) {
    zip.addFile(
      `vault/assets/img-${i}.png`,
      Buffer.concat([Buffer.from('\x89PNG\r\n'), Buffer.alloc(512)]),
    )
  }
  await writeFile(path, zip.toBuffer())
}

type Job = {
  id: string
  status: string
  error: string | null
  progress: { done: number; total: number | null; phase: string | null }
  result: {
    imported: number
    skipped: number
    failed: number
    files: unknown[]
    filesOmitted?: number
    errors: unknown[]
    ignored?: { count: number; files: string[]; filesOmitted?: number }
    created: string[]
  } | null
}

const fail = (message: string): never => {
  console.error(`✗ ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled'])

const check = (ok: boolean, message: string): void => {
  if (!ok) {
    fail(message)
  }
}

const run = async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-import-bench-'))
  const zipPath = join(root, 'corpus.zip')

  console.log(`bench: building a ${NOTES}-note corpus…`)
  await buildCorpus(zipPath, NOTES)
  // The space's own directory, as a provisioned host would already have it.
  await mkdir(join(root, 'spaces', SPACE), { recursive: true })

  // The production composition, with nothing faked below the HTTP edge: a real
  // meta-DB, a real engine on localfs + sqlite, the real job runner. No embedder
  // is wired, which is the documented embed-off shape the import contour is
  // measured in (docs/import.md#cooperative-responsiveness-on-large-imports-192).
  const app = await createServer({
    spaces: [
      {
        slug: SPACE,
        displayName: 'Bench',
        engine: 'notarium',
        notesDir: join(root, 'spaces', SPACE),
      },
    ],
    authMode: 'none',
    metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
    engineDataDir: join(root, 'engine'),
    jobsDataDir: join(root, 'jobs'),
    importStagingDir: join(root, 'jobs', 'imports'),
    spacesRoot: join(root, 'spaces'),
    pollIntervalMs: 0,
  })
  const loop = monitorEventLoopDelay({ resolution: 10 })
  let probing = true

  // A failed check THROWS, and a bench that left its server listening would then
  // hang forever with an exit code it never reaches — the one failure mode a gate
  // must not have (a containerised run just sits there). Every path out of the
  // measurement, green or red, goes through the teardown in `finally`.
  try {
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''

    check(Boolean(base), 'the bench server did not report a listening port')

    let rssPeak = process.memoryUsage().rss
    const rssBefore = rssPeak
    const rssTimer = setInterval(() => {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
    }, 100)

    rssTimer.unref()

    // A real reader hitting the same server while the import runs: the point of
    // bulk mode is that an interactive request is still served, and the only
    // honest way to know is to make one. Each probe records WHEN it was answered,
    // not just how long it took — the reader starts before the upload and outlives
    // the job, so a read that completed outside the import window proves nothing
    // about the import.
    const probes: Array<{ at: number; ms: number }> = []

    const probe = async (): Promise<void> => {
      while (probing) {
        const at = performance.now()

        // A refused or dropped request is ONE unanswered probe, not the end of
        // the reader: catching outside the loop would let a single connection
        // reset stop every later read, and the gap check below would then
        // report a server that never stopped answering as one that fell silent
        // for the rest of the run. The stretch this leaves unanswered is
        // measured like any other, which is the honest reading of it.
        try {
          await fetch(`${base}/api/s/${SPACE}/notes?limit=20`).then((r) => r.arrayBuffer())
          const answered = performance.now()

          probes.push({ at: answered, ms: answered - at })
        } catch {
          /* counted as silence, not as the reader's death */
        }
        await new Promise((resolve) => setTimeout(resolve, PROBE_EVERY_MS))
      }
    }

    /** How many notes the import landed under a root, asked of the server rather
     *  than counted out of a full listing — `total` is the folder subtree's exact
     *  size, and one row of payload is enough to learn it. */
    const writtenUnder = async (folder: string): Promise<number> =>
      (
        (await (await fetch(`${base}/api/s/${SPACE}/notes?folder=${folder}&limit=1`)).json()) as {
          total: number
        }
      ).total

    const started = performance.now()

    loop.enable()
    // A refused probe after teardown is noise, not a finding — what the reader was
    // served WHILE THE JOB LIVED is asserted below, from the window of `probes`.
    const probing$ = probe().catch(() => {})
    const form = new FormData()

    form.append('root', 'imported')
    form.append('file', new Blob([await readFile(zipPath)]), 'corpus.zip')
    const enqueued = (await (
      await fetch(`${base}/api/s/${SPACE}/import`, { method: 'POST', body: form })
    ).json()) as Job

    check(Boolean(enqueued.id), `the import was not enqueued: ${JSON.stringify(enqueued)}`)
    // The window the "stays answerable" claim is about: from the moment the job
    // exists to the moment it is terminal. Anything the reader completed before
    // the POST returned was answered by an idle server.
    const enqueuedAt = performance.now()
    let job = enqueued
    let lastDone = -1
    let monotonic = true
    let sawTotal = false

    while (!TERMINAL.has(job.status)) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      job = (await (await fetch(`${base}/api/s/${SPACE}/jobs/${job.id}`)).json()) as Job
      monotonic &&= job.progress.done >= lastDone
      lastDone = job.progress.done
      sawTotal ||= job.progress.total === NOTES
    }
    const terminalAt = performance.now()
    const elapsedMs = terminalAt - started

    loop.disable()
    probing = false
    await probing$

    // The reads that were actually answered WHILE the import held the server, and
    // the longest stretch inside that window with no answer at all — measured from
    // the enqueue to the first one and from the last one to the terminal status, so
    // a reader that fell silent at either end is not hidden by the ones that spoke.
    const importWindowMs = terminalAt - enqueuedAt
    const during = probes.filter((p) => p.at >= enqueuedAt && p.at <= terminalAt)
    const answerGaps = during.reduce(
      ({ previous, worst }, p) => ({ previous: p.at, worst: Math.max(worst, p.at - previous) }),
      { previous: enqueuedAt, worst: 0 },
    )
    const maxUnansweredMs = Math.max(
      answerGaps.worst,
      terminalAt - (during.at(-1)?.at ?? enqueuedAt),
    )
    const answerAllowanceMs = Math.max(
      importWindowMs / UNANSWERED_WINDOW_DIVISOR,
      MIN_UNANSWERED_ALLOWANCE_MS,
    )
    const duringMs = during.map((p) => p.ms)
    const result = job.result

    // ── correctness (a failure here exits non-zero) ────────────────────────────
    check(job.status === 'succeeded', `import ended ${job.status}: ${job.error ?? ''}`)
    check(Boolean(result), 'a succeeded import carried no result')
    check(result!.imported === NOTES, `imported ${result!.imported}, expected ${NOTES}`)
    check(result!.failed === 0, `${result!.failed} notes failed`)
    check(result!.skipped === 0, `${result!.skipped} notes were skipped`)
    check(
      result!.ignored?.count === IGNORED,
      `ignored ${result!.ignored?.count}, expected ${IGNORED}`,
    )
    check(result!.files.length <= 200, `files carried ${result!.files.length} rows`)
    check(result!.errors.length <= 200, `errors carried ${result!.errors.length} rows`)
    check((result!.ignored?.files.length ?? 0) <= 200, 'ignored samples exceeded the cap')
    check(result!.created.length <= 200, `created carried ${result!.created.length} ids`)
    // Absent, not zero, when nothing was dropped: the counter is an additive optional
    // field, so a corpus that fits under the cap (a small NOTES=) carries no number at
    // all. Reading it as 0 is the contract — asserting a literal 0 would be reading the
    // field's presence instead of its meaning.
    check(
      (result!.filesOmitted ?? 0) === NOTES - result!.files.length,
      `filesOmitted ${result!.filesOmitted ?? 0} does not match ${NOTES - result!.files.length}`,
    )
    check(sawTotal, 'progress never reported the planned total (the bar stayed indeterminate)')
    check(monotonic, 'progress went backwards')
    check(job.progress.done === NOTES, `final progress ${job.progress.done}, expected ${NOTES}`)
    // What these two prove, exactly: reads were answered INSIDE the import window,
    // and no stretch of it passed with none. Counting probes alone would pass on a
    // reader served once before the upload and then blocked for the whole run,
    // which is why the gap is measured at all. What they do NOT prove is
    // responsiveness: a third of the window is a wide bound, and a run that got
    // slower without ever going quiet stays green here — that regression is read
    // off the diagnostics printed below, not caught by this check.
    check(during.length > 0, 'no parallel read completed between the enqueue and the terminal job')
    check(
      maxUnansweredMs <= answerAllowanceMs,
      `the server answered no read for ${Math.round(maxUnansweredMs)}ms of a ` +
        `${Math.round(importWindowMs)}ms import (allowed ${Math.round(answerAllowanceMs)}ms)`,
    )

    // The corpus is a link cycle, so every note must resolve BOTH ways — the proof
    // that the copy's links point at the copies and not back at the source corpus.
    const listed = (await (await fetch(`${base}/api/s/${SPACE}/notes?limit=${NOTES}`)).json()) as {
      notes: Array<{ id: string; filePath: string }>
    }

    check(listed.notes.length === NOTES, `the space holds ${listed.notes.length} notes`)
    const expectedPaths = new Set(
      Array.from(
        { length: NOTES },
        (_unused, i) => `imported/vault/${i % 11}/${i % 7}/${i % 3}/note-${i}.md`,
      ),
    )

    check(
      listed.notes.every((n) => expectedPaths.has(n.filePath)),
      'a note landed at a path the archive did not name',
    )
    check(
      new Set(listed.notes.map((n) => n.filePath)).size === expectedPaths.size,
      'the reproduced tree has missing or duplicate paths',
    )
    const ids = new Set(listed.notes.map((n) => n.id))

    check(
      ![...ids].some((id) => id.startsWith('source-')),
      'a source identity was materialised — the import is a copy, not a restore',
    )
    const sample = listed.notes[0]
    const detail = (await (await fetch(`${base}/api/s/${SPACE}/note?ref=${sample.id}`)).json()) as {
      content: string
    }
    // Which member this is decides what its links must say, so the assertions
    // below are exact rather than "at least one of them worked": every note
    // carries TWO live exact links and ONE fenced copy, and a rewrite that got
    // one of the three wrong is precisely the class of bug this proves absent.
    const index = Number(/note-(\d+)\.md$/.exec(sample.filePath)?.[1] ?? NaN)

    check(Number.isInteger(index), `could not read a member index out of ${sample.filePath}`)
    const fenced = `source-${(index + 1) % NOTES}`
    const rewritten = [...detail.content.matchAll(/\[\[notarium-id:([^\]|]+)/g)].map((m) => m[1])
    const repointed = rewritten.filter((id) => ids.has(id))

    check(
      repointed.length === 2,
      `${repointed.length} of the sampled note's two exact links resolved to an imported id ` +
        `(${JSON.stringify(rewritten)})`,
    )
    // The fenced copy is the one address in the note that must survive
    // byte-for-byte, and it is the ONLY source id allowed to remain: asserting
    // the fence marker alone passed on a note whose fenced address had been
    // repointed, which is the failure the fixture exists to catch.
    check(
      rewritten.filter((id) => id.startsWith('source-')).join() === fenced,
      `the sampled note's surviving source ids are ${JSON.stringify(
        rewritten.filter((id) => id.startsWith('source-')),
      )}, expected only the fenced ${fenced}`,
    )
    check(
      detail.content.includes(`\`\`\`md\n[[notarium-id:${fenced}]]\n\`\`\``),
      'the fenced copy is no longer the authored bytes',
    )

    const measurements = {
      notes: NOTES,
      elapsedMs: Math.round(elapsedMs),
      notesPerSecond: Math.round((NOTES / elapsedMs) * 1000),
      rssPeakMb: Math.round(rssPeak / 1e6),
      rssDeltaMb: Math.round((rssPeak - rssBefore) / 1e6),
      eventLoopMaxMs: Math.round(loop.max / 1e6),
      eventLoopP99Ms: Math.round(loop.percentile(99) / 1e6),
      parallelReads: during.length,
      parallelReadMedianMs: Math.round(percentile(duringMs, 0.5)),
      parallelReadP99Ms: Math.round(percentile(duringMs, 0.99)),
      parallelReadMaxMs: Math.round(Math.max(...duringMs)),
      parallelReadMaxGapMs: Math.round(maxUnansweredMs),
      resultJsonBytes: Buffer.byteLength(JSON.stringify(result)),
    }

    console.log('✓ correctness: totals, tree, copy identity, links, bounds and progress')
    console.log(JSON.stringify(measurements, null, 2))

    // ── cancelling a live import ──────────────────────────────────────────────
    // Proven here rather than only in a unit test because what a user cancels is
    // a DURABLE JOB: the abort has to travel the whole way from the REST call
    // through the runner to the member stream the worker is reading right now.
    // A second archive into its own root, cancelled once writes have started —
    // so the abort lands mid-member, not between jobs.
    if (NOTES >= MIN_CANCELLABLE_NOTES) {
      const cancelForm = new FormData()

      cancelForm.append('root', 'canceled')
      cancelForm.append('file', new Blob([await readFile(zipPath)]), 'corpus.zip')
      let victim = (await (
        await fetch(`${base}/api/s/${SPACE}/import`, { method: 'POST', body: cancelForm })
      ).json()) as Job

      // Wait for a NOTE ON DISK, not for the phase. `writing` is published with the
      // plan, before the first member is written, so cancelling on it lands on the
      // boundary the doc says this check exists to rule out — measured, that gave
      // "0 of 60 written" and a green check. `done` is no better: it is reported
      // every 200 members, so a smaller corpus leaves it 0 until the very end.
      let before = 0

      while (before === 0 && !TERMINAL.has(victim.status)) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        victim = (await (await fetch(`${base}/api/s/${SPACE}/jobs/${victim.id}`)).json()) as Job
        before = await writtenUnder('canceled')
      }
      check(before > 0, 'the cancellation precondition never observed a written note')
      check(
        victim.status === 'running',
        `the import to cancel ended ${victim.status} before it wrote a note`,
      )

      await fetch(`${base}/api/s/${SPACE}/jobs/${victim.id}/cancel`, { method: 'POST' })
      while (!TERMINAL.has(victim.status)) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        victim = (await (await fetch(`${base}/api/s/${SPACE}/jobs/${victim.id}`)).json()) as Job
      }
      check(victim.status === 'canceled', `a cancelled import ended ${victim.status}`)

      // What the user actually asked for: the writing STOPPED, and it stopped IN
      // THE MIDDLE. The positive lower bound was proved before cancel; here the
      // final count must not go backwards and must stay below the whole corpus.
      // Counted from the notes the server serves, not from the job's bookkeeping.
      const written = await writtenUnder('canceled')

      check(
        written >= before,
        `the cancelled import lost notes (${before} before, ${written} after)`,
      )
      check(written < NOTES, `the cancelled import still wrote all ${NOTES} notes`)
      console.log(`✓ cancellation: ${written} of ${NOTES} written, ended ${victim.status}`)
    } else {
      console.log(`⇢ cancellation not exercised: NOTES=${NOTES} finishes too fast to interrupt`)
    }
  } finally {
    loop.disable()
    probing = false
    await app.close()
    await rm(root, { recursive: true, force: true })
    // A stray keep-alive socket must not hold a finished bench open.
    createHttpServer().close()
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = process.exitCode || 1
})
