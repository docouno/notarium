import type {
  BoardMoveRequest,
  DraftViewQueryResponse,
  ViewGroup,
  ViewManifestResponse,
  ViewRow,
  ViewWindowResponse,
} from '@notarium/contract'

export type ColumnWindow = {
  rows: ViewRow[]
  total: number
  loading: boolean
  loaded: boolean
  error: string | null
  generation: number
  revision: number
  extent: number
}

export type LocalMove = {
  windows: Record<string, ColumnWindow>
  sourceKey?: string
  moved: boolean
  rollback?: {
    sourceKey: string
    destinationKey: string
    row: ViewRow
    beforeId?: string
    afterId?: string
    revisions: Readonly<Record<string, number | undefined>>
    extents: Readonly<Record<string, number>>
  }
}

export const moveRowLocally = (
  current: Record<string, ColumnWindow>,
  cardId: string,
  destinationKey: string,
  target: { beforeId?: string; afterId?: string },
  sourceKeys?: ReadonlySet<string>,
): LocalMove => {
  let sourceKey: string | undefined
  let row: ViewRow | undefined

  for (const [key, state] of Object.entries(current)) {
    if (sourceKeys && !sourceKeys.has(key)) {
      continue
    }
    const found = state.rows.find((candidate) => candidate.id === cardId)

    if (found) {
      sourceKey = key
      row = found
      break
    }
  }
  if (!sourceKey || !row) {
    return { windows: current, moved: false }
  }
  const next = { ...current }
  const source = current[sourceKey]!
  const sourceIndex = source.rows.findIndex((candidate) => candidate.id === cardId)
  const beforeId = source.rows[sourceIndex + 1]?.id
  const afterId = source.rows[sourceIndex - 1]?.id
  const sourceRows = source.rows.filter((candidate) => candidate.id !== cardId)

  next[sourceKey] = {
    ...source,
    rows: sourceRows,
    total: sourceKey === destinationKey ? source.total : Math.max(0, source.total - 1),
  }
  const destination = next[destinationKey] ?? {
    rows: [],
    total: 0,
    loading: false,
    loaded: false,
    error: null,
    generation: 0,
    revision: 0,
    extent: 0,
  }
  const destinationRows = destination.rows.filter((candidate) => candidate.id !== cardId)
  const beforeIndex = target.beforeId
    ? destinationRows.findIndex((candidate) => candidate.id === target.beforeId)
    : -1
  const afterIndex = target.afterId
    ? destinationRows.findIndex((candidate) => candidate.id === target.afterId)
    : -1
  const insertAt =
    beforeIndex >= 0 ? beforeIndex : afterIndex >= 0 ? afterIndex + 1 : destinationRows.length

  destinationRows.splice(insertAt, 0, row)
  next[destinationKey] = {
    ...destination,
    rows: destinationRows,
    total: sourceKey === destinationKey ? destination.total : destination.total + 1,
    extent: Math.max(destination.extent, destinationRows.length),
  }

  return {
    windows: next,
    sourceKey,
    moved: true,
    rollback: {
      sourceKey,
      destinationKey,
      row,
      beforeId,
      afterId,
      revisions: {
        [sourceKey]: source.revision,
        [destinationKey]: current[destinationKey]?.revision ?? 0,
      },
      extents: {
        [sourceKey]: source.extent,
        [destinationKey]: current[destinationKey]?.extent ?? 0,
      },
    },
  }
}

