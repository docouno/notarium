import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ViewGroup } from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { decodeViewRef } from '@notarium/core'

import { EmptyState } from '../../core/EmptyState'
import { Notice } from '../../core/Notice'
import { api, ApiError } from '../../services/api'
import { Board, BoardColumn, boardDropDecision, BoardLoadingSkeleton } from '../../widgets/Board'
import type { ViewReaderComponentProps } from '../ViewRuntime'
import {
  type ColumnWindow,
  createWindowSemaphore,
  destinationFor,
  groupName,
  moveRowLocally,
  planWindowRanges,
  rollbackLocalMove,
  sameWindowVersion,
} from './helpers'
import styles from './BoardView.module.scss'

// canon: docs/views.md#board

const BOARD_WINDOW_CONCURRENCY = 4
const WINDOW_CONFLICT_MESSAGE = 'Board snapshot changed. Waiting for a fresh manifest.'

const manifestFenceKey = (epoch: number, manifest: ViewReaderComponentProps['manifest']): string =>
  `${epoch}:${manifest?.snapshotGeneration ?? ''}:${manifest?.schemaVersionToken ?? ''}`

type KeyboardMove = {
  cardId: string
  sourceGroupKey: string
  groupKey: string
  gap: number
  height: number
}

export const BoardView = ({
  view,
  manifest,
  loading,
  error,
  loadWindow,
  mode,
  refresh,
}: ViewReaderComponentProps) => {
  const [windows, setWindows] = useState<Record<string, ColumnWindow>>({})
  const [countOverrides, setCountOverrides] = useState<Record<string, number>>({})
  const [keyboardMove, setKeyboardMove] = useState<KeyboardMove | null>(null)
  const [focusTarget, setFocusTarget] = useState<{ cardId: string; groupKey: string } | null>(null)
  const [busyCardId, setBusyCardId] = useState<string | null>(null)
  const [moveWarning, setMoveWarning] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const boardHost = useRef<HTMLDivElement>(null)
  const controllers = useRef(new Map<string, AbortController>())
  const semaphore = useRef(createWindowSemaphore(BOARD_WINDOW_CONCURRENCY))
  const loadGenerations = useRef(new Map<string, number>())
  const visibleRequested = useRef(new Set<string>())
  const latestOperation = useRef(0)
  const busyCard = useRef<string | null>(null)
  const keyboardMoveRef = useRef<KeyboardMove | null>(null)
  const pendingReconcileKeys = useRef<readonly string[] | null>(null)
  const conflictFence = useRef<string | null>(null)
  const windowsRef = useRef(windows)
  const countOverridesRef = useRef(countOverrides)
  const groupsRef = useRef<readonly ViewGroup[]>([])
  const manifestRef = useRef(manifest)
  const seenManifest = useRef<ViewReaderComponentProps['manifest']>()
  const documentId = decodeViewRef(manifest?.viewRef ?? view.viewRef ?? '')?.documentId ?? 'draft'
  const viewIdentity = `${documentId}:${view.block}:${view.occurrence}:${view.type}`
  const identity = useRef(viewIdentity)
  const identityEpoch = useRef(0)
  const manifestIdentity = useRef(manifest)
  const manifestEpoch = useRef(0)

  if (identity.current !== viewIdentity) {
    identity.current = viewIdentity
    identityEpoch.current++
  }
  if (manifestIdentity.current !== manifest) {
    manifestIdentity.current = manifest
    manifestEpoch.current++
  }

  useEffect(() => {
    windowsRef.current = windows
  }, [windows])
  useEffect(() => {
    countOverridesRef.current = countOverrides
  }, [countOverrides])
  manifestRef.current = manifest

  useLayoutEffect(() => {
    const hadKeyboardMove = keyboardMoveRef.current != null

    for (const controller of controllers.current.values()) {
      controller.abort()
    }
    controllers.current.clear()
    loadGenerations.current.clear()
    visibleRequested.current.clear()
    seenManifest.current = undefined
    pendingReconcileKeys.current = null
    conflictFence.current = null
    latestOperation.current++
    busyCard.current = null
    keyboardMoveRef.current = null
    windowsRef.current = {}
    countOverridesRef.current = {}
    groupsRef.current = []
    setWindows({})
    setCountOverrides({})
    setKeyboardMove(null)
    setFocusTarget(null)
    setBusyCardId(null)
    setMoveWarning(null)
    setAnnouncement('')
    if (hadKeyboardMove) {
      boardHost.current?.focus()
    }
  }, [viewIdentity])
  useLayoutEffect(() => {
    latestOperation.current++
    busyCard.current = null
    setBusyCardId(null)
    setMoveWarning(null)
    setFocusTarget(null)
  }, [manifest?.viewRef])
  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) {
        controller.abort()
      }
    },
    [],
  )

  const load = useCallback(
    (group: ViewGroup, offset = 0, reconcileLoaded = false) => {
      const controller = new AbortController()
      const epoch = identityEpoch.current
      const requestManifestEpoch = manifestEpoch.current
      const expectedManifest = manifestRef.current
      const versionKey = manifestFenceKey(epoch, expectedManifest)
      const generation = (loadGenerations.current.get(group.key) ?? 0) + 1
      const currentState = windowsRef.current[group.key]
      const retainedExtent = currentState?.extent ?? currentState?.rows.length ?? 0
      const ranges = planWindowRanges(offset, retainedExtent, reconcileLoaded)

      controllers.current.get(group.key)?.abort()
      controllers.current.set(group.key, controller)
      loadGenerations.current.set(group.key, generation)
      setWindows((current) => {
        if (epoch !== identityEpoch.current || requestManifestEpoch !== manifestEpoch.current) {
          return current
        }
        const next = {
          ...current,
          [group.key]: {
            rows: current[group.key]?.rows ?? [],
            total: current[group.key]?.total ?? group.count,
            loading: true,
            loaded: current[group.key]?.loaded ?? false,
            error: null,
            generation,
            revision: current[group.key]?.revision ?? 0,
            extent: current[group.key]?.extent ?? current[group.key]?.rows.length ?? 0,
          },
        }

        windowsRef.current = next
        return next
      })
      const currentRequest = () =>
        epoch === identityEpoch.current &&
        requestManifestEpoch === manifestEpoch.current &&
        loadGenerations.current.get(group.key) === generation &&
        manifestFenceKey(epoch, manifestRef.current) === versionKey

      const markConflict = () => {
        if (!currentRequest()) {
          return
        }
        setWindows((current) => {
          const state = current[group.key]

          if (
            !state ||
            state.generation !== generation ||
            epoch !== identityEpoch.current ||
            requestManifestEpoch !== manifestEpoch.current
          ) {
            return current
          }
          const next = {
            ...current,
            [group.key]: { ...state, loading: false, error: WINDOW_CONFLICT_MESSAGE },
          }

          windowsRef.current = next
          return next
        })
        if (conflictFence.current !== versionKey) {
          conflictFence.current = versionKey
          refresh()
        }
      }

      void Promise.all(
        ranges.map((range) =>
          semaphore.current.run(
            () => loadWindow({ group: group.key, ...range, signal: controller.signal }),
            controller.signal,
          ),
        ),
      )
        .then((responses) => {
          if (!currentRequest()) {
            return
          }
          if (responses.some((response) => !sameWindowVersion(expectedManifest, response))) {
            markConflict()
            return
          }
          setWindows((current) => {
            const state = current[group.key]

            if (
              !state ||
              state.generation !== generation ||
              epoch !== identityEpoch.current ||
              requestManifestEpoch !== manifestEpoch.current
            ) {
              return current
            }
            const response = responses[0]!
            const rows = reconcileLoaded
              ? responses.flatMap((item) => item.rows)
              : offset === 0
                ? response.rows
                : [...state.rows.slice(0, offset), ...response.rows]
            const next = {
              ...current,
              [group.key]: {
                ...state,
                rows,
                total: response.total,
                loading: false,
                loaded: true,
                error: null,
                revision: state.revision + 1,
                extent: reconcileLoaded
                  ? rows.length
                  : offset === 0
                    ? response.rows.length
                    : Math.max(state.extent, offset + response.rows.length),
              },
            }

            if (conflictFence.current === versionKey) {
              conflictFence.current = null
            }
            windowsRef.current = next
            return next
          })
        })
        .catch((cause) => {
          if (
            controller.signal.aborted ||
            epoch !== identityEpoch.current ||
            requestManifestEpoch !== manifestEpoch.current
          ) {
            return
          }
          const generationConflict =
            cause instanceof ApiError && cause.status === HTTP_STATUS.CONFLICT

          if (generationConflict) {
            markConflict()
            controller.abort()
            return
          }
          setWindows((current) => {
            const state = current[group.key]

            if (
              !state ||
              state.generation !== generation ||
              epoch !== identityEpoch.current ||
              requestManifestEpoch !== manifestEpoch.current
            ) {
              return current
            }
            const next = {
              ...current,
              [group.key]: {
                ...state,
                loading: false,
                error: (cause as Error).message,
              },
            }

            windowsRef.current = next
            return next
          })
          controller.abort()
        })
        .finally(() => {
          if (controllers.current.get(group.key) === controller) {
            controllers.current.delete(group.key)
          }
        })
    },
    [loadWindow, refresh],
  )
  const groups = useMemo(
    () =>
      (manifest?.groups ?? []).map((group) =>
        countOverrides[group.key] === undefined
          ? group
          : { ...group, count: countOverrides[group.key]! },
      ),
    [countOverrides, manifest?.groups],
  )
  groupsRef.current = groups
  useEffect(() => {
    if (!manifest || manifest === seenManifest.current) {
      return
    }
    const previous = seenManifest.current
    const refreshLoaded = previous != null
    const versionKey = manifestFenceKey(identityEpoch.current, manifest)

    seenManifest.current = manifest
    if (conflictFence.current && conflictFence.current !== versionKey) {
      conflictFence.current = null
    }
    countOverridesRef.current = {}
    setCountOverrides({})
    const manifestKeys = new Set((manifest.groups ?? []).map((group) => group.key))

    for (const [key, controller] of controllers.current) {
      if (!manifestKeys.has(key)) {
        controller.abort()
        controllers.current.delete(key)
      }
    }
    for (const key of loadGenerations.current.keys()) {
      if (!manifestKeys.has(key)) {
        loadGenerations.current.delete(key)
      }
    }
    for (const key of visibleRequested.current) {
      if (!manifestKeys.has(key)) {
        visibleRequested.current.delete(key)
      }
    }
    const retainedWindows = Object.fromEntries(
      Object.entries(windowsRef.current).filter(([key]) => manifestKeys.has(key)),
    )

    if (Object.keys(retainedWindows).length !== Object.keys(windowsRef.current).length) {
      windowsRef.current = retainedWindows
      setWindows(retainedWindows)
    }
    const keys =
      pendingReconcileKeys.current?.filter((key) => manifestKeys.has(key)) ??
      (refreshLoaded ? Object.keys(retainedWindows) : [])

    pendingReconcileKeys.current = null
    if (conflictFence.current === versionKey) {
      return
    }
    for (const key of new Set(keys)) {
      const group = manifest.groups?.find((candidate) => candidate.key === key)

      if (group) {
        load(group, 0, true)
      }
    }
  }, [load, manifest])
  const groupKeys = useMemo(() => new Set(groups.map((group) => group.key)), [groups])
  const moveGroups = useMemo(() => groups.filter((group) => destinationFor(group)), [groups])
  const moveGroupKeys = useMemo(() => new Set(moveGroups.map((group) => group.key)), [moveGroups])
  const writable =
    mode === 'current-writer' &&
    manifest?.status === 'ready' &&
    !manifest.groupsTruncated &&
    Boolean(manifest.viewRef) &&
    manifest.capabilities?.move === true
  useLayoutEffect(() => {
    const activeMove = keyboardMoveRef.current

    if (!activeMove) {
      return
    }
    const cardLocation = Object.entries(windowsRef.current).find(([, state]) =>
      state.rows.some((row) => row.id === activeMove.cardId),
    )
    const renderedCardLocation =
      cardLocation && groups.some((group) => group.key === cardLocation[0])
        ? cardLocation
        : undefined
    const sourceExists = groups.some((group) => group.key === activeMove.sourceGroupKey)
    const targetExists = groups.some((group) => group.key === activeMove.groupKey)

    if (writable && renderedCardLocation && sourceExists && targetExists) {
      return
    }
    keyboardMoveRef.current = null
    setKeyboardMove(null)
    setAnnouncement('Card move cancelled because the board changed.')
    if (writable) {
      const fallback =
        renderedCardLocation ??
        Object.entries(windowsRef.current).find(
          ([key, state]) => groups.some((group) => group.key === key) && state.rows.length > 0,
        )
      const cardId = renderedCardLocation ? activeMove.cardId : fallback?.[1].rows[0]?.id

      setFocusTarget(cardId && fallback ? { cardId, groupKey: fallback[0] } : null)
    } else {
      setFocusTarget(null)
      boardHost.current?.focus()
    }
  }, [groups, windows, writable])
  const onVisible = useCallback(
    (key: string) => {
      const group = groupsRef.current.find((candidate) => candidate.key === key)
      const state = windowsRef.current[key]

      if (group && !visibleRequested.current.has(key) && !state?.loading && !state?.loaded) {
        visibleRequested.current.add(key)
        load(group)
      }
    },
    [load],
  )
  const moveCard = useCallback(
    (
      cardId: string,
      group: ViewGroup,
      target: { beforeId?: string; afterId?: string },
      options?: { restoreFocusKey?: string },
    ) => {
      const to = destinationFor(group)
      const viewRef = manifest?.viewRef

      if (!writable || !to || !viewRef || busyCard.current) {
        return
      }
      const decision = { ...target }

      if (!decision.beforeId && !decision.afterId) {
        const last = [...(windowsRef.current[group.key]?.rows ?? [])]
          .reverse()
          .find((row) => row.id !== cardId)

        if (last) {
          decision.afterId = last.id
        }
      }
      const operation = ++latestOperation.current
      const operationEpoch = identityEpoch.current
      const operationViewRef = viewRef
      const beforeWindows = windowsRef.current
      const beforeCounts = countOverridesRef.current
      const optimistic = moveRowLocally(beforeWindows, cardId, group.key, decision, groupKeys)
      let optimisticCounts = beforeCounts
      const reconcileKeys = [optimistic.sourceKey, group.key].filter((key): key is string =>
        Boolean(key),
      )

      if (optimistic.moved) {
        windowsRef.current = optimistic.windows
        setWindows(optimistic.windows)
        if (optimistic.sourceKey && optimistic.sourceKey !== group.key) {
          const currentGroups = groupsRef.current
          const source = currentGroups.find((candidate) => candidate.key === optimistic.sourceKey)
          const destination = currentGroups.find((candidate) => candidate.key === group.key)
          optimisticCounts = {
            ...beforeCounts,
            ...(source ? { [source.key]: Math.max(0, source.count - 1) } : {}),
            ...(destination ? { [destination.key]: destination.count + 1 } : {}),
          }

          countOverridesRef.current = optimisticCounts
          setCountOverrides(optimisticCounts)
        }
      }

      const rollback = () => {
        if (optimistic.rollback) {
          setWindows((current) => {
            const next = rollbackLocalMove(current, optimistic.rollback!)

            windowsRef.current = next
            return next
          })
        }
        if (countOverridesRef.current === optimisticCounts) {
          countOverridesRef.current = beforeCounts
          setCountOverrides(beforeCounts)
        }
      }

      busyCard.current = cardId
      setBusyCardId(cardId)
      setMoveWarning(null)
      setAnnouncement(`Moving card to ${groupName(group)}.`)
      void api
        .boardMove({ viewRef, cardId, to, ...decision })
        .then((result) => {
          if (
            operation !== latestOperation.current ||
            operationEpoch !== identityEpoch.current ||
            manifestRef.current?.viewRef !== operationViewRef
          ) {
            return
          }
          if (result.status === 'moved') {
            setAnnouncement(`Card moved to ${groupName(group)}.`)
          } else if (result.status === 'moved-unranked') {
            setMoveWarning(
              `Card moved to ${groupName(group)}, but its manual position could not be saved. It is shown in fallback order.`,
            )
            setAnnouncement(`Card moved to ${groupName(group)} with fallback order.`)
          } else if (result.status === 'moved-partial') {
            const value = result.fieldEffect.value ?? 'no value'

            setMoveWarning(
              `Field ${result.fieldEffect.key} was changed to ${value}, but current board membership could not be confirmed.`,
            )
            setAnnouncement('The field changed, but the current board result is uncertain.')
          } else {
            rollback()
            if (options?.restoreFocusKey) {
              setFocusTarget({ cardId, groupKey: options.restoreFocusKey })
            }
            setAnnouncement('Card position is unchanged.')
          }
          pendingReconcileKeys.current = reconcileKeys
          refresh()
        })
        .catch((cause) => {
          if (
            operation === latestOperation.current &&
            operationEpoch === identityEpoch.current &&
            manifestRef.current?.viewRef === operationViewRef
          ) {
            const responseLost = cause instanceof TypeError && !(cause instanceof ApiError)

            if (!responseLost) {
              rollback()
              if (options?.restoreFocusKey) {
                setFocusTarget({ cardId, groupKey: options.restoreFocusKey })
              }
            }
            setMoveWarning(
              responseLost
                ? 'The move response was lost. Refreshing the affected columns from server truth.'
                : (cause as Error).message,
            )
            setAnnouncement(
              responseLost ? 'Move outcome is uncertain. Refreshing.' : 'Card move failed.',
            )
            pendingReconcileKeys.current = reconcileKeys
            refresh()
          }
        })
        .finally(() => {
          if (
            operation === latestOperation.current &&
            operationEpoch === identityEpoch.current &&
            manifestRef.current?.viewRef === operationViewRef
          ) {
            busyCard.current = null
            setBusyCardId(null)
          }
        })
    },
    [groupKeys, manifest, refresh, writable],
  )

  const onKeyboardCommand = useCallback(
    (cardId: string, key: string, element: HTMLElement) => {
      const normalized = key === 'Spacebar' ? ' ' : key
      const activeMove = keyboardMoveRef.current

      if (!activeMove) {
        if (normalized !== ' ' || !writable || busyCard.current) {
          return
        }
        const source = Object.entries(windowsRef.current).find(([, state]) =>
          state.rows.some((row) => row.id === cardId),
        )

        if (!source) {
          return
        }
        const sourceIndex = source[1].rows.findIndex((row) => row.id === cardId)
        const next: KeyboardMove = {
          cardId,
          sourceGroupKey: source[0],
          groupKey: source[0],
          gap: sourceIndex,
          height: element.getBoundingClientRect().height,
        }

        keyboardMoveRef.current = next
        setKeyboardMove(next)
        setAnnouncement(
          'Card move started. Use arrow keys to choose a column and position, Space to commit, or Escape to cancel.',
        )
        return
      }
      if (activeMove.cardId !== cardId) {
        return
      }
      if (normalized === 'Escape') {
        keyboardMoveRef.current = null
        setKeyboardMove(null)
        setAnnouncement('Card move cancelled.')
        return
      }
      if (normalized === ' ') {
        const group = moveGroups.find((candidate) => candidate.key === activeMove.groupKey)
        const state = windowsRef.current[activeMove.groupKey]

        if (group && state?.error) {
          setAnnouncement(`${groupName(group)} could not be loaded. Retry before moving the card.`)
          return
        }
        if (group && group.count > 0 && (!state?.loaded || state.loading)) {
          setAnnouncement(`Loading ${groupName(group)} before the card can be moved.`)
          return
        }
        const rows = windowsRef.current[activeMove.groupKey]?.rows ?? []
        const resolved = boardDropDecision(rows, cardId, activeMove.gap)

        keyboardMoveRef.current = null
        setKeyboardMove(null)
        if (group && resolved.kind === 'move') {
          setFocusTarget({ cardId, groupKey: group.key })
          moveCard(cardId, group, resolved.target, {
            restoreFocusKey: activeMove.sourceGroupKey,
          })
        } else {
          setAnnouncement('Card position is unchanged.')
        }

        return
      }
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(normalized)) {
        return
      }

      const horizontal = normalized === 'ArrowLeft' || normalized === 'ArrowRight'
      let group = groupsRef.current.find((candidate) => candidate.key === activeMove.groupKey)

      if (horizontal) {
        const direction = normalized === 'ArrowLeft' ? -1 : 1
        let groupIndex = groupsRef.current.findIndex(
          (candidate) => candidate.key === activeMove.groupKey,
        )

        group = undefined
        while (groupIndex >= 0) {
          groupIndex += direction
          const candidate = groupsRef.current[groupIndex]

          if (!candidate) {
            break
          }
          if (moveGroupKeys.has(candidate.key)) {
            group = candidate
            break
          }
        }
      } else if (!group || !moveGroupKeys.has(group.key)) {
        setAnnouncement('Choose a writable column with Left or Right before positioning the card.')
        return
      }
      if (!group) {
        setAnnouncement('There is no writable column in that direction.')
        return
      }
      const state = windowsRef.current[group.key]
      const rows = state?.rows ?? []
      const gapCount = rows.filter((row) => row.id !== cardId).length + 1
      let gap = Math.min(activeMove.gap, gapCount - 1)

      if (normalized === 'ArrowUp') {
        gap = Math.max(0, gap - 1)
      } else if (normalized === 'ArrowDown') {
        gap = Math.min(gapCount - 1, gap + 1)
      }
      const next = { ...activeMove, groupKey: group.key, gap }

      keyboardMoveRef.current = next
      setKeyboardMove(next)
      if (horizontal) {
        const column = [
          ...(boardHost.current?.querySelectorAll<HTMLElement>('[data-group]') ?? []),
        ].find((candidate) => candidate.dataset.group === group.key)

        column?.scrollIntoView?.({ block: 'nearest', inline: 'start' })
        if (group.count > 0 && !state?.loaded && !state?.loading) {
          visibleRequested.current.add(group.key)
          load(group)
        }
      }
      setAnnouncement(
        group.count > 0 && (!state?.loaded || state.loading)
          ? `Loading ${groupName(group)} before the card can be moved.`
          : `${groupName(group)}, position ${gap + 1} of ${gapCount}.`,
      )
    },
    [load, moveCard, moveGroupKeys, moveGroups, writable],
  )
  const onCardFocused = useCallback(() => setFocusTarget(null), [])
  const onLoadMore = useCallback((group: ViewGroup, offset: number) => load(group, offset), [load])
  const onRetry = useCallback((group: ViewGroup) => load(group, 0, true), [load])

  if (!manifest && loading) {
    return <BoardLoadingSkeleton />
  }
  if (!manifest) {
    return <Notice variant="error">{error ?? 'Board manifest is unavailable.'}</Notice>
  }
  if (manifest.status === 'invalid' || manifest.status === 'unsupported') {
    return (
      <div ref={boardHost} role="region" aria-label="Board" tabIndex={-1} data-board>
        <Notice variant={manifest.status === 'invalid' ? 'error' : 'warning'}>
          {manifest.diagnostics?.[0] ??
            (manifest.status === 'invalid'
              ? 'Board data is unavailable.'
              : 'This board source is not installed.')}
        </Notice>
      </div>
    )
  }

  return (
    <div ref={boardHost} role="region" aria-label="Board" tabIndex={-1} data-board>
      <p className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {error ? <Notice variant="warning">{error}</Notice> : null}
      {moveWarning ? <Notice variant="warning">{moveWarning}</Notice> : null}
      {manifest.status === 'incomplete' ? (
        <Notice variant="warning">
          Some cards could not be resolved exactly. The board is read-only until refresh completes.
        </Notice>
      ) : null}
      {manifest.groupsTruncated ? (
        <Notice variant="warning">
          Showing {groups.length} of {manifest.totalGroups ?? groups.length} columns. Choose a
          lower-cardinality field for a complete board.
        </Notice>
      ) : null}
      {groups.length === 0 ? (
        <EmptyState title="No columns" hint="Choose a scalar grouping field with values." />
      ) : (
        <Board
          key={viewIdentity}
          groups={groups}
          onVisible={onVisible}
          renderColumn={(group, ref) => {
            const state = windows[group.key]

            return (
              <BoardColumn
                key={group.key}
                group={group}
                rows={state?.rows ?? []}
                total={state?.total ?? group.count}
                loading={state?.loading ?? false}
                error={state?.error ?? null}
                hostRef={ref}
                writable={writable}
                dropWritable={moveGroupKeys.has(group.key)}
                busyCardId={state?.rows.some((row) => row.id === busyCardId) ? busyCardId : null}
                onMove={moveCard}
                keyboardCardId={keyboardMove?.cardId}
                keyboardPlacement={
                  keyboardMove?.groupKey === group.key
                    ? {
                        cardId: keyboardMove.cardId,
                        gap: keyboardMove.gap,
                        height: keyboardMove.height,
                      }
                    : undefined
                }
                onKeyboardCommand={onKeyboardCommand}
                focusCardId={focusTarget?.groupKey === group.key ? focusTarget.cardId : null}
                onCardFocused={onCardFocused}
                onRetry={state?.error ? onRetry : undefined}
                onLoadMore={state && state.rows.length < state.total ? onLoadMore : undefined}
              />
            )
          }}
        />
      )}
    </div>
  )
}
