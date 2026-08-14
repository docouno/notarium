// @vitest-environment jsdom

// What the Import tab actually PAINTS (#302) — the layer `useImportJob.test.ts`
// cannot reach: that hook proves the normalizer, this proves the rows reach (or
// never reach) the DOM. Mounted with react-dom/client + act, the way this repo
// tests React (see useNotesState.interleaving.test.ts) — no testing library.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportSummary, Job } from '@notarium/contract'

import type * as ApiModule from '../../services/api'

// Each mock is typed as the method it stands in for. A bare `vi.fn()` accepts
// anything, and "anything" is what it was fed: `mode: 'streaming'` with a spare
// field on it type-checked and passed all fifteen tests, so the shape the tab is
// proven against was not the shape the client returns.
const harness = vi.hoisted(() => ({
  api: {
    importStart: vi.fn<typeof ApiModule.api.importStart>(),
    jobCancel: vi.fn<typeof ApiModule.api.jobCancel>(),
    jobGet: vi.fn<typeof ApiModule.api.jobGet>(),
    jobsList: vi.fn<typeof ApiModule.api.jobsList>(),
    spaceEventsUrl: vi.fn<typeof ApiModule.api.spaceEventsUrl>(() => '/api/s/main/events'),
  },
  canWrite: true,
}))

vi.mock('../../composers/SpaceProvider', () => ({
  useSpace: () => ({ space: 'main', canWrite: harness.canWrite }),
}))
// Only `api` is swapped: ApiError and JOB_POLL_MS stay the real ones, so the
// partial-carrying failure below is the exact class the client throws.
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  api: harness.api,
}))

import { ApiError, type ImportProgressLine, JOB_POLL_MS } from '../../services/api'
import { ImportTab } from './ImportTab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const job = (over: Partial<Job> = {}): Job => ({
  id: 'job-1',
  kind: 'import',
  status: 'succeeded',
  progress: { done: 0, total: null, ratio: null, phase: null },
  artifact: null,
  result: null,
  error: null,
  createdAt: '2026-08-13T10:00:00.000Z',
  updatedAt: '2026-08-13T10:00:01.000Z',
  completedAt: '2026-08-13T10:00:01.000Z',
  ...over,
})

/** A result persisted by a build that predated the 200-row cap. */
const oversizedResult = {
  imported: 250,
  skipped: 0,
  failed: 250,
  files: Array.from({ length: 250 }, (_, i) => ({
    file: `f${i}.md`,
    format: 'markdown',
    imported: 1,
    skipped: 0,
    warnings: [],
  })),
  errors: Array.from({ length: 250 }, (_, i) => ({ title: `t${i}`, error: `boom ${i}` })),
  ignored: { count: 250, files: Array.from({ length: 250 }, (_, i) => `img${i}.png`) },
}

