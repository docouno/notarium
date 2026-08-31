import {
  type ComponentType,
  lazy,
  type LazyExoticComponent,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  DraftViewQueryResponse,
  ViewDefinitionV1,
  ViewManifestResponse,
  ViewSourceV1,
  ViewWindowResponse,
} from '@notarium/contract'
import { STORE_EVENT } from '@notarium/contract/events'
import {
  boardReaderDefinition,
  compileReaderView,
  createReaderRegistry,
  decodeViewRef,
  type ParsedView,
  type ParsedViewBlock,
  type ReaderDefinition,
  type ReaderRegistry,
} from '@notarium/core'

import { ErrorBoundary } from '../../core/ErrorBoundary'
import { Notice } from '../../core/Notice'
import { Skeleton } from '../../core/Skeleton'
import { api } from '../../services/api'
import { VIEW_READER_ICONS, ViewBlock, type ViewReaderIcons } from '../../widgets/ViewBlock'
import { CHANGED_COALESCE_MS, useSync } from '../SyncProvider'

export type ViewRuntimeMode = 'current-writer' | 'current-reader' | 'draft'
export type ViewManifestItem = ViewManifestResponse['views'][number]

export type ViewRuntimeContext =
  { kind: 'saved' } | { kind: 'draft'; space: string; directory: string }

export type ViewWindowLoader = (input: {
  group?: string
  offset?: number
  limit?: number
  signal?: AbortSignal
}) => Promise<ViewWindowResponse | DraftViewQueryResponse>

export type ViewReaderComponentProps = {
  view: ParsedView
  options: unknown
  mode: ViewRuntimeMode
  projection: unknown
  manifest?: ViewManifestItem
  loading: boolean
  error: string | null
  loadWindow: ViewWindowLoader
  refresh: () => void
}

export type ViewReaderComponent =
  | ComponentType<ViewReaderComponentProps>
  | LazyExoticComponent<ComponentType<ViewReaderComponentProps>>
export type ViewReaderComponents = Readonly<Record<string, ViewReaderComponent>>

const BUILTIN_DEFINITIONS: readonly ReaderDefinition[] = [boardReaderDefinition]
const BuiltinBoardView = lazy(() =>
  import('../BoardView').then((module) => ({ default: module.BoardView })),
)
export const VIEW_READER_COMPONENTS: ViewReaderComponents = Object.freeze({
  board: BuiltinBoardView,
})
export const VIEW_READER_REGISTRY = createReaderRegistry(BUILTIN_DEFINITIONS)
export { VIEW_READER_ICONS }
const SAVED_CONTEXT: ViewRuntimeContext = Object.freeze({ kind: 'saved' })

const ViewReaderModuleSkeleton = () => (
  <div role="status" aria-label="Loading view" data-testid="view-reader-module-skeleton">
    <Skeleton w="100%" h="calc(var(--control-height) * 2)" />
  </div>
)

export const useViewRefreshRevision = (): number => {
  const { subscribe } = useSync()
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribe((event) => {
      if (event.type !== STORE_EVENT.CHANGED) {
        return
      }
      clearTimeout(timer)
      timer = setTimeout(() => setRevision((value) => value + 1), CHANGED_COALESCE_MS)
    })

    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [subscribe])

  return revision
}

export const assertViewRegistryParity = (
  registry: ReaderRegistry,
  components: ViewReaderComponents,
  icons?: ViewReaderIcons,
): void => {
  const componentTypes = Object.keys(components).sort()
  const definitionTypes = [...registry.types].sort()

  if (
    componentTypes.length !== definitionTypes.length ||
    componentTypes.some((type, index) => type !== definitionTypes[index])
  ) {
    throw new Error('view reader definitions and React components are out of sync')
  }
  if (icons) {
    const iconTypes = Object.keys(icons).sort()

    if (
      iconTypes.length !== definitionTypes.length ||
      iconTypes.some((type, index) => type !== definitionTypes[index])
    ) {
      throw new Error('view reader definitions and tree icons are out of sync')
    }
  }
}

const renderReader = (
  view: ParsedView,
  mode: ViewRuntimeMode,
  registry: ReaderRegistry,
  components: ViewReaderComponents,
  state: {
    manifest?: ViewManifestItem
    loading: boolean
    error: string | null
    loadWindow: ViewWindowLoader
    refresh: () => void
  },
): { content: ReactNode; executable: boolean } => {
  const compiled = compileReaderView(registry, view.definition)

  if (compiled.status === 'unsupported') {
    return {
      content: <Notice variant="warning">Reader “{view.type}” is not installed.</Notice>,
      executable: false,
    }
  }
  if (compiled.status === 'invalid') {
    return {
      content: (
        <Notice variant="error">
          {compiled.diagnostics[0] ?? `The ${view.type} view options are invalid.`}
        </Notice>
      ),
      executable: false,
    }
  }
  const Component = components[view.type]

  if (!Component) {
    return {
      content: <Notice variant="error">The registered reader has no UI component.</Notice>,
      executable: false,
    }
  }
  const projection = compiled.definition.project({ manifest: state.manifest }, compiled.options)

  return {
    content: (
      <ErrorBoundary
        resetKey={`${view.viewRef ?? `${view.block}:${view.occurrence}`}:${view.type}`}
        fallback={() => <Notice variant="error">This reader failed to render.</Notice>}
      >
        <Suspense fallback={<ViewReaderModuleSkeleton />}>
          <Component
            view={view}
            options={compiled.options}
            mode={mode}
            projection={projection}
            manifest={state.manifest}
            loading={state.loading}
            error={state.error}
            loadWindow={state.loadWindow}
            refresh={state.refresh}
          />
        </Suspense>
      </ErrorBoundary>
    ),
    executable: true,
  }
}

