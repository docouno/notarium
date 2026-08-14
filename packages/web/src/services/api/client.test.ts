// The synchronous import's NDJSON transport (#302, none-mode fallback). Nothing
// above this layer can reach it: `useImportJob` receives an already-parsed
// summary, and `ImportTab.test.ts` swaps the whole `api` facade — so the stream
// reader is only ever exercised from here, against a stubbed `fetch` handing over
// real chunked bytes. The facts the tab depends on: a mid-import failure still
// reports the notes it wrote (`error.partial`), progress is understood in BOTH the
// pre-#302 and the post-#302 line shape, `done` becomes the summary — and the two
// ways a real socket breaks a stream, a chunk that ends inside a multi-byte code
// point and a chunk that carries several whole lines, are both survived.
// canon: docs/import.md#what-an-import-reports-302

import { afterEach, describe, expect, it, vi } from 'vitest'
import { HTTP_STATUS } from '@notarium/contract/http'

import { ApiError, type ImportProgressLine, importStart } from './client'

/** A response body that hands the reader raw BYTES in chunks of `chunkBytes`, with
 *  line breaks and multi-byte code points landing wherever they fall — a real socket
 *  splits both, and the reader's buffer plus its streaming decoder are what have to
 *  survive it.
 *
 *  Slicing the encoded bytes rather than the string is the whole point: a string
 *  slice cannot cut a code point in half, so an ASCII fixture cut by characters
 *  never exercised the decoder's `{stream:true}` state at all. The chunk SIZE is a
 *  parameter for the same reason: at 13 bytes a chunk holds at most one newline,
 *  and a production chunk (8–64 KB against a ~60-byte progress line) holds dozens. */
const chunkedBody = (text: string, chunkBytes = 13): Response['body'] => {
  const bytes = new TextEncoder().encode(text)
  const chunks: Uint8Array[] = []

  for (let i = 0; i < bytes.length; i += chunkBytes) {
    chunks.push(bytes.slice(i, i + chunkBytes))
  }
  let next = 0

  return {
    getReader: () => ({
      read: async () =>
        next < chunks.length
          ? { value: chunks[next++], done: false }
          : { value: undefined, done: true },
    }),
  } as unknown as Response['body']
}

/** Start an import whose response is the 200 NDJSON stream carrying `lines`. The
 *  last line deliberately has NO trailing newline — the server's final write is
 *  followed by `end()`, so the decoder flush is the only thing that delivers it. */
const syncImport = async (lines: unknown[], chunkBytes?: number) => {
  const text = lines.map((line) => JSON.stringify(line)).join('\n')

  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({
          ok: true,
          status: HTTP_STATUS.OK,
          body: chunkedBody(text, chunkBytes),
        }) as unknown as Response,
    ),
  )

  const started = await importStart('main', new File(['zip'], 'vault.zip'), {})

  if (started.mode !== 'sync') {
    throw new Error(`a 200 NDJSON response is the sync fallback, got mode=${started.mode}`)
  }

  return started
}

/** A member name carrying a 2-byte (é), a 3-byte (—) and a 4-byte (📎) code point.
 *  An import of a real vault is full of these; an ASCII-only fixture cannot tell a
 *  streaming decoder from one that restarts on every chunk. */
const MULTIBYTE = 'vault/café—résumé 📎.md'

const doneLine = (over: Record<string, unknown> = {}) => ({
  type: 'done',
  ok: true,
  imported: 9,
  skipped: 1,
  failed: 0,
  files: [{ file: MULTIBYTE, format: 'markdown', imported: 9, skipped: 1, warnings: [] }],
  errors: [],
  created: ['n-1'],
  ...over,
})

const partialSummary = {
  imported: 2,
  skipped: 0,
  failed: 1,
  files: [{ file: 'a.md', format: 'markdown', imported: 1, skipped: 0, warnings: [] }],
  errors: [{ title: 'b', error: 'destination is taken' }],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('synchronous import stream', () => {
  it('reads progress in both the old and the new line shape, then the done summary', async () => {
    const started = await syncImport([
      { type: 'progress', imported: 3 },
      { type: 'progress', imported: 5, phase: 'writing', done: 7, total: 10 },
      doneLine(),
    ])
    const progress: ImportProgressLine[] = []
    const summary = await started.run((line) => progress.push(line))

    expect(progress).toHaveLength(2)
    // A pre-#302 server sends the successful-write counter alone. `total` must land
    // as null rather than undefined — the tab reads a number as "the plan is known"
    // and would draw a determinate bar off a field that was never sent; `done`
    // staying absent is what makes the hook's `p.done ?? p.imported` fall back.
    expect(progress[0]).toStrictEqual({
      imported: 3,
      phase: undefined,
      done: undefined,
      total: null,
    })
    expect(progress[1]).toStrictEqual({ imported: 5, phase: 'writing', done: 7, total: 10 })
    expect(summary).toMatchObject({ imported: 9, skipped: 1, failed: 0, created: ['n-1'] })
  })

  // Byte-by-byte delivery: every one of those code points arrives in pieces. A
  // decoder called without `{stream:true}` turns each piece into U+FFFD, and what
  // comes out is a note name the user cannot match to anything in their vault —
  // silently, because a replacement character is still valid inside a JSON string,
  // so nothing throws and the summary looks fine.
  it('reassembles a code point that a chunk boundary split in half', async () => {
    const started = await syncImport([{ type: 'progress', imported: 1 }, doneLine()], 1)
    const summary = await started.run(() => {})

    expect(summary.files[0]?.file).toBe(MULTIBYTE)
  })

  // The production shape, which the 13-byte fixture is the opposite of: a chunk is
  // 8–64 KB and a progress line ~60 bytes, so a real read() hands over dozens of
  // lines at once. Handling only the first per read left this stream reporting a
  // successful import as "produced no result" — the `done` line is simply never
  // seen, because it is not the first line in its chunk.
  it('handles every line of a chunk that carries several', async () => {
    const started = await syncImport(
      [
        { type: 'progress', imported: 3 },
        { type: 'progress', imported: 5, phase: 'writing', done: 7, total: 10 },
        doneLine(),
      ],
      64 * 1024,
    )
    const progress: ImportProgressLine[] = []
    const summary = await started.run((line) => progress.push(line))

    expect(progress).toHaveLength(2)
    expect(summary).toMatchObject({ imported: 9, created: ['n-1'] })
  })

  it('keeps the partial summary an error line carried', async () => {
    const started = await syncImport([
      { type: 'progress', imported: 2, phase: 'writing', done: 2, total: 4 },
      { type: 'error', error: 'the archive ended early', partial: partialSummary },
    ])
    const failure = await started
      .run(() => {})
      .then(
        () => null,
        (err: unknown) => err,
      )

    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).message).toBe('the archive ended early')
    // The notes are already on disk; losing this would tell the user nothing happened.
    expect((failure as ApiError).partial).toEqual(partialSummary)
  })
})
