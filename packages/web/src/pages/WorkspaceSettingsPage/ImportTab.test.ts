// @vitest-environment jsdom

// What the Import tab actually PAINTS (#302) — the API-family tests
// cannot reach: those prove the normalizer, this proves the rows reach (or
// never reach) the DOM. Mounted with react-dom/client + act, the way this repo
// tests React (see useNotesState.interleaving.test.ts) — no testing library.

import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportSummary, Job } from '@notarium/contract'
import { SSE_EVENT } from '@notarium/contract/events'
import { IMPORT_FORMAT } from '@notarium/core'

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

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Array<(event: Event) => void>>()
  readonly close = vi.fn()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (typeof listener === 'function') {
      const listeners = this.listeners.get(type) ?? []

      listeners.push(listener)
      this.listeners.set(type, listeners)
    }
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) })

    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

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
import { useImportJob } from './useImportJob'

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
  let route = ''
  let navigateRoute: ReturnType<typeof useNavigate>

  const RouteProbe = () => {
    const location = useLocation()

    navigateRoute = useNavigate()
    route = `${location.pathname}${location.search}`
    return null
  }

  const mount = async (entry = '/s/main/management/import') => {
    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: [entry] },
          createElement(Fragment, null, createElement(ImportTab), createElement(RouteProbe)),
        ),
      )
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
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
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

  it('renders the job named by the route and never adopts a newer import', async () => {
    harness.api.jobsList.mockResolvedValue([
      job({
        id: 'job-b-newer',
        result: { imported: 99, skipped: 0, failed: 0, files: [], errors: [] },
      }),
    ])
    harness.api.jobGet.mockResolvedValue(
      job({
        id: 'job-a-addressed',
        result: { imported: 3, skipped: 0, failed: 0, files: [], errors: [] },
      }),
    )

    await mount('/s/main/management/import?job=job-a-addressed')

    expect(harness.api.jobGet).toHaveBeenCalledWith('main', 'job-a-addressed')
    expect(harness.api.jobsList).not.toHaveBeenCalled()
    expect(testId('import-summary')?.textContent).toContain('3')
    expect(text()).not.toContain('99')
  })

  it('cancels addressed A without adopting a newer concurrent B', async () => {
    const active = job({
      id: 'job-a-addressed',
      status: 'running',
      progress: { done: 2, total: 10, ratio: 0.2, phase: 'writing' },
      completedAt: null,
    })

    harness.api.jobGet.mockResolvedValue(active)
    harness.api.jobCancel.mockResolvedValue(
      job({ id: active.id, status: 'canceled', error: null, result: null }),
    )
    await mount('/s/main/management/import?job=job-a-addressed')

    const stream = FakeEventSource.instances.at(-1)

    expect(stream?.url).toBe('/api/s/main/events')
    await act(async () => {
      stream?.emit(
        SSE_EVENT.JOB,
        job({
          id: 'job-b-newer',
          status: 'running',
          progress: { done: 99, total: 100, ratio: 0.99, phase: 'writing' },
          completedAt: null,
        }),
      )
    })
    expect(testId('import-progress')?.textContent).toContain('2 of 10')
    expect(testId('import-progress')?.textContent).not.toContain('99')

    await act(async () => {
      ;(testId('import-cancel') as HTMLButtonElement).click()
    })

    expect(harness.api.jobCancel).toHaveBeenCalledWith('main', 'job-a-addressed')
    expect(testId('import-error')?.textContent).toContain('import canceled')
    expect(harness.api.jobsList).not.toHaveBeenCalled()
  })

  it('does not resurrect running state when an earlier poll resolves after terminal SSE', async () => {
    vi.useFakeTimers()
    const running = job({
      id: 'job-a-addressed',
      status: 'running',
      progress: { done: 2, total: 10, ratio: 0.2, phase: 'writing' },
      completedAt: null,
    })
    let releasePoll!: (value: Job) => void
    const latePoll = new Promise<Job>((resolve) => {
      releasePoll = resolve
    })

    harness.api.jobGet.mockResolvedValueOnce(running).mockReturnValueOnce(latePoll)
    await mount('/s/main/management/import?job=job-a-addressed')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS)
    })
    expect(harness.api.jobGet).toHaveBeenCalledTimes(2)

    const stream = FakeEventSource.instances.at(-1)

    await act(async () => {
      stream?.emit(
        SSE_EVENT.JOB,
        job({
          id: running.id,
          status: 'succeeded',
          progress: { done: 10, total: 10, ratio: 1, phase: 'done' },
          result: { imported: 10, skipped: 0, failed: 0, files: [], errors: [] },
        }),
      )
    })
    expect(testId('import-summary')?.textContent).toContain('10')
    expect(testId('import-progress')).toBeNull()

    await act(async () => {
      releasePoll(running)
      await latePoll
    })

    expect(testId('import-summary')?.textContent).toContain('10')
    expect(testId('import-progress')).toBeNull()
    expect(testId('import-cancel')).toBeNull()
  })

  it('does not accept an old watcher after the route returns to the same job id', async () => {
    vi.useFakeTimers()
    const oldRunning = job({
      id: 'job-a-addressed',
      status: 'running',
      progress: { done: 1, total: 10, ratio: 0.1, phase: 'writing' },
      completedAt: null,
    })
    const staleRunning = job({
      ...oldRunning,
      progress: { done: 2, total: 10, ratio: 0.2, phase: 'writing' },
    })
    const freshRunning = job({
      ...oldRunning,
      progress: { done: 8, total: 10, ratio: 0.8, phase: 'writing' },
    })
    let releaseOldPoll!: (value: Job) => void
    const oldPoll = new Promise<Job>((resolve) => {
      releaseOldPoll = resolve
    })

    harness.api.jobGet
      .mockResolvedValueOnce(oldRunning)
      .mockReturnValueOnce(oldPoll)
      .mockResolvedValueOnce(freshRunning)
    await mount('/s/main/management/import?job=job-a-addressed')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS)
    })
    expect(harness.api.jobGet).toHaveBeenCalledTimes(2)

    await act(async () => navigateRoute('/s/main/management/import'))
    await act(async () => navigateRoute('/s/main/management/import?job=job-a-addressed'))
    expect(harness.api.jobGet).toHaveBeenCalledTimes(3)
    expect(testId('import-progress')?.textContent).toContain('8 of 10')

    await act(async () => {
      releaseOldPoll(staleRunning)
      await oldPoll
    })

    expect(testId('import-progress')?.textContent).toContain('8 of 10')
    expect(testId('import-progress')?.textContent).not.toContain('2 of 10')
  })

  it('ignores a late cancel response after the route selects another job', async () => {
    const activeA = job({
      id: 'job-a-addressed',
      status: 'running',
      progress: { done: 2, total: 10, ratio: 0.2, phase: 'writing' },
      completedAt: null,
    })
    const activeB = job({
      id: 'job-b-addressed',
      status: 'running',
      progress: { done: 7, total: 10, ratio: 0.7, phase: 'writing' },
      completedAt: null,
    })
    let releaseCancel!: (value: Job) => void
    const pendingCancel = new Promise<Job>((resolve) => {
      releaseCancel = resolve
    })
    let releaseB!: (value: Job) => void
    const pendingB = new Promise<Job>((resolve) => {
      releaseB = resolve
    })

    harness.api.jobGet.mockResolvedValueOnce(activeA).mockReturnValueOnce(pendingB)
    harness.api.jobCancel.mockReturnValue(pendingCancel)
    await mount('/s/main/management/import?job=job-a-addressed')

    await act(async () => {
      ;(testId('import-cancel') as HTMLButtonElement).click()
    })
    expect(harness.api.jobCancel).toHaveBeenCalledWith('main', activeA.id)
    await act(async () => navigateRoute('/s/main/management/import?job=job-b-addressed'))
    expect(harness.api.jobGet).toHaveBeenCalledTimes(2)

    await act(async () => {
      releaseCancel(job({ id: activeA.id, status: 'canceled' }))
      await pendingCancel
    })

    expect(testId('import-error')).toBeNull()
    expect(text()).not.toContain('import canceled')

    await act(async () => {
      releaseB(activeB)
      await pendingB
    })
    expect(testId('import-progress')?.textContent).toContain('7 of 10')
  })

  it('clears an addressed job before another import and reloads the newer result', async () => {
    const resultA = { imported: 3, skipped: 0, failed: 0, files: [], errors: [] }
    const resultB = { imported: 7, skipped: 0, failed: 0, files: [], errors: [] }

    harness.api.jobGet.mockResolvedValue(
      job({ id: 'job-a-addressed', status: 'succeeded', result: resultA }),
    )
    harness.api.importStart.mockResolvedValue({
      mode: 'job',
      job: job({ id: 'job-b-newer', status: 'succeeded', result: resultB }),
    })
    await mount('/s/main/management/import?job=job-a-addressed')

    await act(async () => {
      ;(testId('import-again') as HTMLButtonElement).click()
    })
    expect(route).toBe('/s/main/management/import')

    const input = testId('import-file') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['zip'], 'new.zip')],
    })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await act(async () => {
      ;(testId('import-run') as HTMLButtonElement).click()
    })
    expect(testId('import-summary')?.textContent).toContain('7')

    harness.api.jobsList.mockResolvedValue([
      job({ id: 'job-b-newer', status: 'succeeded', result: resultB }),
      job({ id: 'job-a-addressed', status: 'succeeded', result: resultA }),
    ])
    await act(async () => root.unmount())
    root = createRoot(container)
    await mount(route)

    expect(harness.api.jobsList).toHaveBeenCalledWith('main', 'import')
    expect(testId('import-summary')?.textContent).toContain('7')
    expect(testId('import-summary')?.textContent).not.toContain('3')
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
    // drives the hijacked NDJSON stream (services/api/import.ts). The line it feeds `onProgress`
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

  it('keeps processed high-water in terminal synchronous jobs and resets it per run', async () => {
    let hook!: ReturnType<typeof useImportJob>
    let reachedProgress!: () => void
    const progress = new Promise<void>((resolve) => {
      reachedProgress = resolve
    })

    const Probe = () => {
      hook = useImportJob('main')
      return null
    }

    harness.api.importStart
      .mockResolvedValueOnce({
        mode: 'sync',
        run: async (onProgress) => {
          onProgress({ imported: 0, done: 200, phase: 'writing' })
          return { imported: 0, skipped: 0, failed: 0, files: [], errors: [] }
        },
      })
      .mockResolvedValueOnce({
        mode: 'sync',
        run: async (onProgress) => {
          onProgress({ imported: 3, done: 150, phase: 'writing' })
          const err = new ApiError('partial')

          err.partial = { imported: 3, skipped: 0, failed: 1, files: [], errors: [] }
          throw err
        },
      })
      .mockImplementationOnce(async (_space, _source, _opts, signal) => ({
        mode: 'sync',
        run: async (onProgress) => {
          onProgress({ imported: 0, done: 90, phase: 'writing' })
          reachedProgress()

          return await new Promise<ImportSummary>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        },
      }))
    await act(async () => root.render(createElement(Probe)))
    const source = { kind: 'file' as const, file: new File(['zip'], 'vault.zip') }

    await act(async () => hook.start(source, {}))
    expect(hook.job).toMatchObject({ status: 'succeeded', progress: { done: 200 } })

    await act(async () => hook.start(source, {}))
    expect(hook.job).toMatchObject({ status: 'failed', progress: { done: 150 } })

    let canceled!: Promise<void>

    act(() => {
      canceled = hook.start(source, {})
    })
    await act(async () => progress)
    await act(async () => {
      await hook.cancel()
      await canceled
    })
    expect(hook.job).toMatchObject({ status: 'canceled', progress: { done: 90 } })
  })

  it('uploads one selected folder tree with its root wrapper and explicit skip policy', async () => {
    harness.api.importStart.mockResolvedValue({
      mode: 'sync',
      run: async () => ({ imported: 1, skipped: 0, failed: 0, files: [], errors: [] }),
    })
    await mount()

    const markdown = new File(['# A'], 'a.md', { type: 'text/markdown' })
    const image = new File(['png'], 'cover.png', { type: 'image/png' })

    Object.defineProperty(markdown, 'webkitRelativePath', { value: 'vault/a.md' })
    Object.defineProperty(image, 'webkitRelativePath', { value: 'vault/assets/cover.png' })
    const input = testId('import-folder') as HTMLInputElement
    let selectedFiles = [markdown, image]

    Object.defineProperty(input, 'files', {
      configurable: true,
      get: () => selectedFiles,
    })
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => (selectedFiles.length > 0 ? 'C:\\fakepath\\vault' : ''),
      set: (value: string) => {
        if (value === '') {
          selectedFiles = []
        }
      },
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      ;(testId('import-run') as HTMLButtonElement).click()
    })

    expect(harness.api.importStart).toHaveBeenCalledWith(
      'main',
      {
        kind: 'tree',
        entries: [
          { file: markdown, relativePath: 'vault/a.md' },
          { file: image, relativePath: 'vault/assets/cover.png' },
        ],
      },
      expect.objectContaining({ format: 'markdown', skipExisting: false }),
      expect.any(AbortSignal),
    )
    expect(testId('import-summary')?.textContent).toContain('1')
  })

  it('accepts 100000 folder entries and refuses 100001 before copying the FileList', async () => {
    await mount()
    const input = testId('import-folder') as HTMLInputElement
    const markdown = new File(['# A'], 'a.md')

    Object.defineProperty(markdown, 'webkitRelativePath', { value: 'vault/a.md' })
    const atLimit = {
      length: 100_000,
      item: () => markdown,
      *[Symbol.iterator]() {
        for (let index = 0; index < 100_000; index++) {
          yield markdown
        }
      },
    } as unknown as FileList

    Object.defineProperty(input, 'files', { configurable: true, value: atLimit })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(testId('import-run')).toHaveProperty('disabled', false)
    expect(text()).toContain('100000 items')

    Object.defineProperty(input, 'files', {
      configurable: true,
      value: { length: 100_001 } as FileList,
    })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(testId('import-selection-error')?.textContent).toContain('more than 100000 entries')
    expect(testId('import-run')).toHaveProperty('disabled', true)
  })

  it('keeps both browser pickers behind one product entry point', async () => {
    await mount()
    const choose = testId('import-choose') as HTMLButtonElement
    const fileInput = testId('import-file') as HTMLInputElement
    const folderInput = testId('import-folder') as HTMLInputElement
    const fileClick = vi.spyOn(fileInput, 'click').mockImplementation(() => undefined)
    const folderClick = vi.spyOn(folderInput, 'click').mockImplementation(() => undefined)

    expect(choose.textContent).toBe('Choose…')
    expect(testId('import-choose-folder')).toBeNull()
    expect(folderInput.multiple).toBe(false)
    await act(async () => choose.click())

    const menu = document.body.querySelector('[role="menu"]')
    const choices = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])

    expect(choices.map((choice) => choice.textContent)).toEqual(['File or archive', 'Folder'])
    await act(async () => choices[1]?.click())
    expect(folderClick).toHaveBeenCalledOnce()
    expect(fileClick).not.toHaveBeenCalled()

    await act(async () => choose.click())
    const reopenedChoices = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    )

    await act(async () => reopenedChoices[0]?.click())
    expect(fileClick).toHaveBeenCalledOnce()
  })

  it('offers every supported text extension in the ordinary file picker', async () => {
    await mount()
    const input = testId('import-file') as HTMLInputElement

    expect(input.accept.split(',')).toEqual([
      '.zip',
      '.json',
      '.jsonl',
      '.md',
      '.markdown',
      '.mdown',
      '.mkd',
      '.txt',
      '.text',
    ])
  })

  it('imports a selected text file as Markdown with its mtime', async () => {
    harness.api.importStart.mockResolvedValue({
      mode: 'sync',
      run: async () => ({ imported: 1, skipped: 0, failed: 0, files: [], errors: [] }),
    })
    await mount()
    const input = testId('import-file') as HTMLInputElement
    const modifiedAt = Date.parse('2024-02-03T04:05:06.000Z')
    const file = new File(['# Note'], 'note.mdown', {
      type: 'text/markdown',
      lastModified: modifiedAt,
    })

    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await act(async () => {
      ;(testId('import-run') as HTMLButtonElement).click()
    })

    expect(harness.api.importStart).toHaveBeenCalledWith(
      'main',
      { kind: 'file', file },
      expect.objectContaining({
        format: IMPORT_FORMAT.markdown,
        sendLastModified: true,
      }),
      expect.any(AbortSignal),
    )
  })

  it('refuses a directory selection when the browser omits relative paths', async () => {
    await mount()
    const input = testId('import-folder') as HTMLInputElement
    const markdown = new File(['# A'], 'a.md')

    Object.defineProperty(input, 'files', { configurable: true, value: [markdown] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(testId('import-selection-error')?.textContent).toContain(
      'did not provide complete folder paths',
    )
    expect(testId('import-run')).toHaveProperty('disabled', true)
    expect(harness.api.importStart).not.toHaveBeenCalled()
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
