import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { FieldDeclaration, FieldSchemaResponse } from '@notarium/contract'

import { api } from '../../services/api'
import { useSpace } from '../SpaceProvider'

type CachedSchema = {
  snapshot: FieldSchemaResponse
}

export type FieldSchemaContextValue = {
  space: string
  cacheEpoch: number
  fields: FieldDeclaration[]
  byKey: ReadonlyMap<string, FieldDeclaration>
  loading: boolean
  error: string | null
  readOnly: boolean
  valueWrites: boolean
  /** Opaque schema revision. FeedProvider includes it in its query identity so
   * a successful schema PUT invalidates card-field projections. */
  revision: string
  reload: () => Promise<FieldSchemaResponse | undefined>
  update: (fields: FieldDeclaration[], versionToken: string) => Promise<FieldSchemaResponse>
  snapshotFor: (space: string) => FieldSchemaResponse | undefined
  reloadSpace: (space: string) => Promise<FieldSchemaResponse | undefined>
  observeSpace: (space: string) => () => void
}

const FieldSchemaContext = createContext<FieldSchemaContextValue | null>(null)

export const useFieldSchema = (): FieldSchemaContextValue => {
  const value = useContext(FieldSchemaContext)

  if (!value) {
    throw new Error('useFieldSchema must be used within FieldSchemaProvider')
  }

  return value
}

export type FieldSchemaView = Pick<
  FieldSchemaContextValue,
  'fields' | 'byKey' | 'loading' | 'error' | 'readOnly' | 'valueWrites' | 'revision' | 'reload'
>

export const useFieldSchemaForSpace = (space: string): FieldSchemaView => {
  const active = useFieldSchema()
  const { space: activeSpace, reloadSpace, snapshotFor, observeSpace } = active
  const snapshot = snapshotFor(space)

  useEffect(() => {
    const release = observeSpace(space)

    if (space !== activeSpace) {
      void reloadSpace(space)
    }

    return release
  }, [activeSpace, observeSpace, reloadSpace, space])

  const byKey = useMemo(
    () => new Map((snapshot?.fields ?? []).map((field) => [field.key, field])),
    [snapshot],
  )

  return space === activeSpace
    ? active
    : {
        fields: snapshot?.fields ?? [],
        byKey,
        loading: snapshot === undefined,
        error: snapshot?.error ?? null,
        readOnly: snapshot?.readOnly === true,
        valueWrites: snapshot?.valueWrites === true,
        revision: snapshot?.versionToken ?? 'loading',
        reload: () => reloadSpace(space),
      }
}

const empty = (): CachedSchema => ({
  snapshot: { version: 1, fields: [], versionToken: 'loading', valueWrites: false },
})

