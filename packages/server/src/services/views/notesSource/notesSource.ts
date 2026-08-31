import {
  FIELD_TYPE,
  type FieldColor,
  PROTECTED_FIELD_KEYS,
  VIEW_EXACT_READ_LIMIT,
  VIEW_GROUP_MAX,
  type ViewRow,
} from '@notarium/contract'
import {
  andFieldFilters,
  buildNoteDetailFields,
  comparatorFor,
  compileFieldFilterEvaluator,
  encodeUtf8Base64Url,
  FIELD_MATCH_STATE,
  fieldFilterKeys,
  isPathUnder,
  type KnowledgeStore,
  NOTE_SORT,
  type NoteDetailFields,
  type NoteMeta,
  orderByBoardRanks,
  parseBoardRanks,
  sha256Hex,
  type ViewDataNeeds,
} from '@notarium/core'

import type { FieldSchemaSnapshot, FieldSchemaStore } from '../../fields'
import type { ProjectRecord } from '../../metaDb'
import { setNoteFields } from '../../spaces'
import type {
  PreparedView,
  ViewExecution,
  ViewSourceCaptureInput,
  ViewSourceExecutionContext,
  ViewSourcePlanIdentityInput,
  ViewSourcePrepareInput,
} from '../sourceRegistry'

type ProjectedValue = {
  state: 'value' | 'absent' | 'empty-string' | 'empty-list' | 'unreadable'
  value?: string | string[]
  label?: string
  color?: FieldColor
}

type Group = ProjectedValue & { key: string; count: number }

type FieldDeclaration = FieldSchemaSnapshot['fields'][number]
type FieldCatalogEntry = {
  declaration: FieldDeclaration
  options: ReadonlyMap<string, NonNullable<FieldDeclaration['values']>[number]>
}
type FieldCatalog = ReadonlyMap<string, FieldCatalogEntry>

type ExactCacheEntry = {
  fields: NoteDetailFields
  versionToken: string
  bytes: number
}

type SelectedRows = {
  rows: NoteMeta[]
  incomplete: boolean
  snapshotGeneration: string
  witnesses: ReadonlyMap<string, string>
}

export type NotesViewExecutionContext = {
  snapshotGeneration: string
  notes: readonly NoteMeta[]
  execution: ViewExecution
  exactBudgetRemaining: number
  exactCache: Map<string, ExactCacheEntry>
  exactCacheBytes: number
  selections: Map<string, Promise<SelectedRows>>
}

const EXACT_CACHE_MAX_ENTRIES = 2_048
const EXACT_CACHE_MAX_BYTES = 4 * 1024 * 1024
const protectedFieldKeys = new Set<string>(PROTECTED_FIELD_KEYS)

const fieldCatalogOf = (
  schema: FieldSchemaSnapshot | undefined,
  keys: ReadonlySet<string>,
): FieldCatalog =>
  new Map(
    (schema?.fields ?? [])
      .filter((declaration) => keys.has(declaration.key))
      .map((declaration) => [
        declaration.key,
        {
          declaration,
          options: new Map((declaration.values ?? []).map((option) => [option.key, option])),
        },
      ]),
  )

const propertyKey = (address: string): string | null =>
  address.startsWith('note.') && address.length > 5 ? address.slice(5) : null

const knownFieldName = (meta: NoteMeta, key: string): boolean => {
  if (key === 'view') {
    return true
  }
  const fields = meta.fields

  return Boolean(
    fields &&
    (Object.hasOwn(fields.keys, key) ||
      fields.unreadable?.includes(key) ||
      fields.truncated?.includes(key)),
  )
}

const hiddenFieldNames = (meta: NoteMeta): boolean =>
  !meta.fields || (meta.fields.unreadableMore ?? 0) > 0 || (meta.fields.truncatedMore ?? 0) > 0

const needsExactProjection = (meta: NoteMeta, keys: readonly string[]): boolean =>
  keys.some((key) => key !== 'view' && !knownFieldName(meta, key) && hiddenFieldNames(meta))