export const rollbackLocalMove = (
  current: Record<string, ColumnWindow>,
  rollback: NonNullable<LocalMove['rollback']>,
): Record<string, ColumnWindow> => {
  const next = { ...current }
  const source = current[rollback.sourceKey]
  const destination = current[rollback.destinationKey]
  const sourceFresh = source?.revision !== rollback.revisions[rollback.sourceKey]
  const destinationFresh = destination?.revision !== rollback.revisions[rollback.destinationKey]

  if (rollback.sourceKey === rollback.destinationKey) {
    if (!source || sourceFresh) {
      return current
    }
    const rows = source.rows.filter((row) => row.id !== rollback.row.id)
    const beforeIndex = rollback.beforeId
      ? rows.findIndex((row) => row.id === rollback.beforeId)
      : -1
    const afterIndex = rollback.afterId ? rows.findIndex((row) => row.id === rollback.afterId) : -1
    const index = beforeIndex >= 0 ? beforeIndex : afterIndex >= 0 ? afterIndex + 1 : 0

    rows.splice(index, 0, rollback.row)
    next[rollback.sourceKey] = { ...source, rows }
    return next
  }

  if (destination && !destinationFresh) {
    const hadCard = destination.rows.some((row) => row.id === rollback.row.id)

    next[rollback.destinationKey] = {
      ...destination,
      rows: destination.rows.filter((row) => row.id !== rollback.row.id),
      total: hadCard ? Math.max(0, destination.total - 1) : destination.total,
      extent: rollback.extents[rollback.destinationKey]!,
    }
  }
  if (source && !sourceFresh && !source.rows.some((row) => row.id === rollback.row.id)) {
    const rows = [...source.rows]
    const beforeIndex = rollback.beforeId
      ? rows.findIndex((row) => row.id === rollback.beforeId)
      : -1
    const afterIndex = rollback.afterId ? rows.findIndex((row) => row.id === rollback.afterId) : -1
    const index = beforeIndex >= 0 ? beforeIndex : afterIndex >= 0 ? afterIndex + 1 : rows.length

    rows.splice(index, 0, rollback.row)
    next[rollback.sourceKey] = {
      ...source,
      rows,
      total: source.total + 1,
      extent: rollback.extents[rollback.sourceKey]!,
    }
  }

  return next
}

export const planWindowRanges = (
  offset: number,
  currentRows: number,
  reconcileLoaded: boolean,
): Array<{ offset: number; limit: number }> => {
  if (!reconcileLoaded) {
    return [{ offset, limit: 50 }]
  }
  const retained = Math.max(50, currentRows)

  return Array.from({ length: Math.max(1, Math.ceil(retained / 100)) }, (_, index) => ({
    offset: index * 100,
    limit: Math.min(100, retained - index * 100),
  }))
}

export const sameWindowVersion = (
  manifest: ViewManifestResponse['views'][number] | undefined,
  response: ViewWindowResponse | DraftViewQueryResponse,
): boolean =>
  !manifest?.snapshotGeneration ||
  (response.snapshotGeneration === manifest.snapshotGeneration &&
    response.schemaVersionToken === manifest.schemaVersionToken)

export const destinationFor = (group: ViewGroup): BoardMoveRequest['to'] | null => {
  if (group.state === 'absent') {
    return { kind: 'absent' }
  }
  if (
    (group.state === 'value' || group.state === 'empty-string') &&
    typeof group.value === 'string'
  ) {
    return { kind: 'value', value: group.value }
  }

  return null
}

export const groupName = (group: ViewGroup): string =>
  String(group.label ?? group.value ?? (group.state === 'absent' ? 'No value' : 'Empty'))

const abortError = (): DOMException => new DOMException('window load aborted', 'AbortError')

export type WindowSemaphore = {
  run: <T>(task: () => Promise<T>, signal: AbortSignal) => Promise<T>
}

export const createWindowSemaphore = (limit: number): WindowSemaphore => {
  let active = 0
  const queue: Array<{
    signal: AbortSignal
    cancelled: boolean
    resolve: (release: () => void) => void
    reject: (cause: DOMException) => void
    onAbort: () => void
  }> = []

  const drain = () => {
    while (active < limit && queue.length > 0) {
      const entry = queue.shift()!

      if (entry.cancelled || entry.signal.aborted) {
        entry.signal.removeEventListener('abort', entry.onAbort)
        continue
      }
      active++
      entry.signal.removeEventListener('abort', entry.onAbort)
      let released = false

      entry.resolve(() => {
        if (released) {
          return
        }
        released = true
        active--
        drain()
      })
    }
  }

  const acquire = (signal: AbortSignal): Promise<() => void> => {
    if (signal.aborted) {
      return Promise.reject(abortError())
    }

    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        cancelled: false,
        resolve,
        reject,
        onAbort: () => {
          entry.cancelled = true
          reject(abortError())
        },
      }

      signal.addEventListener('abort', entry.onAbort, { once: true })
      queue.push(entry)
      drain()
    })
  }

  return {
    run: async <T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> => {
      const release = await acquire(signal)

      if (signal.aborted) {
        release()
        throw abortError()
      }
      try {
        return await task()
      } finally {
        release()
      }
    },
  }
}
