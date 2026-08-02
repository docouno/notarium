// Unit tests for the `import` job handler (#191) — the branches the e2e happy path
// doesn't isolate: it reuses runImport over a STAGED upload and returns the summary in
// `result` with NO artifact; a pre-aborted signal surfaces as a clean JobAbortedError
// (a cooperative cancel); a missing uploadRef fails loudly; and the ephemeral member
// temp dir is always cleaned. The durable upload is deliberately NOT removed by the
// handler (the staging sweep owns that) — asserted here so a refactor can't regress it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createImportHandler } from '../../packages/server/src/apps/server/consumers/importJob'
import {
  JobAbortedError,
  type JobContext,
} from '../../packages/server/src/apps/server/consumers/jobRunner'
import { TerminalJobError } from '../../packages/server/src/apps/server/consumers/terminalJobError'
import type { ImportStagingStore } from '../../packages/server/src/libs/importStaging'
import type { JobRecord } from '../../packages/server/src/services/metaDb/types'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true })
  }
})

const CONVERSATIONS = JSON.stringify([
  {
    uuid: 'c-1',
    name: 'Hello',
    created_at: '2024-03-15T14:30:00Z',
    chat_messages: [{ sender: 'human', text: 'hi' }],
  },
])

/** Write an upload to disk and return a staging stub whose pathOf points at it; the
 *  `removed` flag records whether the handler tried to reclaim the upload (it must not). */
const stagingFor = (content: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'notarium-importjob-test-'))
  dirs.push(dir)
  const path = join(dir, 'upload.tmp')
  writeFileSync(path, content)
  const state = { removed: false }
  const staging: ImportStagingStore = {
    stage: async () => 'ref',
    pathOf: () => path,
    remove: async () => {
      state.removed = true
    },
    removeSpace: async () => {},
    sweepOrphans: async () => {},
  }
  return { staging, state }
}

const fakeStore = () => {
  const writes: Array<{ title?: string; fileName?: string }> = []
  return {
    writes,
    write: async (input: { title?: string; fileName?: string }) => {
      writes.push(input)
      return { id: `n${writes.length}` }
    },
  }
}

const jobRec = (params: unknown): JobRecord =>
  ({
    id: 'j1',
    space: 'S',
    kind: 'import',
    status: 'running',
    principal: 'user:a',
    params,
    progressDone: 0,
    progressTotal: null,
    phase: null,
    attempts: 1,
    maxAttempts: 3,
    runAt: '2026-01-01T00:00:00.000Z',
    lockedAt: '2026-01-01T00:00:00.000Z',
    lockedBy: 'lease-A',
    artifactRef: null,
    artifactBytes: null,
    artifactName: null,
    result: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    expiresAt: null,
  }) as JobRecord

const ctxOf = (
  store: ReturnType<typeof fakeStore>,
  staging: ImportStagingStore,
  params: unknown,
  signal: AbortSignal,
): JobContext => ({
  job: jobRec(params),
  signal,
  artifacts: {} as never, // an import handler produces no artifact
  report: async () => {},
})

describe('createImportHandler (#191)', () => {
  it('imports the staged upload, returns the summary in result, produces no artifact', async () => {
    const { staging, state } = stagingFor(CONVERSATIONS)
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    const out = await handler(
      ctxOf(
        store,
        staging,
        { uploadRef: 'ref', filename: 'conversations.json' },
        new AbortController().signal,
      ),
    )

    expect(out.artifactRef).toBeUndefined()
    const summary = out.result as {
      imported: number
      failed: number
      files: Array<{ format: string }>
    }
    expect(summary.imported).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.files[0].format).toBe('claude-conversations')
    expect(store.writes).toHaveLength(1)
    // The durable upload is left for the staging sweep — the handler never removes it.
    expect(state.removed).toBe(false)
  })

  it('maps a pre-aborted signal to a clean JobAbortedError (cooperative cancel)', async () => {
    const { staging } = stagingFor(CONVERSATIONS)
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    const controller = new AbortController()
    controller.abort()
    await expect(
      handler(
        ctxOf(
          store,
          staging,
          { uploadRef: 'ref', filename: 'conversations.json' },
          controller.signal,
        ),
      ),
    ).rejects.toBeInstanceOf(JobAbortedError)
    expect(store.writes).toHaveLength(0) // aborted before the first write
  })

  it('fails loudly when the job carries no uploadRef', async () => {
    const { staging } = stagingFor(CONVERSATIONS)
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    await expect(
      handler(ctxOf(store, staging, { filename: 'x.json' }, new AbortController().signal)),
    ).rejects.toThrow(/uploadRef/)
  })

  it('maps a deterministic bad-upload (ImportError) to a TerminalJobError (no retry)', async () => {
    // An unrecognised single-object upload → streamImportFile throws ImportError.
    const { staging } = stagingFor('{"hello":"world"}')
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    const err = await handler(
      ctxOf(
        store,
        staging,
        { uploadRef: 'ref', filename: 'random.json' },
        new AbortController().signal,
      ),
    ).catch((e) => e)
    expect(err).toBeInstanceOf(TerminalJobError)
    expect((err as Error).message).toMatch(/recognised/i)
    expect(store.writes).toHaveLength(0)
  })

  it('rethrows a non-ImportError as-is — a transient fault stays RETRYABLE, not terminal', async () => {
    // A missing staged file → runImport hits ENOENT opening it, a non-ImportError.
    const dir = mkdtempSync(join(tmpdir(), 'notarium-importjob-test-'))
    dirs.push(dir)
    const staging: ImportStagingStore = {
      stage: async () => 'ref',
      pathOf: () => join(dir, 'does-not-exist.tmp'),
      remove: async () => {},
      removeSpace: async () => {},
      sweepOrphans: async () => {},
    }
    const store = fakeStore()
    const handler = createImportHandler({ resolveStore: async () => store as never, staging })
    const err = await handler(
      ctxOf(store, staging, { uploadRef: 'ref', filename: 'x.json' }, new AbortController().signal),
    ).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(TerminalJobError) // NOT converted to terminal → runner retries
    expect(err).not.toBeInstanceOf(JobAbortedError)
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
  })
})
