import { afterEach, describe, expect, it, vi } from 'vitest'

import { importStart, normalizeImportSummary } from './import'

const acceptedResponse = () =>
  new Response(JSON.stringify({ id: 'job-1' }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  })

const postedForm = async (start: () => Promise<unknown>): Promise<FormData> => {
  let posted: FormData | null = null

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      posted = init?.body as FormData
      return acceptedResponse()
    }),
  )
  await start()
  expect(posted).toBeInstanceOf(FormData)

  return posted!
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('import multipart upload', () => {
  it('keeps the ordinary single-file request shape', async () => {
    const file = new File(['note'], 'note.md', { lastModified: 1_725_000_000_123 })
    const form = await postedForm(() =>
      importStart(
        'main',
        { kind: 'file', file },
        {
          format: 'markdown',
          root: 'inbox',
          skipExisting: true,
          memory: 'folder',
          sendLastModified: true,
        },
      ),
    )

    expect(Array.from(form.keys())).toEqual([
      'format',
      'root',
      'skipExisting',
      'memory',
      'lastModified',
      'file',
    ])
    expect(form.get('lastModified')).toBe('1725000000123')
    expect(form.get('file')).toBe(file)
  })

  it('serializes one deterministic tree with encoded paths and empty placeholders', async () => {
    const markdown = new File(['# A'], 'a.md', { lastModified: 1234 })
    const unsupported = new File(['secret'], 'asset.png', { lastModified: 0 })
    const form = await postedForm(() =>
      importStart(
        'main',
        {
          kind: 'tree',
          entries: [
            { file: unsupported, relativePath: 'vault/z asset.png' },
            { file: markdown, relativePath: 'vault/é/a.md' },
          ],
        },
        {
          format: 'markdown',
          root: 'imports',
          skipExisting: true,
          memory: 'space',
          sendLastModified: true,
        },
      ),
    )
    const entries = Array.from(form.entries())

    expect(entries.map(([field]) => field)).toEqual([
      'bundle',
      'format',
      'root',
      'skipExisting',
      'entry:0',
      'entry:1234',
    ])
    expect(entries.slice(4).map(([, value]) => (value as File).name)).toEqual([
      'vault%2Fz%20asset.png',
      'vault%2F%C3%A9%2Fa.md',
    ])
    expect((entries[4]![1] as File).size).toBe(0)
    expect(await (entries[5]![1] as File).text()).toBe('# A')
  })
})

const summaryRows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    file: `f${index}.md`,
    format: 'markdown',
    imported: 1,
    skipped: 0,
    warnings: [],
  }))

describe('normalizeImportSummary', () => {
  it('defaults optional collections without losing exact counters', () => {
    expect(normalizeImportSummary({ imported: 3, skipped: 1, failed: 0 })).toEqual({
      imported: 3,
      skipped: 1,
      failed: 0,
      files: [],
      filesOmitted: undefined,
      errors: [],
      errorsOmitted: undefined,
      repointFailed: undefined,
      ignored: undefined,
      created: [],
    })
  })

  it('caps oversized legacy details and adds local omissions to declared ones', () => {
    const summary = normalizeImportSummary({
      imported: 250,
      skipped: 0,
      failed: 250,
      files: summaryRows(250),
      filesOmitted: 1_000,
      errors: Array.from({ length: 250 }, (_, index) => ({ error: `e${index}` })),
      ignored: { count: 250, files: Array.from({ length: 250 }, (_, index) => `x${index}.png`) },
      created: Array.from({ length: 250 }, (_, index) => `id-${index}`),
      repointFailed: 2,
    })!

    expect(summary).toMatchObject({
      imported: 250,
      failed: 250,
      filesOmitted: 1_050,
      errorsOmitted: 50,
      repointFailed: 2,
    })
    expect(summary.files).toHaveLength(200)
    expect(summary.ignored?.files).toHaveLength(200)
    expect(summary.created).toHaveLength(200)
  })

  it('refuses values that are not summary objects', () => {
    expect(normalizeImportSummary(null)).toBeNull()
    expect(normalizeImportSummary('nope')).toBeNull()
  })
})