const nearestProject = (
  directory: string,
  projects: readonly ProjectRecord[],
): ProjectRecord | undefined => {
  let best: ProjectRecord | undefined

  for (const project of projects) {
    const contains =
      project.path === '' || directory === project.path || directory.startsWith(`${project.path}/`)

    if (contains && (!best || project.path.length > best.path.length)) {
      best = project
    }
  }

  return best
}

const projectionFor = (meta: NoteMeta, key: string, catalog: FieldCatalog): ProjectedValue => {
  if (key === 'view') {
    return meta.viewType === undefined
      ? { state: 'absent', label: 'No value' }
      : { state: 'value', value: meta.viewType, label: meta.viewType }
  }
  const fields = meta.fields

  if (fields?.unreadable?.includes(key)) {
    return { state: 'unreadable', label: 'Unreadable' }
  }
  if (!fields || !Object.hasOwn(fields.keys, key)) {
    return { state: 'absent', label: 'No value' }
  }
  const value = fields.keys[key]
  const state = Array.isArray(value)
    ? value.length === 0
      ? 'empty-list'
      : 'value'
    : value === ''
      ? 'empty-string'
      : 'value'
  const field = catalog.get(key)
  const declaration = field?.declaration
  const option =
    typeof value === 'string' && declaration?.type === FIELD_TYPE.enum
      ? field?.options.get(value)
      : undefined

  return {
    state,
    value,
    ...(state === 'empty-string' || state === 'empty-list'
      ? { label: 'Empty' }
      : option?.label
        ? { label: option.label }
        : typeof value === 'string'
          ? { label: value }
          : {}),
    ...(option?.color ? { color: option.color } : {}),
  }
}

const groupIdentity = (value: ProjectedValue): string =>
  encodeUtf8Base64Url(JSON.stringify({ state: value.state, value: value.value }))

const compareBinary = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const groupRows = (
  rows: readonly NoteMeta[],
  key: string,
  schemaCatalog: FieldCatalog,
  retainRows: boolean,
): {
  groups: Group[]
  totalGroups: number
  rowBuckets?: Map<string, NoteMeta[]>
  groupsTruncated?: true
  error?: string
} => {
  const byKey = new Map<string, Group>()
  const rowBuckets = retainRows ? new Map<string, NoteMeta[]>() : undefined
  const declaration = schemaCatalog.get(key)?.declaration

  if (declaration?.type === FIELD_TYPE.enum) {
    for (const option of declaration.values ?? []) {
      const projection: ProjectedValue = {
        state: 'value',
        value: option.key,
        label: option.label ?? option.key,
        ...(option.color ? { color: option.color } : {}),
      }

      byKey.set(groupIdentity(projection), {
        ...projection,
        key: groupIdentity(projection),
        count: 0,
      })
      rowBuckets?.set(groupIdentity(projection), [])
    }
  }
  for (const row of rows) {
    const projection = projectionFor(row, key, schemaCatalog)

    if (Array.isArray(projection.value) && projection.value.length > 0) {
      return {
        groups: [],
        totalGroups: 0,
        ...(rowBuckets ? { rowBuckets: new Map() } : {}),
        error: `note.${key} is list-valued and cannot be grouped in v1`,
      }
    }
    const id = groupIdentity(projection)
    const existing = byKey.get(id)

    if (existing) {
      existing.count++
    } else {
      byKey.set(id, { ...projection, key: id, count: 1 })
    }
    const bucket = rowBuckets?.get(id)

    if (bucket) {
      bucket.push(row)
    } else if (rowBuckets) {
      rowBuckets.set(id, [row])
    }
  }
  const catalogIds = new Set<string>()

  if (declaration?.type === FIELD_TYPE.enum) {
    for (const option of declaration.values ?? []) {
      catalogIds.add(groupIdentity({ state: 'value', value: option.key }))
    }
  }
  const catalog = [...byKey.values()].filter((group) => catalogIds.has(group.key))
  const observed = [...byKey.values()]
    .filter((group) => group.state === 'value' && !catalogIds.has(group.key))
    .sort((left, right) => compareBinary(String(left.value), String(right.value)))
  const structuralOrder = ['absent', 'empty-string', 'empty-list', 'unreadable']
  const structural = [...byKey.values()]
    .filter((group) => group.state !== 'value')
    .sort(
      (left, right) => structuralOrder.indexOf(left.state) - structuralOrder.indexOf(right.state),
    )
  const totalGroups = catalog.length + observed.length + structural.length
  const observedRoom = Math.max(0, VIEW_GROUP_MAX - catalog.length - structural.length)
  const groups = [...catalog, ...observed.slice(0, observedRoom), ...structural]

  return {
    groups,
    totalGroups,
    ...(rowBuckets ? { rowBuckets } : {}),
    ...(groups.length < totalGroups ? { groupsTruncated: true } : {}),
  }
}

