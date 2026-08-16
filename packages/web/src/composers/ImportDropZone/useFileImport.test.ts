// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type * as ReactRouter from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportSummary, Job } from '@notarium/contract'

import type { ToastApi } from '../../core/Toast'
import type * as ApiModule from '../../services/api'
import type { CapturedDrop } from './dropEntries'

const harness = vi.hoisted(() => {
  let toastId = 0

  return {
    api: { importStart: vi.fn<typeof ApiModule.api.importStart>() },
    poll: vi.fn<typeof ApiModule.pollJobToTerminal>(),
    navigate: vi.fn(),
    canWrite: true,
    space: 'main',
    toast: {
      show: vi.fn<ToastApi['show']>(() => `toast-${++toastId}`),
      error: vi.fn<ToastApi['error']>(() => `toast-${++toastId}`),
      success: vi.fn<ToastApi['success']>(() => `toast-${++toastId}`),
      info: vi.fn<ToastApi['info']>(() => `toast-${++toastId}`),
      warning: vi.fn<ToastApi['warning']>(() => `toast-${++toastId}`),
      dismiss: vi.fn<ToastApi['dismiss']>(),
    },
  }
})

vi.mock('../SpaceProvider', () => ({
  useSpace: () => ({ space: harness.space, canWrite: harness.canWrite }),
}))
vi.mock('../../core/Toast', () => ({ useToast: () => harness.toast }))
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useNavigate: () => harness.navigate,
}))
vi.mock('../../services/api', async (importOriginal) => {
  const real = await importOriginal<typeof ApiModule>()

  return {
    ...real,
    api: { ...real.api, importStart: harness.api.importStart },
    pollJobToTerminal: harness.poll,
  }
})

import type { ImportUploadSource } from '../../services/api'
import type { ImportDrop } from './useFileImport'
import { useDropImport } from './useFileImport'

type ImportStartResult = Awaited<ReturnType<typeof ApiModule.api.importStart>>
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const summary = (over: Partial<ImportSummary> = {}): ImportSummary => ({
  imported: 1,
  skipped: 0,
  failed: 0,
  files: [],
  errors: [],
  created: ['note-1'],
  ...over,
})

const job = (over: Partial<Job> = {}): Job => ({
  id: 'job-a',
  kind: 'import',
  status: 'pending',
  progress: { done: 0, total: null, ratio: null, phase: null },
  artifact: null,
  result: null,
  error: null,
  createdAt: '',
  updatedAt: '',
  completedAt: null,
  ...over,
})