export const FieldSchemaProvider = ({ children }: { children: ReactNode }) => {
  const { space } = useSpace()
  const cache = useRef(new Map<string, CachedSchema>())
  const requestSeq = useRef(new Map<string, number>())
  const writeEpoch = useRef(new Map<string, number>())
  const activeWrite = useRef(new Map<string, number>())
  const inFlightReads = useRef(new Map<string, Promise<FieldSchemaResponse | undefined>>())
  const invalidatedReads = useRef(new Set<string>())
  const observedSpaces = useRef(new Map<string, number>())
  const loadingSpaces = useRef(new Set<string>())
  const broadcast = useRef<BroadcastChannel | null>(null)
  const [cacheRevision, setCacheRevision] = useState(0)
  const refresh = useCallback(() => setCacheRevision((revision) => revision + 1), [])

  const accept = useCallback(
    (targetSpace: string, snapshot: FieldSchemaResponse): CachedSchema => {
      const next = { snapshot }

      cache.current.set(targetSpace, next)
      refresh()

      return next
    },
    [refresh],
  )

  const reloadSpace = useCallback(
    (targetSpace: string): Promise<FieldSchemaResponse | undefined> => {
      const pending = inFlightReads.current.get(targetSpace)

      if (pending) {
        return pending
      }
      const run = async () => {
        const seq = (requestSeq.current.get(targetSpace) ?? 0) + 1
        const startedWriteEpoch = writeEpoch.current.get(targetSpace) ?? 0
        requestSeq.current.set(targetSpace, seq)
        loadingSpaces.current.add(targetSpace)
        refresh()
        try {
          const snapshot = await api.fieldSchemaGet(targetSpace)

          if (
            seq === requestSeq.current.get(targetSpace) &&
            startedWriteEpoch === (writeEpoch.current.get(targetSpace) ?? 0) &&
            !activeWrite.current.has(targetSpace)
          ) {
            accept(targetSpace, snapshot)
            return snapshot
          }
        } catch (cause) {
          if (
            seq === requestSeq.current.get(targetSpace) &&
            startedWriteEpoch === (writeEpoch.current.get(targetSpace) ?? 0) &&
            !activeWrite.current.has(targetSpace)
          ) {
            const previous = cache.current.get(targetSpace)?.snapshot ?? empty().snapshot
            accept(targetSpace, {
              ...previous,
              valueWrites: false,
              readOnly: true,
              error: (cause as Error).message || 'Could not load field schema',
            })
          }

          return undefined
        } finally {
          if (seq === requestSeq.current.get(targetSpace)) {
            loadingSpaces.current.delete(targetSpace)
            refresh()
          }
        }
      }
      const task = run()

      inFlightReads.current.set(targetSpace, task)
      void task.finally(() => {
        if (inFlightReads.current.get(targetSpace) === task) {
          inFlightReads.current.delete(targetSpace)
        }
      })
      return task
    },
    [accept, refresh],
  )
  const invalidateSpace = useCallback(
    (targetSpace: string): Promise<FieldSchemaResponse | undefined> => {
      requestSeq.current.set(targetSpace, (requestSeq.current.get(targetSpace) ?? 0) + 1)
      const pending = inFlightReads.current.get(targetSpace)

      if (!pending) {
        return reloadSpace(targetSpace)
      }
      invalidatedReads.current.add(targetSpace)
      return pending.then(() => {
        if (!invalidatedReads.current.delete(targetSpace)) {
          return cache.current.get(targetSpace)?.snapshot
        }

        return reloadSpace(targetSpace)
      })
    },
    [reloadSpace],
  )
  const reload = useCallback(() => invalidateSpace(space), [invalidateSpace, space])
  const snapshotFor = useCallback(
    (targetSpace: string) => cache.current.get(targetSpace)?.snapshot,
    [],
  )
  const observeSpace = useCallback((targetSpace: string) => {
    observedSpaces.current.set(targetSpace, (observedSpaces.current.get(targetSpace) ?? 0) + 1)
    return () => {
      const next = (observedSpaces.current.get(targetSpace) ?? 1) - 1

      if (next > 0) {
        observedSpaces.current.set(targetSpace, next)
      } else {
        observedSpaces.current.delete(targetSpace)
      }
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [space, reload])

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') {
      return undefined
    }
    const channel = new BroadcastChannel('notarium-field-schema')
    broadcast.current = channel
    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        void invalidateSpace(event.data)
      }
    }

    return () => {
      broadcast.current = null
      channel.close()
    }
  }, [invalidateSpace])

  useEffect(() => {
    const refreshObserved = () => {
      for (const targetSpace of new Set([space, ...observedSpaces.current.keys()])) {
        void invalidateSpace(targetSpace)
      }
    }
    const interval = window.setInterval(refreshObserved, 60_000)

    window.addEventListener('focus', refreshObserved)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshObserved)
    }
  }, [invalidateSpace, space])

  const update = useCallback(
    async (fields: FieldDeclaration[], versionToken: string) => {
      // A write supersedes every read that started from the older revision. Use
      // the same per-space generation for both verbs so a late GET cannot paint
      // stale server truth over an acknowledged PUT.
      const operation = (writeEpoch.current.get(space) ?? 0) + 1
      writeEpoch.current.set(space, operation)
      activeWrite.current.set(space, operation)
      requestSeq.current.set(space, (requestSeq.current.get(space) ?? 0) + 1)
      try {
        const snapshot = await api.fieldSchemaPut(space, {
          version: 1,
          fields,
          versionToken,
        })

        if (activeWrite.current.get(space) === operation) {
          activeWrite.current.delete(space)
          writeEpoch.current.set(space, operation + 1)
          requestSeq.current.set(space, (requestSeq.current.get(space) ?? 0) + 1)
          accept(space, snapshot)
          broadcast.current?.postMessage(space)
        }

        return snapshot
      } catch (cause) {
        // Refresh shared readers with server truth, but do not choose the writer's
        // expected token here: its draft stays pinned until the caller explicitly adopts.
        if (activeWrite.current.get(space) === operation) {
          activeWrite.current.delete(space)
          writeEpoch.current.set(space, operation + 1)
          requestSeq.current.set(space, (requestSeq.current.get(space) ?? 0) + 1)
          await invalidateSpace(space)
        }
        throw cause
      }
    },
    [accept, invalidateSpace, space],
  )

  const current = cache.current.get(space) ?? empty()
  const loading = !cache.current.has(space) || loadingSpaces.current.has(space)
  const error = current.snapshot.error ?? null
  const byKey = useMemo(
    () => new Map(current.snapshot.fields.map((field) => [field.key, field])),
    [current.snapshot.fields],
  )
  const value = useMemo<FieldSchemaContextValue>(
    () => ({
      space,
      cacheEpoch: cacheRevision,
      fields: current.snapshot.fields,
      byKey,
      loading,
      error,
      readOnly: current.snapshot.readOnly === true,
      valueWrites: current.snapshot.valueWrites,
      revision: current.snapshot.versionToken,
      reload,
      update,
      snapshotFor,
      reloadSpace: invalidateSpace,
      observeSpace,
    }),
    [
      byKey,
      cacheRevision,
      current,
      error,
      loading,
      reload,
      invalidateSpace,
      observeSpace,
      snapshotFor,
      space,
      update,
    ],
  )

  return <FieldSchemaContext.Provider value={value}>{children}</FieldSchemaContext.Provider>
}