export const viewSnapshotGeneration = async (notes: readonly NoteMeta[]): Promise<string> =>
  sha256Hex(
    JSON.stringify(
      notes.map((note) => [
        note.id,
        note.title,
        note.class,
        note.filePath,
        note.sourceLocator,
        note.slug,
        note.aliases,
        note.legacyNameAliases,
        note.tags,
        note.noteType,
        note.viewType,
        note.fields,
        note.modifiedAt,
        note.createdAt,
      ]),
    ),
  )

export class NotesViewSource {
  readonly kind = 'notes'
  readonly boardMove = {
    fieldKey: (options: unknown): string | null => {
      const groupBy = (options as { groupBy?: unknown } | null)?.groupBy

      return typeof groupBy === 'string' ? propertyKey(groupBy) : null
    },
    readMembership: async (input: { store: KnowledgeStore; cardId: string; fieldKey: string }) => {
      const note = await input.store.read(input.cardId)
      const entries = note.documentState?.projection?.frontmatterEntries
      const fields = entries ? buildNoteDetailFields(entries) : undefined

      return {
        versionToken: note.versionToken,
        value: fields?.keys[input.fieldKey],
      }
    },
    writeMembership: (input: {
      store: KnowledgeStore
      fieldSchemaStore?: FieldSchemaStore
      space: string
      cardId: string
      fieldKey: string
      versionToken?: string
      value: string | null
      principal?: string
    }) =>
      setNoteFields({
        store: input.store,
        fieldSchemaStore: input.fieldSchemaStore,
        space: input.space,
        id: input.cardId,
        versionToken: input.versionToken,
        fields: { [input.fieldKey]: input.value },
        principal: input.principal,
      }),
  }

  captureIdentity(input: ViewSourcePlanIdentityInput): unknown {
    return { kind: this.kind, cacheScope: input.cacheScope ?? null }
  }

  planIdentity(input: ViewSourcePlanIdentityInput): unknown {
    if (input.source.scope !== 'project') {
      return { scope: input.source.scope }
    }
    const project = nearestProject(input.directory, input.projects)

    return {
      scope: 'project',
      project: project ? [project.id, project.path, project.status] : null,
    }
  }

  private rememberExact(
    context: NotesViewExecutionContext,
    key: string,
    fields: NoteDetailFields,
    versionToken: string,
  ): void {
    const bytes = Buffer.byteLength(JSON.stringify([versionToken, fields]), 'utf8')
    const previous = context.exactCache.get(key)

    if (previous) {
      context.exactCacheBytes -= previous.bytes
      context.exactCache.delete(key)
    }
    context.exactCache.set(key, { fields, versionToken, bytes })
    context.exactCacheBytes += bytes

    while (
      context.exactCache.size > EXACT_CACHE_MAX_ENTRIES ||
      context.exactCacheBytes > EXACT_CACHE_MAX_BYTES
    ) {
      const oldestKey = context.exactCache.keys().next().value

      if (!oldestKey) {
        break
      }
      const oldest = context.exactCache.get(oldestKey)

      context.exactCache.delete(oldestKey)
      context.exactCacheBytes -= oldest?.bytes ?? 0
    }
  }

