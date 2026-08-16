import { describe, expect, it, vi } from 'vitest'

import {
  type CapturedDrop,
  captureDrop,
  DROP_ENTRIES_ERROR,
  expandDrop,
  prepareDrop,
} from './dropEntries'

const fileEntry = (
  name: string,
  options: { body?: string; error?: DOMException } = {},
): FileSystemFileEntry =>
  ({
    isFile: true,
    isDirectory: false,
    name,
    fullPath: `/${name}`,
    file: (success: FileCallback, error?: ErrorCallback) =>
      options.error
        ? error?.(options.error)
        : success(new File([options.body ?? name], name, { type: 'text/plain' })),
  }) as FileSystemFileEntry

const directoryEntry = (
  name: string,
  pages: FileSystemEntry[][],
  error?: DOMException,
): FileSystemDirectoryEntry =>
  ({
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/${name}`,
    createReader: () => {
      let page = 0

      return {
        readEntries: (success: FileSystemEntriesCallback, fail?: ErrorCallback) => {
          if (error) {
            fail?.(error)
            return
          }
          success(pages[page++] ?? [])
        },
      } as FileSystemDirectoryReader
    },
  }) as FileSystemDirectoryEntry

const captured = (entries: FileSystemEntry[], rest: Partial<CapturedDrop> = {}): CapturedDrop => ({
  entries,
  fallbackFiles: [],
  fileItemCount: entries.length,
  unresolvedItemCount: 0,
  ...rest,
})

describe('folder drop intake', () => {
  it('reads every directory page and keeps the top-level root', async () => {
    const first = Array.from({ length: 100 }, (_, i) => fileEntry(`n-${i}.md`))
    const root = directoryEntry('research', [first, [fileEntry('last.txt')], []])
    const result = await expandDrop(captured([root]))

    expect(result.files).toHaveLength(101)
    expect(result.files[0].relativePath).toBe('research/last.txt')
    expect(result.files.at(-1)?.relativePath).toBe('research/n-99.md')
    expect(result.hadDirectory).toBe(true)
    expect(result.topLevelNames).toEqual(['research'])
  })

  it('sorts nested paths deterministically', async () => {
    const sub = directoryEntry('sub', [[fileEntry('z.md'), fileEntry('a.md')], []])
    const root = directoryEntry('research', [[fileEntry('b.txt'), sub], []])

    await expect(expandDrop(captured([root]))).resolves.toMatchObject({
      files: [
        { relativePath: 'research/b.txt' },
        { relativePath: 'research/sub/a.md' },
        { relativePath: 'research/sub/z.md' },
      ],
    })
  })

  it('owns the entry snapshot before DataTransfer expires', async () => {
    let valid = true
    const entry = fileEntry('a.md')
    const item = {
      kind: 'file',
      webkitGetAsEntry: vi.fn(() => {
        if (!valid) {
          throw new Error('expired')
        }

        return entry
      }),
    }
    const capture = captureDrop({ files: [], items: [item] } as unknown as DataTransfer)

    valid = false
    await expect(expandDrop(capture)).resolves.toMatchObject({
      files: [{ relativePath: 'a.md' }],
    })
    expect(item.webkitGetAsEntry).toHaveBeenCalledTimes(1)
  })

  it('refuses a partial entry capture instead of importing a subset', async () => {
    const fallback = [new File(['a'], 'a.md'), new File(['z'], 'vault.zip')]
    const capture = captureDrop({
      files: fallback,
      items: [
        { kind: 'file', webkitGetAsEntry: () => fileEntry('a.md') },
        { kind: 'file', webkitGetAsEntry: () => null },
      ],
    } as unknown as DataTransfer)

    await expect(expandDrop(capture)).rejects.toMatchObject({
      code: DROP_ENTRIES_ERROR.partialCapture,
    })
  })

  it('uses flat files when every entry is unavailable', async () => {
    const files = [new File(['a'], 'a.md'), new File(['z'], 'vault.zip')]
    const capture = captureDrop({
      files,
      items: files.map(() => ({ kind: 'file', webkitGetAsEntry: () => null })),
    } as unknown as DataTransfer)

    await expect(expandDrop(capture)).resolves.toMatchObject({
      files: [{ relativePath: 'a.md' }, { relativePath: 'vault.zip' }],
      hadDirectory: false,
    })
  })

  it('keeps zero-byte ordinary text and ZIP files in the all-null fallback', async () => {
    const files = [new File([], 'empty.md'), new File([], 'empty.zip')]
    const capture = captured([], {
      fallbackFiles: files,
      fileItemCount: files.length,
      unresolvedItemCount: files.length,
    })

    await expect(expandDrop(capture)).resolves.toMatchObject({
      files: [{ relativePath: 'empty.md' }, { relativePath: 'empty.zip' }],
      hadDirectory: false,
    })
  })

  it('reports an unavailable folder capability when no fallback file exists', async () => {
    const capture = captureDrop({
      files: [],
      items: [{ kind: 'file', webkitGetAsEntry: () => null }],
    } as unknown as DataTransfer)

    await expect(expandDrop(capture)).rejects.toMatchObject({
      code: DROP_ENTRIES_ERROR.capabilityUnavailable,
    })
  })

  it.each(['vault', 'research.2026'])(
    'treats an ambiguous all-null %s placeholder as a capability refusal',
    async (name) => {
      const capture = captured([], {
        fallbackFiles: [new File([], name)],
        fileItemCount: 1,
        unresolvedItemCount: 1,
      })

      await expect(expandDrop(capture)).rejects.toMatchObject({
        code: DROP_ENTRIES_ERROR.capabilityUnavailable,
      })
    },
  )

  it('atomically refuses an ambiguous placeholder beside an ordinary text file', async () => {
    const capture = captured([], {
      fallbackFiles: [new File([], 'vault'), new File(['# A'], 'a.md')],
      fileItemCount: 2,
      unresolvedItemCount: 2,
    })

    await expect(expandDrop(capture)).rejects.toMatchObject({
      code: DROP_ENTRIES_ERROR.capabilityUnavailable,
    })
  })

  it.each([
    { name: 'shorter', files: [new File(['# A'], 'a.md')], itemCount: 2 },
    {
      name: 'longer',
      files: [new File(['# A'], 'a.md'), new File(['# B'], 'b.md')],
      itemCount: 1,
    },
  ])('atomically refuses an all-null $name FileList', async ({ files, itemCount }) => {
    const capture = captured([], {
      fallbackFiles: files,
      fileItemCount: itemCount,
      unresolvedItemCount: itemCount,
    })

    await expect(expandDrop(capture)).rejects.toMatchObject({
      code: DROP_ENTRIES_ERROR.capabilityUnavailable,
    })
  })

  it('keeps the legacy FileList fallback when the browser exposes no item list', async () => {
    const capture = captured([], {
      fallbackFiles: [new File(['# A'], 'a.md')],
      fileItemCount: 0,
      unresolvedItemCount: 0,
    })

    await expect(expandDrop(capture)).resolves.toMatchObject({
      files: [{ relativePath: 'a.md' }],
      hadDirectory: false,
    })
  })

  it('refuses the whole traversal after any reader failure', async () => {
    const root = directoryEntry('research', [
      [fileEntry('ok.md'), fileEntry('bad.md', { error: new DOMException('no') })],
      [],
    ])

    await expect(expandDrop(captured([root]))).rejects.toMatchObject({
      code: DROP_ENTRIES_ERROR.readFailed,
    })
  })

  it('stops at the discovered-entry ceiling', async () => {
    const root = directoryEntry('research', [[fileEntry('a.md'), fileEntry('b.md')], []])

    await expect(expandDrop(captured([root]), { maxEntries: 2 })).rejects.toMatchObject({
      code: DROP_ENTRIES_ERROR.tooManyEntries,
    })
  })
})

describe('drop import routing', () => {
  const file = (name: string) => new File([name], name, { type: 'text/plain' })
  const expanded = (
    paths: string[],
    options: { hadDirectory?: boolean; topLevelNames?: string[]; topLevelCount?: number } = {},
  ) => ({
    files: paths.map((relativePath) => ({ file: file(relativePath), relativePath })),
    hadDirectory: options.hadDirectory ?? false,
    topLevelCount: options.topLevelCount ?? paths.length,
    topLevelNames: options.topLevelNames ?? paths,
  })

  it('keeps one text file direct and opens it after import', () => {
    expect(prepareDrop(expanded(['note.MARKDOWN']))).toMatchObject({
      source: { kind: 'file', file: { name: 'note.MARKDOWN' } },
      openSingleText: true,
    })
  })

  it('routes one ZIP through the server auto classifier', () => {
    expect(prepareDrop(expanded(['vault.ZIP']))).toMatchObject({
      source: { kind: 'file', file: { name: 'vault.ZIP' } },
      openSingleText: false,
    })
  })

  it('keeps a directory wrapper even when it contains one note', () => {
    expect(
      prepareDrop(
        expanded(['vault/a.md'], {
          hadDirectory: true,
          topLevelNames: ['vault'],
          topLevelCount: 1,
        }),
      ),
    ).toMatchObject({
      source: { kind: 'tree', entries: [{ relativePath: 'vault/a.md' }] },
      openSingleText: false,
    })
  })

  it('makes one tree from flat text files and keeps unsupported members', () => {
    const result = prepareDrop(expanded(['a.md', 'cover.png', 'b.txt']))

    expect(result.source).toMatchObject({
      kind: 'tree',
      entries: [{ relativePath: 'a.md' }, { relativePath: 'cover.png' }, { relativePath: 'b.txt' }],
    })
  })

  it('refuses unsupported-only input before upload', () => {
    expect(() => prepareDrop(expanded(['cover.png']))).toThrowError(
      expect.objectContaining({ code: DROP_ENTRIES_ERROR.unsupportedOnly }),
    )
  })

  it('refuses a top-level ZIP mixed with any other entry', () => {
    expect(() => prepareDrop(expanded(['vault.zip', 'a.md']))).toThrowError(
      expect.objectContaining({ code: DROP_ENTRIES_ERROR.mixedArchive }),
    )
  })

  it('keeps a nested ZIP as an unsupported tree member instead of opening it', () => {
    expect(
      prepareDrop(
        expanded(['vault/a.md', 'vault/nested.zip'], {
          hadDirectory: true,
          topLevelNames: ['vault'],
          topLevelCount: 1,
        }),
      ).source,
    ).toMatchObject({
      kind: 'tree',
      entries: [{ relativePath: 'vault/a.md' }, { relativePath: 'vault/nested.zip' }],
    })
  })
})