export const ViewRuntime = ({
  block,
  mode,
  registry = VIEW_READER_REGISTRY,
  components = VIEW_READER_COMPONENTS,
  context = SAVED_CONTEXT,
  refreshKey = 0,
}: {
  block: ParsedViewBlock
  mode: ViewRuntimeMode
  registry?: ReaderRegistry
  components?: ViewReaderComponents
  context?: ViewRuntimeContext
  refreshKey?: number
}) => {
  const first = block.views[0]?.occurrence ?? 0
  const [active, setActive] = useState(first)
  const [manifest, setManifest] = useState<ViewManifestItem | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localRefresh, setLocalRefresh] = useState(0)
  const requestGeneration = useRef(0)

  useEffect(() => {
    if (!block.views.some((view) => view.occurrence === active)) {
      setActive(block.views[0]?.occurrence ?? 0)
    }
  }, [active, block.views])
  const view = block.views.find((candidate) => candidate.occurrence === active) ?? block.views[0]
  const viewRef = view?.viewRef
  const viewType = view?.type

  useEffect(() => {
    if (!view || !viewType || !registry.get(viewType)) {
      setLoading(false)
      return
    }
    const generation = ++requestGeneration.current
    const abort = new AbortController()
    let request: Promise<ViewManifestItem | undefined>

    if (context.kind === 'saved') {
      if (!viewRef) {
        setError('saved view has no viewRef')
        return
      }
      const decoded = decodeViewRef(viewRef)

      if (!decoded) {
        setError('viewRef is stale')
        return
      }
      request = api.noteViewsGet(decoded.documentId, abort.signal).then((response) => {
        const item =
          response.views.find((candidate) => candidate.viewRef === viewRef) ??
          response.views.find(
            (candidate) =>
              candidate.block === view.block && candidate.occurrence === view.occurrence,
          )

        return item
      })
    } else {
      if (!block.source) {
        setError('draft view has no source')
        return
      }
      request = api
        .draftViewQuery(
          context.space,
          {
            context: { kind: 'draft', directory: context.directory },
            source: block.source as ViewSourceV1,
            view: view.definition as ViewDefinitionV1,
            window: { offset: 0, limit: 1 },
          },
          abort.signal,
        )
        .then((response) => {
          return {
            block: view.block,
            occurrence: view.occurrence,
            name: view.name,
            type: view.type,
            status: response.execution.exactFallbackTruncated ? 'incomplete' : 'ready',
            total: response.total,
            groups: response.groups,
            execution: response.execution,
            snapshotGeneration: response.snapshotGeneration,
            schemaVersionToken: response.schemaVersionToken,
          }
        })
    }

    setManifest((current) =>
      current?.block === view.block &&
      current?.occurrence === view.occurrence &&
      current?.type === viewType
        ? current
        : undefined,
    )
    setLoading(true)
    void request
      .then((next) => {
        if (generation !== requestGeneration.current) {
          return
        }
        setManifest(next)
        setError(null)
      })
      .catch((cause) => {
        if (generation === requestGeneration.current && !abort.signal.aborted) {
          setError((cause as Error).message)
        }
      })
      .finally(() => {
        if (generation === requestGeneration.current) {
          setLoading(false)
        }
      })

    return () => abort.abort()
  }, [block.source, context, localRefresh, refreshKey, registry, view, viewRef, viewType])

  const loadWindow = useCallback<ViewWindowLoader>(
    ({ group, offset = 0, limit = 50, signal }) => {
      if (!view) {
        return Promise.reject(new Error('view is unavailable'))
      }
      if (context.kind === 'saved') {
        if (!view.viewRef || !manifest?.snapshotGeneration) {
          return Promise.reject(new Error('saved view manifest is unavailable'))
        }

        return api.viewWindowPost(
          {
            viewRef: manifest.viewRef ?? view.viewRef,
            snapshotGeneration: manifest.snapshotGeneration,
            schemaVersionToken: manifest.schemaVersionToken,
            group,
            offset,
            limit,
          },
          signal,
        )
      }
      if (!block.source) {
        return Promise.reject(new Error('draft view has no source'))
      }

      return api.draftViewQuery(
        context.space,
        {
          context: { kind: 'draft', directory: context.directory },
          source: block.source as ViewSourceV1,
          view: view.definition as ViewDefinitionV1,
          ...(manifest?.snapshotGeneration
            ? { snapshotGeneration: manifest.snapshotGeneration }
            : {}),
          ...(manifest?.schemaVersionToken
            ? { schemaVersionToken: manifest.schemaVersionToken }
            : {}),
          window: { group, offset, limit },
        },
        signal,
      )
    },
    [
      block.source,
      context,
      manifest?.schemaVersionToken,
      manifest?.snapshotGeneration,
      manifest?.viewRef,
      view,
    ],
  )
  const refresh = useCallback(() => setLocalRefresh((value) => value + 1), [])
  const rendered = useMemo(
    () =>
      view
        ? renderReader(view, mode, registry, components, {
            manifest,
            loading,
            error,
            loadWindow,
            refresh,
          })
        : null,
    [components, error, loadWindow, loading, manifest, mode, refresh, registry, view],
  )

  return (
    <ViewBlock block={block} activeView={active} onSelectView={setActive}>
      {rendered?.content}
    </ViewBlock>
  )
}
