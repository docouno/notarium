import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentTraceApi, readAgentTraceForCopy } from './agentTrace'
import { ApiError } from './client'

const chunkedResponse = (text: string, chunkBytes: number, onCancel?: () => void): Response => {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (offset >= bytes.length) {
          controller.close()
          return
        }
        controller.enqueue(bytes.slice(offset, offset + chunkBytes))
        offset += chunkBytes
      },
      cancel: onCancel,
    }),
    { status: 200 },
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('bounded agent trace clipboard transport', () => {
  it('reassembles UTF-8 split across chunks and returns exact NDJSON below the cap', async () => {
    const ndjson =
      '{"type":"metadata","title":"café 📎"}\n{"type":"summary","events":0,"complete":true}\n'

    await expect(readAgentTraceForCopy(chunkedResponse(ndjson, 1), 1024)).resolves.toEqual({
      status: 'ready',
      text: ndjson,
      bytes: new TextEncoder().encode(ndjson).byteLength,
    })
  })

  it('cancels the stream as soon as decoded bytes cross the clipboard cap', async () => {
    const cancelled = vi.fn()

    await expect(
      readAgentTraceForCopy(chunkedResponse('x'.repeat(100), 8, cancelled), 20),
    ).resolves.toEqual({ status: 'too-large', limitBytes: 20 })
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('keeps HTTP failure status and never treats an error envelope as trace text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"not found"}', { status: 404 })),
    )

    const failure = await agentTraceApi
      .agentSessionTraceCopy('ses_missing0000')
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ message: 'not found', status: 404 })
  })

  it('rejects a short stream without the terminal completeness record', async () => {
    await expect(
      readAgentTraceForCopy(chunkedResponse('{"type":"metadata"}\n', 8), 1024),
    ).rejects.toMatchObject({ message: 'Trace export ended before its terminal summary' })
  })
})
