import { isImportTextPath } from '@notarium/core'

import {
  IMPORT_TREE_ENTRY_LIMIT,
  type ImportTreeEntry,
  type ImportUploadSource,
} from '../../services/api'

export const DROP_ENTRIES_ERROR = {
  partialCapture: 'partial-capture',
  capabilityUnavailable: 'capability-unavailable',
  readFailed: 'read-failed',
  tooManyEntries: 'too-many-entries',
  unsupportedOnly: 'unsupported-only',
  mixedArchive: 'mixed-archive',
} as const

export type DropEntriesErrorCode = (typeof DROP_ENTRIES_ERROR)[keyof typeof DROP_ENTRIES_ERROR]

export class DropEntriesError extends Error {
  constructor(
    readonly code: DropEntriesErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DropEntriesError'
  }
}

export type CapturedDrop = {
  entries: readonly FileSystemEntry[]
  fallbackFiles: readonly File[]
  fileItemCount: number
  unresolvedItemCount: number
}

export type ExpandedDrop = {
  files: ImportTreeEntry[]
  hadDirectory: boolean
  topLevelCount: number
  topLevelNames: string[]
}

export type PreparedDrop = {
  source: ImportUploadSource
  /** A direct Markdown file keeps the old open-after-import behavior. */
  openSingleText: boolean
}

const ZIP_EXT = /\.zip$/i

/** Own every browser-owned value synchronously; DataTransfer expires after drop returns. */
export const captureDrop = (dataTransfer: DataTransfer): CapturedDrop => {
  const fallbackFiles = Array.from(dataTransfer.files)
  const fileItems = Array.from(dataTransfer.items).filter((item) => item.kind === 'file')
  const entries: FileSystemEntry[] = []
  let unresolvedItemCount = 0

  for (const item of fileItems) {
    let entry: FileSystemEntry | null = null

    try {
      entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    } catch {
      entry = null
    }
    if (entry) {
      entries.push(entry)
    } else {
      unresolvedItemCount++
    }
  }

  return {
    entries,
    fallbackFiles,
    fileItemCount: fileItems.length,
    unresolvedItemCount,
  }
}

const readDirectoryPage = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
  new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject)
  })

const readFileEntry = (entry: FileSystemFileEntry): Promise<File> =>
  new Promise((resolve, reject) => {
    entry.file(resolve, reject)
  })

type StackEntry = { entry: FileSystemEntry; relativePath: string }

export const expandDrop = async (
  capture: CapturedDrop,
  options: { maxEntries?: number } = {},
): Promise<ExpandedDrop> => {
  const maxEntries = options.maxEntries ?? IMPORT_TREE_ENTRY_LIMIT

  if (capture.entries.length > 0 && capture.unresolvedItemCount > 0) {
    throw new DropEntriesError(
      DROP_ENTRIES_ERROR.partialCapture,
      'The browser could not read every dropped item, so nothing was imported.',
    )
  }
  if (capture.entries.length === 0) {
    if (capture.fallbackFiles.length > maxEntries) {
      throw new DropEntriesError(
        DROP_ENTRIES_ERROR.tooManyEntries,
        `The drop contains more than ${maxEntries} entries.`,
      )
    }
    const hasAmbiguousPlaceholder = capture.fallbackFiles.some(
      (file) =>
        file.size === 0 &&
        file.type === '' &&
        !isImportTextPath(file.name) &&
        !ZIP_EXT.test(file.name),
    )
    const hasIncompleteFallback = capture.fallbackFiles.length !== capture.fileItemCount

    if (capture.fileItemCount > 0 && (hasIncompleteFallback || hasAmbiguousPlaceholder)) {
      throw new DropEntriesError(
        DROP_ENTRIES_ERROR.capabilityUnavailable,
        'This browser could not fully read the dropped items.',
      )
    }

    return {
      files: capture.fallbackFiles.map((file) => ({ file, relativePath: file.name })),
      hadDirectory: false,
      topLevelCount: capture.fallbackFiles.length,
      topLevelNames: capture.fallbackFiles.map((file) => file.name),
    }
  }

  const stack: StackEntry[] = capture.entries.map((entry) => ({
    entry,
    relativePath: entry.name,
  }))
  const files: Array<ImportTreeEntry & { ordinal: number }> = []
  const hadDirectory = capture.entries.some((entry) => entry.isDirectory)
  let discovered = 0
  let ordinal = 0

  try {
    while (stack.length > 0) {
      const current = stack.pop()!

      if (++discovered > maxEntries) {
        throw new DropEntriesError(
          DROP_ENTRIES_ERROR.tooManyEntries,
          `The drop contains more than ${maxEntries} entries.`,
        )
      }
      if (current.entry.isDirectory) {
        const reader = (current.entry as FileSystemDirectoryEntry).createReader()

        for (;;) {
          const page = await readDirectoryPage(reader)

          if (page.length === 0) {
            break
          }
          for (const child of page) {
            stack.push({
              entry: child,
              relativePath: `${current.relativePath}/${child.name}`,
            })
          }
        }
      } else if (current.entry.isFile) {
        files.push({
          file: await readFileEntry(current.entry as FileSystemFileEntry),
          relativePath: current.relativePath,
          ordinal: ordinal++,
        })
      }
    }
  } catch (error) {
    if (error instanceof DropEntriesError) {
      throw error
    }
    throw new DropEntriesError(
      DROP_ENTRIES_ERROR.readFailed,
      'The browser could not read the complete dropped folder.',
      { cause: error },
    )
  }

  files.sort((a, b) => {
    const byPath = a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0

    return byPath || a.ordinal - b.ordinal
  })

  return {
    files: files.map(({ file, relativePath }) => ({ file, relativePath })),
    hadDirectory,
    topLevelCount: capture.entries.length,
    topLevelNames: capture.entries.map((entry) => entry.name),
  }
}

/** Apply the drop routing matrix after the browser tree has been captured in full. */
export const prepareDrop = (drop: ExpandedDrop): PreparedDrop => {
  const topLevelZip = drop.topLevelNames.some(
    (name) => ZIP_EXT.test(name) && drop.files.some((entry) => entry.relativePath === name),
  )

  if (topLevelZip) {
    if (
      drop.hadDirectory ||
      drop.topLevelCount !== 1 ||
      drop.files.length !== 1 ||
      !ZIP_EXT.test(drop.files[0].relativePath)
    ) {
      throw new DropEntriesError(
        DROP_ENTRIES_ERROR.mixedArchive,
        'A ZIP archive must be dropped on its own, so nothing was imported.',
      )
    }

    return { source: { kind: 'file', file: drop.files[0].file }, openSingleText: false }
  }

  const textEntries = drop.files.filter((entry) => isImportTextPath(entry.relativePath))

  if (textEntries.length === 0) {
    const source = drop.hadDirectory
      ? 'dropped folder'
      : drop.topLevelCount === 1
        ? 'dropped file'
        : 'dropped selection'

    throw new DropEntriesError(
      DROP_ENTRIES_ERROR.unsupportedOnly,
      `Only Markdown and text files can be imported from the ${source}.`,
    )
  }
  if (!drop.hadDirectory && drop.topLevelCount === 1 && drop.files.length === 1) {
    return {
      source: { kind: 'file', file: drop.files[0].file },
      openSingleText: true,
    }
  }

  return {
    source: { kind: 'tree', entries: drop.files },
    openSingleText: false,
  }
}