describe('drop import lifecycle', () => {
  let container: HTMLDivElement
  let root: Root
  let importFiles: (source: ImportUploadSource, folder: string) => Promise<void>
  let importDrop: ImportDrop

  const Probe = () => {
    importDrop = useDropImport()
    importFiles = (source, folder) => {
      const files =
        source.kind === 'file' ? [source.file] : source.entries.map((entry) => entry.file)

      return importDrop(
        {
          entries: [],
          fallbackFiles: files,
          fileItemCount: files.length,
          unresolvedItemCount: files.length,
        },
        folder,
      )
    }

    return null
  }

  beforeEach(async () => {
    harness.canWrite = true
    harness.space = 'main'
    harness.api.importStart.mockReset()
    harness.poll.mockReset()
    harness.navigate.mockReset()
    for (const fn of Object.values(harness.toast)) {
      fn.mockClear()
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(Probe)))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('uploads one complete tree request with the safe drop policy', async () => {
    harness.api.importStart.mockResolvedValue({
      mode: 'sync',
      run: async () => summary(),
    })
    const markdown = new File(['# A'], 'a.md', { lastModified: 1234 })
    const image = new File(['png'], 'cover.png')
    const source = {
      kind: 'tree' as const,
      entries: [
        { file: markdown, relativePath: 'a.md' },
        { file: image, relativePath: 'cover.png' },
      ],
    }

    await act(async () => importFiles(source, 'Research'))

    expect(harness.api.importStart).toHaveBeenCalledTimes(1)
    expect(harness.api.importStart).toHaveBeenCalledWith(
      'main',
      source,
      expect.objectContaining({ format: 'markdown', root: 'Research', skipExisting: true }),
      expect.any(AbortSignal),
    )
    expect(harness.toast.success).toHaveBeenCalledTimes(1)
  })

  it('blocks a second drop before 202 without inventing a progress action', async () => {
    let release!: (value: ImportStartResult) => void
    const started = new Promise<ImportStartResult>((resolve) => {
      release = resolve
    })

    harness.api.importStart.mockReturnValue(started)
    const first = importFiles({ kind: 'file', file: new File(['# A'], 'a.md') }, '')

    await act(async () => Promise.resolve())
    await act(async () => importFiles({ kind: 'file', file: new File(['# B'], 'b.md') }, ''))

    expect(harness.api.importStart).toHaveBeenCalledTimes(1)
    expect(harness.toast.info).toHaveBeenCalledWith('An import is already running.', {})
    release({
      mode: 'job',
      job: job({ status: 'succeeded', result: summary(), completedAt: '' }),
    })
    await act(async () => first)
  })

  it('addresses the exact durable job once 202 has exposed its id', async () => {
    let releasePoll!: (value: Job) => void
    const polled = new Promise<Job>((resolve) => {
      releasePoll = resolve
    })

    harness.api.importStart.mockResolvedValue({ mode: 'job', job: job({ id: 'job-a' }) })
    harness.poll.mockReturnValue(polled)
    const first = importFiles({ kind: 'file', file: new File(['# A'], 'a.md') }, '')

    await vi.waitFor(() => {
      expect(harness.toast.info).toHaveBeenCalledWith(
        'Import started.',
        expect.objectContaining({ action: expect.any(Object) }),
      )
    })
    await act(async () => importFiles({ kind: 'file', file: new File(['# B'], 'b.md') }, ''))
    const conflict = harness.toast.info.mock.calls.find(
      ([message]) => message === 'An import is already running.',
    )
    const action = conflict?.[1]?.action

    expect(action?.label).toBe('View progress')
    action?.onClick()
    expect(harness.navigate).toHaveBeenCalledWith('/s/main/management/import?job=job-a')

    releasePoll(job({ id: 'job-a', status: 'succeeded', result: summary(), completedAt: '' }))
    await act(async () => first)
  })

  it.each([
    {
      name: 'succeeded',
      terminal: job({ status: 'succeeded', result: summary(), completedAt: '' }),
      variant: 'success' as const,
      message: 'Imported 1 note into the workspace root.',
    },
    {
      name: 'failed with a partial result',
      terminal: job({
        status: 'failed',
        error: 'disk full',
        result: summary({ imported: 2, created: [] }),
        completedAt: '',
      }),
      variant: 'warning' as const,
      message: 'Imported 2 notes. Import failed: disk full',
    },
    {
      name: 'canceled',
      terminal: job({ status: 'canceled', completedAt: '' }),
      variant: 'info' as const,
      message: 'Import canceled.',
    },
  ])('emits one terminal outcome when the durable job is $name', async (testCase) => {
    harness.api.importStart.mockResolvedValue({ mode: 'job', job: job() })
    harness.poll.mockResolvedValue(testCase.terminal)

    await act(async () => importFiles({ kind: 'file', file: new File(['zip'], 'vault.zip') }, ''))

    expect(harness.toast[testCase.variant]).toHaveBeenCalledWith(testCase.message)
    const terminalMessages = [
      ...harness.toast.success.mock.calls,
      ...harness.toast.warning.mock.calls,
      ...harness.toast.error.mock.calls,
      ...harness.toast.info.mock.calls.filter(([message]) =>
        ['Import canceled.'].includes(String(message)),
      ),
    ]

    expect(terminalMessages).toHaveLength(1)
  })

  it('keeps a synchronous run non-addressable until it finishes', async () => {
    let release!: (value: ImportSummary) => void
    const finished = new Promise<ImportSummary>((resolve) => {
      release = resolve
    })

    harness.api.importStart.mockResolvedValue({ mode: 'sync', run: async () => finished })
    const first = importFiles({ kind: 'file', file: new File(['# A'], 'a.md') }, '')

    await vi.waitFor(() => expect(harness.api.importStart).toHaveBeenCalledTimes(1))
    await act(async () => importFiles({ kind: 'file', file: new File(['# B'], 'b.md') }, ''))
    const conflict = harness.toast.info.mock.calls.find(
      ([message]) => message === 'An import is already running.',
    )

    expect(conflict?.[1]?.action).toBeUndefined()
    release(summary())
    await act(async () => first)
  })

  it('turns an unavailable folder entry API into a Settings action without a request', async () => {
    const capture: CapturedDrop = {
      entries: [],
      fallbackFiles: [],
      fileItemCount: 1,
      unresolvedItemCount: 1,
    }

    await act(async () => importDrop(capture, ''))

    expect(harness.api.importStart).not.toHaveBeenCalled()
    const notice = harness.toast.info.mock.calls.find(
      ([message]) => message === 'This browser could not fully read the dropped items.',
    )
    const action = notice?.[1]?.action

    expect(action?.label).toBe('Open Import settings')
    action?.onClick()
    expect(harness.navigate).toHaveBeenCalledWith('/s/main/management/import')
  })

  it('atomically treats dotted and mixed all-null placeholders as a capability fallback', async () => {
    const capture: CapturedDrop = {
      entries: [],
      fallbackFiles: [new File([], 'vault.v1'), new File(['# A'], 'a.md')],
      fileItemCount: 2,
      unresolvedItemCount: 2,
    }

    await act(async () => importDrop(capture, ''))

    expect(harness.api.importStart).not.toHaveBeenCalled()
    expect(harness.toast.info).toHaveBeenCalledWith(
      'This browser could not fully read the dropped items.',
      expect.objectContaining({ action: expect.any(Object) }),
    )
  })

  it.each([
    { name: 'shorter', files: [new File(['# A'], 'a.md')], itemCount: 2 },
    {
      name: 'longer',
      files: [new File(['# A'], 'a.md'), new File(['# B'], 'b.md')],
      itemCount: 1,
    },
  ])('does not upload an incomplete $name all-null FileList', async ({ files, itemCount }) => {
    const capture: CapturedDrop = {
      entries: [],
      fallbackFiles: files,
      fileItemCount: itemCount,
      unresolvedItemCount: itemCount,
    }

    await act(async () => importDrop(capture, ''))

    expect(harness.api.importStart).not.toHaveBeenCalled()
    expect(harness.toast.info).toHaveBeenCalledWith(
      'This browser could not fully read the dropped items.',
      expect.objectContaining({ action: expect.any(Object) }),
    )
  })

  it('uses fast polling only for a direct text import', async () => {
    harness.api.importStart.mockResolvedValue({ mode: 'job', job: job() })
    harness.poll.mockResolvedValue(job({ status: 'succeeded', result: summary(), completedAt: '' }))

    await act(async () => importFiles({ kind: 'file', file: new File(['zip'], 'vault.zip') }, ''))
    expect(harness.poll.mock.calls[0]?.[2]).toEqual({
      signal: expect.any(AbortSignal),
    })

    await act(async () => importFiles({ kind: 'file', file: new File(['# A'], 'a.md') }, ''))
    expect(harness.poll.mock.calls[1]?.[2]).toEqual({
      intervalMs: 400,
      signal: expect.any(AbortSignal),
    })
  })

  it('describes an unsupported single file as a file, not a folder', async () => {
    const capture: CapturedDrop = {
      entries: [],
      fallbackFiles: [new File(['png'], 'cover.png')],
      fileItemCount: 1,
      unresolvedItemCount: 1,
    }

    await act(async () => importDrop(capture, ''))

    expect(harness.toast.info).toHaveBeenCalledWith(
      'Only Markdown and text files can be imported from the dropped file.',
    )
    expect(harness.api.importStart).not.toHaveBeenCalled()
  })

  it('keeps every nonzero counter in success and failed-partial terminal summaries', async () => {
    const complete = summary({
      imported: 1,
      skipped: 2,
      failed: 3,
      ignored: { count: 4, files: [] },
      repointFailed: 5,
      created: [],
    })

    harness.api.importStart.mockResolvedValueOnce({
      mode: 'job',
      job: job({ status: 'succeeded', result: complete, completedAt: '' }),
    })
    await act(async () => importFiles({ kind: 'file', file: new File(['zip'], 'vault.zip') }, ''))
    expect(harness.toast.warning).toHaveBeenLastCalledWith(
      'Imported 1 note into the workspace root, 2 skipped (already exists; content not compared), 3 failed, 4 unsupported, 5 with links left pointing at the source.',
    )

    harness.api.importStart.mockResolvedValueOnce({
      mode: 'job',
      job: job({ status: 'failed', error: 'disk full', result: complete, completedAt: '' }),
    })
    await act(async () => importFiles({ kind: 'file', file: new File(['zip'], 'again.zip') }, ''))
    expect(harness.toast.warning).toHaveBeenLastCalledWith(
      'Imported 1 note, 2 skipped (already exists; content not compared), 3 failed, 4 unsupported, 5 with links left pointing at the source. Import failed: disk full',
    )
  })

  it('aborts and releases only its own monitor when the space changes', async () => {
    let releasePoll!: (value: Job) => void
    const polled = new Promise<Job>((resolve) => {
      releasePoll = resolve
    })

    harness.api.importStart
      .mockResolvedValueOnce({ mode: 'job', job: job({ id: 'job-old' }) })
      .mockResolvedValueOnce({ mode: 'sync', run: async () => summary() })
    harness.poll.mockReturnValue(polled)
    const oldRun = importFiles({ kind: 'file', file: new File(['zip'], 'old.zip') }, '')

    await vi.waitFor(() => expect(harness.poll).toHaveBeenCalledOnce())
    const oldSignal = harness.poll.mock.calls[0]?.[2]?.signal

    harness.space = 'other'
    await act(async () => root.render(createElement(Probe)))
    expect(oldSignal?.aborted).toBe(true)

    await act(async () => importFiles({ kind: 'file', file: new File(['# New'], 'new.md') }, ''))
    expect(harness.api.importStart).toHaveBeenLastCalledWith(
      'other',
      expect.any(Object),
      expect.any(Object),
      expect.any(AbortSignal),
    )
    harness.toast.success.mockClear()

    releasePoll(job({ id: 'job-old', status: 'succeeded', result: summary(), completedAt: '' }))
    await act(async () => oldRun)
    expect(harness.toast.success).not.toHaveBeenCalled()
  })

  it('atomically refuses a partially captured drop before the network', async () => {
    const capture: CapturedDrop = {
      entries: [
        {
          isFile: true,
          isDirectory: false,
          name: 'a.md',
          fullPath: '/a.md',
        } as FileSystemEntry,
      ],
      fallbackFiles: [new File(['# A'], 'a.md'), new File(['zip'], 'vault.zip')],
      fileItemCount: 2,
      unresolvedItemCount: 1,
    }

    await act(async () => importDrop(capture, ''))

    expect(harness.api.importStart).not.toHaveBeenCalled()
    expect(harness.toast.error).toHaveBeenCalledWith(
      'The browser could not read every dropped item, so nothing was imported.',
    )
  })
})