  private async exactFields(
    store: KnowledgeStore,
    meta: NoteMeta,
    context: NotesViewExecutionContext,
  ): Promise<ExactCacheEntry | null> {
    if (!meta.id) {
      return null
    }
    const cacheKey = meta.id
    const cached = context.exactCache.get(cacheKey)

    if (cached) {
      context.exactCache.delete(cacheKey)
      context.exactCache.set(cacheKey, cached)
      context.execution.exactCacheHits++
      return cached
    }
    if (context.exactBudgetRemaining <= 0) {
      return null
    }
    context.exactBudgetRemaining--
    context.execution.exactReads++
    const note = await store.read(meta.id)
    const entries = note.documentState?.projection?.frontmatterEntries

    if (!note.versionToken || !entries) {
      return null
    }
    const fields = buildNoteDetailFields(entries)

    this.rememberExact(context, cacheKey, fields, note.versionToken)
    return context.exactCache.get(cacheKey) ?? null
  }

  private async selectRows(
    input: {
      store: KnowledgeStore
      notes: readonly NoteMeta[]
      filter: Parameters<typeof compileFieldFilterEvaluator>[0]
      propertyKeys: readonly string[]
      signal?: AbortSignal
      orderRows: boolean
    },
    context: NotesViewExecutionContext,
  ): Promise<SelectedRows> {
    const ready: NoteMeta[] = []
    const candidates: NoteMeta[] = []
    const witnesses = new Map<string, string>()
    const evaluate = compileFieldFilterEvaluator(input.filter)

    for (const note of input.notes) {
      const result = evaluate(note)

      if (result === FIELD_MATCH_STATE.miss) {
        continue
      }
      if (
        result === FIELD_MATCH_STATE.ambiguous ||
        needsExactProjection(note, input.propertyKeys)
      ) {
        candidates.push(note)
      } else {
        ready.push(note)
      }
    }
    let exactRemaining = 0

    for (let index = 0; index < candidates.length; index++) {
      if (input.signal?.aborted) {
        exactRemaining += candidates.length - index
        break
      }
      const note = candidates[index]!

      try {
        const exactEntry = await this.exactFields(input.store, note, context)

        if (!exactEntry) {
          exactRemaining++
          continue
        }
        witnesses.set(note.id!, exactEntry.versionToken)
        const exact = { ...note, fields: exactEntry.fields }

        if (evaluate(exact) === FIELD_MATCH_STATE.match) {
          ready.push(exact)
        }
      } catch {
        exactRemaining++
      }
      if ((index + 1) % 32 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    if (input.orderRows) {
      ready.sort(comparatorFor(NOTE_SORT.title))
    }
    context.execution.exactRemaining += exactRemaining

    if (exactRemaining > 0) {
      context.execution.exactFallbackTruncated = true
    }
    const exactWitnesses = [...witnesses].sort(([left], [right]) => compareBinary(left, right))
    const snapshotGeneration = exactWitnesses.length
      ? await sha256Hex(
          JSON.stringify({ snapshot: context.snapshotGeneration, exact: exactWitnesses }),
        )
      : context.snapshotGeneration

    return {
      rows: ready,
      incomplete: exactRemaining > 0,
      snapshotGeneration,
      witnesses,
    }
  }

  async capture(input: ViewSourceCaptureInput): Promise<NotesViewExecutionContext> {
    const notes = (input.snapshot as readonly NoteMeta[] | undefined) ?? (await input.store.list())
    const corpusGeneration = input.snapshotGeneration ?? (await viewSnapshotGeneration(notes))
    const snapshotGeneration = await sha256Hex(
      JSON.stringify({
        corpus: corpusGeneration,
        projects: input.projects
          .map((project) => [project.id, project.path, project.status])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      }),
    )

    return {
      notes,
      snapshotGeneration,
      execution: {
        exactReads: 0,
        exactCacheHits: 0,
        exactRemaining: 0,
      },
      exactBudgetRemaining: VIEW_EXACT_READ_LIMIT,
      exactCache: new Map(),
      exactCacheBytes: 0,
      selections: new Map(),
    }
  }

  async prepare(input: ViewSourcePrepareInput<ViewSourceExecutionContext>): Promise<PreparedView> {
    const compiled = input.reader
    const context = input.context as NotesViewExecutionContext
    const snapshotGeneration = context.snapshotGeneration
    const common = {
      ...(input.schema ? { schemaVersionToken: input.schema.versionToken } : {}),
      sourceKind: this.kind,
      capabilities: compiled.mutationCapabilities,
      readerOptions: compiled.options,
    }

    if (input.source.kind !== 'notes') {
      return {
        ...common,
        snapshotGeneration,
        status: 'unsupported',
        diagnostics: [`Unknown source: ${input.source.kind}`],
      }
    }
    if (input.source.scope !== 'project' && input.source.scope !== 'space') {
      return {
        ...common,
        snapshotGeneration,
        status: 'invalid',
        diagnostics: ['notes source requires scope'],
      }
    }
    const properties = [...compiled.dataNeeds.properties]
    const knownProperties = new Set(properties)

    if (compiled.dataNeeds.includeCardFields) {
      for (const field of input.schema?.fields ?? []) {
        const address = `note.${field.key}`

        if (field.card && !knownProperties.has(address)) {
          knownProperties.add(address)
          properties.push(address)
        }
      }
    }
    const dataNeeds: ViewDataNeeds = { ...compiled.dataNeeds, properties }
    let notes = context.notes

    if (input.source.scope === 'project') {
      const project = nearestProject(input.directory, input.projects)

      if (!project) {
        return {
          ...common,
          snapshotGeneration,
          status: 'invalid',
          diagnostics: ['view is outside a marked project'],
        }
      }
      notes = project.path
        ? notes.filter((note) => isPathUnder(note.filePath, project.path))
        : notes
    }
    const base = { ...common, snapshotGeneration }
    const filter = andFieldFilters(input.source.filter, input.view.filter)
    const propertyKeys = [
      ...new Set(
        [...fieldFilterKeys(filter), ...dataNeeds.properties]
          .map(propertyKey)
          .filter((key): key is string => key != null),
      ),
    ]
    const groupKey = dataNeeds.groupBy ? propertyKey(dataNeeds.groupBy) : undefined

    if (dataNeeds.groupBy && !groupKey) {
      return { ...base, status: 'invalid', diagnostics: ['groupBy must address note.<key>'] }
    }
    if (groupKey && !propertyKeys.includes(groupKey)) {
      propertyKeys.push(groupKey)
    }
    const capabilities = { ...compiled.mutationCapabilities }

    if (
      capabilities.move &&
      (!groupKey ||
        protectedFieldKeys.has(groupKey) ||
        !input.schema ||
        input.schema.status === 'unavailable' ||
        input.schema.status === 'structural-error')
    ) {
      delete capabilities.move
    }
    const execution = context.execution
    const retainRows = input.purpose === 'view'
    const selectionKey = await sha256Hex(
      JSON.stringify({
        sourceContext: this.planIdentity({
          source: input.source,
          directory: input.directory,
          projects: input.projects,
        }),
        filter,
        properties: [...propertyKeys].sort(compareBinary),
        orderRows: retainRows,
      }),
    )
    let selected = context.selections.get(selectionKey)

    if (!selected) {
      selected = this.selectRows(
        {
          store: input.store,
          notes,
          filter,
          propertyKeys,
          signal: input.signal,
          orderRows: retainRows,
        },
        context,
      )
      context.selections.set(selectionKey, selected)
      void selected.catch(() => {
        if (context.selections.get(selectionKey) === selected) {
          context.selections.delete(selectionKey)
        }
      })
    }
    const selection = await selected

    if (!retainRows) {
      context.selections.delete(selectionKey)
    }
    const readyBase = { ...common, snapshotGeneration: selection.snapshotGeneration }
    let orderedRows = selection.rows
    let orderDiagnostics: string[] | undefined

    if (retainRows && dataNeeds.order?.kind === 'manual-rank') {
      const parsedRanks = parseBoardRanks(dataNeeds.order.ranks)

      orderedRows = orderByBoardRanks(selection.rows, parsedRanks.entries, {
        id: (note) => note.id ?? note.filePath,
        fallback: comparatorFor(NOTE_SORT.title),
      })
      orderDiagnostics = parsedRanks.diagnostics.length ? parsedRanks.diagnostics : undefined
    }
    if (!groupKey) {
      return {
        ...readyBase,
        status: selection.incomplete ? 'incomplete' : 'ready',
        diagnostics: orderDiagnostics,
        total: orderedRows.length,
        ...(retainRows ? { rows: orderedRows } : {}),
        execution,
        exactWitnesses: selection.witnesses,
        dataNeeds,
        capabilities,
        readerOptions: compiled.options,
        sourceKind: this.kind,
      }
    }
    const grouped = groupRows(
      orderedRows,
      groupKey,
      fieldCatalogOf(input.schema, new Set([groupKey])),
      retainRows,
    )

    if (grouped.error) {
      return { ...readyBase, status: 'invalid', diagnostics: [grouped.error] }
    }

    return {
      ...readyBase,
      status: selection.incomplete ? 'incomplete' : 'ready',
      diagnostics: orderDiagnostics,
      total: orderedRows.length,
      groups: grouped.groups,
      totalGroups: grouped.totalGroups,
      groupsTruncated: grouped.groupsTruncated,
      ...(retainRows ? { rows: orderedRows, rowBuckets: grouped.rowBuckets } : {}),
      execution,
      exactWitnesses: selection.witnesses,
      dataNeeds,
      capabilities,
      readerOptions: compiled.options,
      sourceKind: this.kind,
    }
  }

  window(
    prepared: PreparedView,
    input: { group?: string; offset: number; limit: number },
    schema?: FieldSchemaSnapshot,
  ): { total: number; rows: ViewRow[] } {
    if (!prepared.rows || !prepared.dataNeeds) {
      return { total: 0, rows: [] }
    }
    const groupKey = prepared.dataNeeds.groupBy
      ? propertyKey(prepared.dataNeeds.groupBy)
      : undefined
    let rows = prepared.rows as readonly NoteMeta[]

    if (groupKey) {
      if (!input.group) {
        throw new Error('group is required for a grouped view')
      }
      rows = (prepared.rowBuckets?.get(input.group) as NoteMeta[] | undefined) ?? []
    }
    const total = rows.length
    const selected = rows.slice(input.offset, input.offset + input.limit)
    const fieldKeys = prepared.dataNeeds.properties
      .map(propertyKey)
      .filter((key): key is string => key != null && key !== groupKey)
    const catalog = fieldCatalogOf(schema, new Set([...(groupKey ? [groupKey] : []), ...fieldKeys]))

    return {
      total,
      rows: selected.flatMap((row) =>
        row.id
          ? [
              {
                id: row.id,
                title: row.title,
                filePath: row.filePath,
                ...(row.noteType ? { noteType: row.noteType } : {}),
                ...(groupKey ? { group: projectionFor(row, groupKey, catalog) } : {}),
                ...(fieldKeys.length
                  ? {
                      fields: Object.fromEntries(
                        fieldKeys.map((key) => [key, projectionFor(row, key, catalog)]),
                      ),
                    }
                  : {}),
              },
            ]
          : [],
      ),
    }
  }
}