describe('ImportTab', () => {
  let container: HTMLDivElement
  let root: Root

  const mount = async () => {
    await act(async () => {
      root.render(createElement(ImportTab))
    })
  }

  const testId = (id: string) => container.querySelector(`[data-testid="${id}"]`)
  const text = () => container.textContent ?? ''
  /** One rendered `file → format (n)` row; leaf divs only, so the wrapping
   *  Notice/summary never counts as one. */
  const fileRows = () =>
    Array.from(container.querySelectorAll('div')).filter(
      (el) => el.children.length === 0 && (el.textContent ?? '').includes('→ markdown ('),
    )
  /** The tone of the summary Notice. It exists only as the variant's CSS-module
   *  class on the wrapper, so the class name is the assertion — the alternative
   *  (`role`) says "status" for both success and warning. */
  const summaryVariant = () => testId('import-summary')?.parentElement?.className ?? ''

  beforeEach(() => {
    harness.canWrite = true
    harness.api.importStart.mockReset()
    harness.api.jobCancel.mockReset()
    harness.api.jobGet.mockReset()
    harness.api.jobsList.mockReset().mockResolvedValue([])
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('renders at most 200 detail rows per collection for a pre-cap result', async () => {
    harness.api.jobsList.mockResolvedValue([job({ result: oversizedResult })])
    await mount()

    expect(fileRows()).toHaveLength(200)
    expect(text()).toContain('f199.md')
    expect(text()).not.toContain('f200.md')
    expect(testId('import-files-omitted')?.textContent).toContain('50')
    expect(text()).toContain('boom 199')
    expect(text()).not.toContain('boom 200')
    expect(testId('import-errors-omitted')?.textContent).toContain('50')

    const ignored = testId('import-ignored')?.textContent ?? ''

    expect(ignored).toContain('img199.png')
    expect(ignored).not.toContain('img200.png')
    expect(ignored).toContain('50 more')
    // The exact totals survive the truncation — that is the whole point of it.
    expect(testId('import-summary')?.textContent).toContain('250')
  })

  it('shows a failed import’s partial result beside its error', async () => {
    harness.api.jobsList.mockResolvedValue([
      job({
        id: 'job-failed',
        status: 'failed',
        error: 'import plan is stale',
        result: { imported: 7, skipped: 0, failed: 1, files: [], errors: [] },
      }),
    ])
    await mount()

    expect(testId('import-error')?.textContent).toContain('import plan is stale')
    expect(testId('import-summary')?.textContent).toContain('7')
    expect(summaryVariant()).toContain('warning')
  })

  it('warns about ignored attachments even when nothing failed', async () => {
    harness.api.jobsList.mockResolvedValue([
      job({
        result: {
          imported: 4,
          skipped: 0,
          failed: 0,
          files: [],
          errors: [],
          ignored: { count: 2, files: ['cover.png', 'notes.pdf'] },
        },
      }),
    ])
    await mount()

    // Every note the archive offered was written, so the run "succeeded" — yet part
    // of the archive stayed behind. A green Notice would read as "all of it arrived".
    expect(summaryVariant()).toContain('warning')
  })

  // `f.warnings.map(...)` ran over an empty array in every fixture this file had,
  // so the whole per-file warning render could be deleted with all tests green —
  // the server half proved the warning was PRODUCED and nothing proved it was SEEN.
  it('prints the warning a file carried and does not call that run a success', async () => {
    harness.api.jobsList.mockResolvedValue([
      job({
        result: {
          imported: 2,
          skipped: 0,
          failed: 0,
          files: [
            { file: 'vault/a.md', format: 'markdown', imported: 1, skipped: 0, warnings: [] },
            {
              file: 'vault/b.md',
              format: 'markdown',
              imported: 1,
              skipped: 0,
              warnings: ['internal links were left pointing at the source: unprovable rewrite'],
            },
          ],
          errors: [],
          repointFailed: 1,
        },
      }),
    ])
    await mount()

    expect(text()).toContain('internal links were left pointing at the source: unprovable rewrite')
    expect(summaryVariant()).toContain('warning')
  })

  // The finding this field exists for: a supported-size archive spends all 200 rows
  // on members that lost nothing, so the refusing member has no row and its warning
  // is never rendered — the count is the only thing left on the screen, and the tone
  // is the only thing that gets the user to look.
  it('reports a repoint refusal that fell past the rows, in a tone that is not green', async () => {
    harness.api.jobsList.mockResolvedValue([
      job({
        result: {
          imported: 10_000,
          skipped: 0,
          failed: 0,
          files: Array.from({ length: 200 }, (_, i) => ({
            file: `f${i}.md`,
            format: 'markdown',
            imported: 1,
            skipped: 0,
            warnings: [],
          })),
          filesOmitted: 9_800,
          errors: [],
          repointFailed: 1,
        },
      }),
    ])
    await mount()

    // Every rendered row is clean, and the run "failed" nothing…
    expect(fileRows()).toHaveLength(200)
    expect(testId('import-summary')?.textContent).toContain('10000')
    // …so without these two the whole screen reads as a flawless 10 000-note import.
    expect(testId('import-repoint-failed')?.textContent).toContain('1 note')
    expect(summaryVariant()).toContain('warning')
  })

  it('calls an import that lost nothing a success', async () => {
    harness.api.jobsList.mockResolvedValue([
      job({
        result: {
          imported: 4,
          skipped: 1,
          failed: 0,
          // A row is present and warning-free: the tone reacts to warnings, not to
          // the mere existence of rows.
          files: [{ file: 'a.md', format: 'markdown', imported: 4, skipped: 1, warnings: [] }],
          errors: [],
        },
      }),
    ])
    await mount()

    expect(summaryVariant()).toContain('success')
    expect(summaryVariant()).not.toContain('warning')
  })

  it('states the two limits nothing else on the screen admits', async () => {
    await mount()

    // A Markdown archive is not a restore: the notes are new and the links between
    // them are rewired to the copies. This sentence is the only place that is said.
    expect(text()).toContain('imported as a COPY')
    // …and "skip existing" is the topping-up switch, not the repair for a half-written
    // tree — turning it ON to retry a failed import is exactly what keeps it broken.
    expect(text()).toContain('It is not a recovery mode')
  })

  it('resumes the newest terminal import rather than an older success', async () => {
    harness.api.jobsList.mockResolvedValue([
      job({
        id: 'job-new',
        status: 'failed',
        error: 'archive is not readable',
        result: { imported: 2, skipped: 0, failed: 0, files: [], errors: [] },
      }),
      job({
        id: 'job-old',
        result: { imported: 99, skipped: 0, failed: 0, files: [], errors: [] },
      }),
    ])
    await mount()

    expect(testId('import-summary')?.textContent).toContain('2')
    expect(text()).not.toContain('99')
    expect(testId('import-error')?.textContent).toContain('archive is not readable')
  })

  it('goes determinate once planning hands over a total, and never calls it imported', async () => {
    vi.useFakeTimers()
    harness.api.jobsList.mockResolvedValue([
      job({
        id: 'job-live',
        status: 'running',
        progress: { done: 0, total: null, ratio: null, phase: 'planning' },
        completedAt: null,
      }),
    ])
    await mount()

    expect(testId('import-progress')?.textContent).toContain('Reading the archive…')
    expect(container.querySelector('[data-indeterminate="true"]')).not.toBeNull()

    harness.api.jobGet.mockResolvedValue(
      job({
        id: 'job-live',
        status: 'running',
        progress: { done: 5, total: 10, ratio: 0.5, phase: 'writing' },
        completedAt: null,
      }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS)
    })

    expect(testId('import-progress')?.textContent).toContain('5 of 10 processed')
    expect(container.querySelector('[data-indeterminate="true"]')).toBeNull()
    expect(
      container.querySelector<HTMLElement>('[data-testid="import-progress"] div div')?.style.width,
    ).toBe('50%')
    // "processed" is not "imported": a run full of failures must not read as a success.
    expect(testId('import-progress')?.textContent).not.toContain('imported')
  })

  it('leaves a foreign export’s bar indeterminate for the whole write', async () => {
    const foreign = job({
      id: 'job-foreign',
      status: 'running',
      // A Claude/ChatGPT export is parsed as it streams, so the member count is never
      // known — `writing` without a total is its steady state, not a planning blip.
      progress: { done: 12, total: null, ratio: null, phase: 'writing' },
      completedAt: null,
    })

    harness.api.jobsList.mockResolvedValue([foreign])
    harness.api.jobGet.mockResolvedValue(foreign)
    await mount()

    expect(container.querySelector('[data-indeterminate="true"]')).not.toBeNull()
    expect(testId('import-progress')?.textContent).toContain('Importing… 12 processed')
  })

  it('keeps the notes a synchronous import wrote before it failed', async () => {
    // The none-mode shape the client really returns: `mode: 'sync'` plus a `run` that
    // drives the hijacked NDJSON stream (client.ts). The line it feeds `onProgress`
    // is the post-#302 one — `imported` alongside phase/done/total.
    harness.api.importStart.mockResolvedValue({
      mode: 'sync',
      run: async (onProgress: (p: ImportProgressLine) => void) => {
        onProgress({ imported: 3, done: 3, total: 10, phase: 'writing' })
        const err = new ApiError('the archive ended early')

        err.status = 500
        err.partial = { imported: 3, skipped: 0, failed: 1, files: [], errors: [] }
        throw err
      },
    })
    await mount()

    const input = testId('import-file') as HTMLInputElement
    const file = new File(['zip'], 'vault.zip', { type: 'application/zip' })

    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      ;(testId('import-run') as HTMLButtonElement).click()
    })

    expect(testId('import-error')?.textContent).toContain('the archive ended early')
    expect(testId('import-summary')?.textContent).toContain('3')
  })

  // A client of this build talking to a server that predates #302: the progress line
  // carries the successful-write counter ALONE. The hook's `p.done ?? p.imported` is
  // what keeps the bar moving then, and every other fixture here sends both numbers
  // equal — so the fallback could be replaced by a literal 0 and nothing noticed,
  // while the real pairing freezes at "Uploading…" for the whole import.
  it('draws progress from a pre-#302 line that carries no `done`', async () => {
    let release: (summary: ImportSummary) => void = () => {}
    const finished = new Promise<ImportSummary>((resolve) => {
      release = resolve
    })

    harness.api.importStart.mockResolvedValue({
      mode: 'sync',
      run: async (onProgress) => {
        onProgress({ imported: 3 })

        return await finished
      },
    })
    await mount()

    const input = testId('import-file') as HTMLInputElement
    const file = new File(['zip'], 'vault.zip', { type: 'application/zip' })

    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      ;(testId('import-run') as HTMLButtonElement).click()
    })

    // The three notes it has written so far, on a line that never said "3 done".
    expect(testId('import-progress')?.textContent).toContain('3 processed')
    await act(async () => {
      release({ imported: 3, skipped: 0, failed: 0, files: [], errors: [] })
      await finished
    })

    expect(testId('import-summary')?.textContent).toContain('3')
  })

  it('offers a reader an honest notice instead of the form', async () => {
    harness.canWrite = false
    await mount()

    expect(text()).toContain('read-only access')
    expect(testId('import-file')).toBeNull()
  })
})
