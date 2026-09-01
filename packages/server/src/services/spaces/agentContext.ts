// The init-context curation surface: the ONE assembly of "what the agent loads at
// session start", shared by the MCP gateway and the REST preview — the pult must show
// EXACTLY what the agent will load, not a parallel re-derivation.
// canon: docs/projects.md#init-context-curation-165-a-idinit-context-curationa

import { CONTEXT_ENTRY_KIND, NOTE_CLASS, type NoteClass } from '@notarium/contract'
import {
  basenameOf,
  estimateTokens,
  isFolderPageOf,
  isPathUnder,
  type KnowledgeStore,
  memoryDirOf,
  READ_SCOPE,
  treeChildren,
  withMemoryCategoryFence,
} from '@notarium/core'

import type { ContextSetRecord } from '../metaDb'
import { ALWAYS_LOAD_TAG } from './personalContent'
import type { SpaceStore } from './types'

/** Token budgets — ONE per SCOPE, not per channel: a scope's whole eager cost (pins +
 *  memory + embedded personal) is weighed against a SINGLE envelope. `SCOPE_ITEM_CAP` is
 *  the anti-pathological BACKSTOP so a runaway many-tiny-items list can't explode the
 *  bundle even under budget. */
export const PERSONAL_TOKEN_BUDGET = 22_000
export const PROJECT_TOKEN_BUDGET = 38_000
export const SCOPE_ITEM_CAP = 250

/** One always-load pin weighed by its whole BODY (a pin is content the agent always
 *  has, so `tokens` is the whole note, not a summary). `space` is set ONLY for a
 *  CROSS-SPACE pin (pinned in from another space, resolved per-reader); a same-space
 *  tag pin omits it. */
export type WeighedPin = {
  noteId: string
  title: string
  tokens: number
  space?: string
  folderPage?: true
}
/** A pin with the curation verdict: `loaded=false` = still pinned but over the scope's
 *  single token budget (the pult dims it, the agent won't load it). `order` = 0-based
 *  position in the scope's user-ordered pin+set list. */
export type CuratedPin = WeighedPin & { loaded: boolean; order: number }
/** What a memory category carries into a scope curation: id, eager token weight (the
 *  SUMMARY's — that's what loads eagerly), and the human `muted` opt-out. */
export type CuratableMemory = { noteId: string; tokens: number; muted: boolean }

/** One resolved+weighed context-set item: a pin-like entry plus the SLUG of the space
 *  it lives in (a set is cross-space, so `space` is MANDATORY here, unlike a plain pin). */
export type WeighedSetItem = WeighedPin & { space: string }
/** A context set resolved for a scope: its ACCESSIBLE items only (per-reader degradation
 *  already applied), weighed. canon: docs/projects.md#context-sets-209-reusable-cross-space-bundles */
export type WeighedSet = { id: string; name: string; homeSpace: string; items: WeighedSetItem[] }
/** A context set before per-item I/O. Budgeted consumers resolve this raw membership
 * lazily in the shared strict sequence; the role identity door deliberately keeps
 * using {@link resolveContextSets} because it is an unbudgeted editing surface. */
export type ScopeSetRefs = {
  id: string
  name: string
  homeSpace: string
  items: ReadonlyArray<{ noteId: string }>
  read: (noteId: string) => Promise<ResolvedContextNote | null>
  /** REST may expose raw totals/cursors only to a reader of the set's home space. */
  coordinatesVisible: boolean
}
export type ScopeSetInput = WeighedSet | ScopeSetRefs
/** A set after curation. `homeSpace` rides through so the pult addresses the set's CRUD
 *  against its real home; item `order` and set `order` are user-ordered positions. */
export type CuratedSet = {
  id: string
  name: string
  homeSpace: string
  order: number
  items: Array<WeighedSetItem & { loaded: boolean; order: number; sourceIndex: number }>
  itemsTotal: number
  itemsLoaded: number
  itemsCursor: number
  trimmed: boolean
  /** Internal disclosure verdict. Zod strips it from the public response. */
  coordinatesVisible: boolean
}

export type RoleScopeInput = {
  pins: WeighedPin[]
  sets: ScopeSetInput[]
  order?: ScopeOrder
}

export type CuratedRoleScope = {
  pins: CuratedPin[]
  sets: CuratedSet[]
  loadedTokens: number
}

type ResolvedContextNote = {
  noteId?: string
  content?: string
  tokens?: number
  title: string
  spaceSlug: string
  filePath: string
  /** Needed to answer the folder-page question: the reserved basename alone does not
   *  make a cover, and a hidden class carrying it is nobody's folder page. */
  class?: NoteClass
}

/** Flatten one curated layer into the exact note refs sent to an agent, preserving the
 * user's group order and the order inside each set. */
export const loadedContextNotes = (
  pins: CuratedPin[],
  sets: CuratedSet[],
): Array<{ noteId: string; title: string }> => {
  const groups = [
    ...pins.map((pin) => ({
      order: pin.order,
      items: pin.loaded ? [{ noteId: pin.noteId, title: pin.title }] : [],
    })),
    ...sets.map((set) => ({
      order: set.order,
      items: set.items
        .filter((item) => item.loaded)
        .map((item) => ({ noteId: item.noteId, title: item.title })),
    })),
  ]

  return groups.sort((left, right) => left.order - right.order).flatMap((group) => group.items)
}

/** Resolve + weigh a scope's context sets under ONE reader, honest degradation: `read`
 *  returns null (reader can't reach the item's space, or the note is gone) → that item
 *  DROPS, the set stands. An empty set is KEPT so the pult can still show it.
 *  canon: docs/architecture.md#p5 */
export const resolveContextSets = async (
  sets: readonly ContextSetRecord[],
  read: (noteId: string) => Promise<ResolvedContextNote | null>,
): Promise<WeighedSet[]> =>
  Promise.all(
    sets.map(async (set) => {
      const resolved = await Promise.all(
        set.items.map(async (ref) => {
          const note = await read(ref.noteId)

          if (!note) {
            return null
          }

          return {
            noteId: note.noteId ?? ref.noteId,
            title: note.title,
            tokens: note.tokens ?? estimateTokens(note.content ?? ''),
            space: note.spaceSlug,
            ...(isFolderPageOf(note.filePath, note.class) ? { folderPage: true as const } : {}),
          }
        }),
      )
      return {
        id: set.id,
        name: set.name,
        homeSpace: set.homeSpace,
        items: resolved.filter((x): x is WeighedSetItem => x != null),
      }
    }),
  )

/** Resolve + weigh a scope's LOOSE cross-space pins under ONE reader, same honest
 *  degradation as set items (`read` null → the pin drops). Survivors fold into the scope's
 *  pin bucket; a note pinned twice still dedups by id in {@link budgetSequence}. */
export const resolveScopePins = async (
  noteIds: readonly string[],
  read: (noteId: string) => Promise<ResolvedContextNote | null>,
): Promise<WeighedSetItem[]> => {
  const resolved = await Promise.all(
    noteIds.map(async (noteId) => {
      const note = await read(noteId)

      if (!note) {
        return null
      }

      return {
        noteId: note.noteId ?? noteId,
        title: note.title,
        tokens: note.tokens ?? estimateTokens(note.content ?? ''),
        space: note.spaceSlug,
        ...(isFolderPageOf(note.filePath, note.class) ? { folderPage: true as const } : {}),
      }
    }),
  )
  return resolved.filter((x): x is WeighedSetItem => x != null)
}

/** Always-load (tagged) user-docs of a domain or a project subtree, weighed but NOT yet
 *  budget-trimmed — the trim is a SCOPE decision (pins share a budget with memory).
 *  agent-memory is excluded (its own channel). Titles are RAW — each caller sanitises
 *  (MCP wire) or leaves it to the client's escaping (REST). */
export const weighAlwaysLoad = async (
  store: KnowledgeStore,
  opts: { pathPrefix?: string } = {},
): Promise<WeighedPin[]> => {
  const all = (await store.list({ scope: READ_SCOPE.user })).filter(
    (m) => m.id != null && m.class !== NOTE_CLASS.agentMemory,
  )
  const inScope = opts.pathPrefix
    ? all.filter((m) => isPathUnder(m.filePath, opts.pathPrefix as string))
    : all
  const tagged = inScope.filter((m) => (m.tags ?? []).includes(ALWAYS_LOAD_TAG))
  const facts = store.noteFacts ? await store.noteFacts(tagged.map((meta) => meta.id!)) : {}

  return Promise.all(
    tagged.map(async (m) => {
      const fact = facts[m.id!]
      const note = fact ? null : await store.read(m.id as string)

      return {
        noteId: note?.id ?? (m.id as string),
        title: fact?.title ?? note?.title ?? m.title,
        tokens: fact?.bodyTokens ?? estimateTokens(note!.content),
        ...(isFolderPageOf(note?.filePath ?? m.filePath, m.class)
          ? { folderPage: true as const }
          : {}),
      }
    }),
  )
}

/** The reserved identity note (`class: profile`), loaded FIRST in a personal session.
 *  Weight is 0 on purpose — a free lead, never counted against a scope budget. Null when
 *  the user never saved one. canon: docs/note-model.md#note-classes */
export const personalProfilePin = async (store: KnowledgeStore): Promise<WeighedPin | null> => {
  const meta = (await store.list({ scope: READ_SCOPE.all })).find(
    (m) => m.id != null && m.class === NOTE_CLASS.profile,
  )

  if (!meta?.id) {
    return null
  }
  const fact = store.noteFacts ? (await store.noteFacts([meta.id]))[meta.id] : undefined
  const note = fact ? null : await store.read(meta.id)

  return {
    noteId: note?.id ?? meta.id,
    title: fact?.title ?? note?.title ?? meta.title,
    tokens: 0,
  }
}

/** A scope's user-defined order: pin+set entries in rank order. Pins and sets share ONE
 *  rank space (a set can outrank a pin); entries absent from the list keep the DEFAULT
 *  sequence (pins, then sets, insertion) AFTER the ranked ones — a self-healing merge. */
export type ScopeOrder = ReadonlyArray<{ kind: 'pin' | 'set'; ref: string }>

const orderKey = (kind: 'pin' | 'set', ref: string) => `${kind}:${ref}`

/** One pin-like entry riding a scope budget (a pin OR a set item), tagged with its
 *  `bucket`/`setIdx` so survivors can be re-bucketed after the joint budgeting. */
type ScopeEntry = WeighedPin & {
  space: string
  bucket: string
  setIdx: number
  sourceIndex?: number
}
type ScopeEntryRef =
  | { kind: 'pin'; entry: ScopeEntry }
  | {
      kind: 'set'
      bucket: string
      setIdx: number
      sourceIndex: number
      rawNoteId: string
      resolve: () => Promise<WeighedSetItem | null>
    }
/** One draggable GROUP of a scope's pin+set list: a pin (one entry) or a set (all its
 *  items, moving together). `pos` is the 0-based wire `order` so the client renders the
 *  interleaved list without re-deriving the sequence. */
type ScopeGroup = {
  kind: 'pin' | 'set'
  ref: string
  setIdx: number
  pos: number
  entries: Iterable<ScopeEntryRef>
}

const isResolvedSet = (set: ScopeSetInput): set is WeighedSet => !('read' in set)

const resolvedSetItem =
  (item: WeighedSetItem): (() => Promise<WeighedSetItem>) =>
  async () =>
    item

const rawSetItem =
  (set: ScopeSetRefs, noteId: string): (() => Promise<WeighedSetItem | null>) =>
  async () => {
    const note = await set.read(noteId)

    if (!note) {
      return null
    }

    return {
      noteId: note.noteId ?? noteId,
      title: note.title,
      tokens: note.tokens ?? estimateTokens(note.content ?? ''),
      space: note.spaceSlug,
      ...(isFolderPageOf(note.filePath, note.class) ? { folderPage: true as const } : {}),
    }
  }

function* setEntryRefs(set: ScopeSetInput, setIdx: number, bucket: string) {
  for (let sourceIndex = 0; sourceIndex < set.items.length; sourceIndex += 1) {
    const item = set.items[sourceIndex]
    const noteId = item.noteId

    yield {
      kind: 'set' as const,
      bucket,
      setIdx,
      sourceIndex,
      rawNoteId: noteId,
      resolve: isResolvedSet(set)
        ? resolvedSetItem(item as WeighedSetItem)
        : rawSetItem(set, noteId),
    }
  }
}

/** Order a scope's pin+set GROUPS by the user overlay: ranked first, then the unranked in
 *  the default sequence (pins, then sets, insertion). Positions are 0-based over THIS
 *  block — project and embedded-personal blocks are ordered independently (per-panel). */
const orderGroups = (
  pins: WeighedPin[],
  pinBucket: string,
  sets: ScopeSetInput[],
  setBucket: string,
  order: ScopeOrder,
): ScopeGroup[] => {
  const rank = new Map(order.map((e, i) => [orderKey(e.kind, e.ref), i]))
  const raw: Omit<ScopeGroup, 'pos'>[] = [
    ...pins.map((p) => ({
      kind: CONTEXT_ENTRY_KIND.pin,
      ref: p.noteId,
      setIdx: -1,
      entries: [
        {
          kind: 'pin' as const,
          entry: { ...p, space: p.space ?? '', bucket: pinBucket, setIdx: -1 },
        },
      ],
    })),
    ...sets.map((s, i) => ({
      kind: CONTEXT_ENTRY_KIND.set,
      ref: s.id,
      setIdx: i,
      entries: setEntryRefs(s, i, setBucket),
    })),
  ]
  return raw
    .map((g, defIdx) => ({
      g,
      r: rank.get(orderKey(g.kind, g.ref)) ?? Number.POSITIVE_INFINITY,
      defIdx,
    }))
    .sort((a, b) => a.r - b.r || a.defIdx - b.defIdx)
    .map(({ g }, pos) => ({ ...g, pos }))
}

type ResolveStopReason = 'budget' | 'item-cap' | 'resolve-cap' | 'exhausted'
type ResolvedTrace = {
  setIdx: number
  sourceIndex: number
  rawNoteId: string
  canonicalNoteId: string | null
}

type CuratedSequence<M extends CuratableMemory> = {
  entries: Array<ScopeEntry & { loaded: boolean }>
  memory: Array<M & { loaded: boolean }>
  loadedTokens: number
  loadedIds: Set<string>
  traces: Map<string, ResolvedTrace[]>
  stopReason: ResolveStopReason
  stopGroup: number | null
}

/** Resolve and curate one Role→Project→Personal sequence. Set refs are the only lazy
 * entries: each is resolved just before the budget decision, so neither a token stop nor
 * either safety cap can trigger speculative body work beyond the strict prefix. */
const curateSequence = async <M extends CuratableMemory>(
  groups: ScopeGroup[],
  memory: M[],
  budget: number,
): Promise<CuratedSequence<M>> => {
  const entries: Array<ScopeEntry & { loaded: boolean }> = []
  const seen = new Set<string>()
  const loadedIds = new Set<string>()
  const traces = new Map<string, ResolvedTrace[]>()
  let loadedTokens = 0
  let loadedCount = 0
  let resolveAttempts = 0
  let stopReason: ResolveStopReason = 'exhausted'
  let stopGroup: number | null = null

  const stop = (reason: Exclude<ResolveStopReason, 'exhausted'>, groupIndex: number) => {
    if (stopGroup == null) {
      stopReason = reason
      stopGroup = groupIndex
    }
  }

  const addKnown = (entry: ScopeEntry, groupIndex: number) => {
    if (seen.has(entry.noteId)) {
      return
    }
    seen.add(entry.noteId)

    if (stopGroup != null) {
      entries.push({ ...entry, loaded: false })
      return
    }
    if (loadedCount >= SCOPE_ITEM_CAP) {
      stop('item-cap', groupIndex)
      entries.push({ ...entry, loaded: false })
      return
    }
    if (loadedTokens + entry.tokens > budget) {
      stop('budget', groupIndex)
      entries.push({ ...entry, loaded: false })
      return
    }
    loadedCount += 1
    loadedTokens += entry.tokens
    loadedIds.add(entry.noteId)
    entries.push({ ...entry, loaded: true })
  }

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    if (stopGroup != null && groups[groupIndex].kind === CONTEXT_ENTRY_KIND.set) {
      continue
    }
    const iterator = groups[groupIndex].entries[Symbol.iterator]()

    while (true) {
      if (groups[groupIndex].kind === CONTEXT_ENTRY_KIND.set) {
        if (stopGroup != null) {
          break
        }
        if (loadedCount >= SCOPE_ITEM_CAP) {
          stop('item-cap', groupIndex)
          break
        }
        if (resolveAttempts >= SCOPE_ITEM_CAP) {
          stop('resolve-cap', groupIndex)
          break
        }
      }
      const next = iterator.next()

      if (next.done) {
        break
      }
      const ref = next.value

      if (ref.kind === 'pin') {
        addKnown(ref.entry, groupIndex)
        continue
      }
      const item = await ref.resolve()
      resolveAttempts += 1
      const trace: ResolvedTrace = {
        setIdx: ref.setIdx,
        sourceIndex: ref.sourceIndex,
        rawNoteId: ref.rawNoteId,
        canonicalNoteId: item?.noteId ?? null,
      }
      const bucket = traces.get(ref.bucket) ?? []
      bucket.push(trace)
      traces.set(ref.bucket, bucket)

      if (item && !seen.has(item.noteId)) {
        addKnown(
          {
            ...item,
            bucket: ref.bucket,
            setIdx: ref.setIdx,
            sourceIndex: ref.sourceIndex,
          },
          groupIndex,
        )
      }
      if (resolveAttempts >= SCOPE_ITEM_CAP && stopGroup == null) {
        stop('resolve-cap', groupIndex)
      }
    }
  }

  const memoryOut = memory.map((item) => ({ ...item, loaded: false }))

  if (stopGroup == null) {
    for (let index = 0; index < memory.length; index += 1) {
      const item = memory[index]

      if (item.muted) {
        continue
      }
      if (loadedCount >= SCOPE_ITEM_CAP) {
        stopReason = 'item-cap'
        stopGroup = groups.length
        break
      }
      if (loadedTokens + item.tokens > budget) {
        stopReason = 'budget'
        stopGroup = groups.length
        break
      }
      memoryOut[index].loaded = true
      loadedCount += 1
      loadedTokens += item.tokens
    }
  }

  return { entries, memory: memoryOut, loadedTokens, loadedIds, traces, stopReason, stopGroup }
}

/** Re-bucket processed survivors into curated pins + set audit windows. Raw set
 * membership stays intact in counters even when access degradation or a hard stop means
 * a row is absent from the weighed preview. */
const rebucket = (
  result: CuratedSequence<CuratableMemory>,
  groups: ScopeGroup[],
  groupOffset: number,
  pinBucket: string,
  setBucket: string,
  sets: ScopeSetInput[],
): { pins: CuratedPin[]; sets: CuratedSet[] } => {
  const pinPos = new Map(
    groups.filter((g) => g.kind === CONTEXT_ENTRY_KIND.pin).map((g) => [g.ref, g.pos]),
  )
  const setPos = new Map(
    groups.filter((g) => g.kind === CONTEXT_ENTRY_KIND.set).map((g) => [g.setIdx, g.pos]),
  )
  const pins = result.entries
    .filter((e) => e.bucket === pinBucket)
    // Carry `space` only for a CROSS-SPACE pin — a local tag pin has space ''
    // and stays space-less on the wire (undefined = same-space).
    .map((e) => ({
      noteId: e.noteId,
      title: e.title,
      tokens: e.tokens,
      loaded: e.loaded,
      order: pinPos.get(e.noteId) ?? 0,
      ...(e.space ? { space: e.space } : {}),
      ...(e.folderPage ? { folderPage: true as const } : {}),
    }))
  const setGroupIndex = new Map(
    groups
      .map((group, index) => ({ group, index: groupOffset + index }))
      .filter(({ group }) => group.kind === CONTEXT_ENTRY_KIND.set)
      .map(({ group, index }) => [group.setIdx, index]),
  )
  const traces = result.traces.get(setBucket) ?? []
  const setsOut = sets.map((s, i) => {
    const rows = result.entries
      .filter((e) => e.bucket === setBucket && e.setIdx === i)
      .map((e) => ({
        noteId: e.noteId,
        title: e.title,
        tokens: e.tokens,
        space: e.space,
        loaded: e.loaded,
        order: e.sourceIndex ?? 0,
        sourceIndex: e.sourceIndex ?? 0,
        ...(e.folderPage ? { folderPage: true as const } : {}),
      }))
    const represented = new Set(rows.map((row) => row.sourceIndex))
    let itemsCursor = 0

    while (itemsCursor < s.items.length && represented.has(itemsCursor)) {
      itemsCursor += 1
    }
    const setTraces = traces.filter((trace) => trace.setIdx === i)
    const groupIndex = setGroupIndex.get(i) ?? Number.POSITIVE_INFINITY
    const coordinatesVisible = isResolvedSet(s) ? true : s.coordinatesVisible

    return {
      id: s.id,
      name: s.name,
      homeSpace: s.homeSpace,
      order: setPos.get(i) ?? 0,
      items: rows,
      itemsTotal: s.items.length,
      itemsLoaded: setTraces.filter(
        (trace) => trace.canonicalNoteId != null && result.loadedIds.has(trace.canonicalNoteId),
      ).length,
      itemsCursor,
      trimmed: s.items.length > 0 && result.stopGroup != null && groupIndex >= result.stopGroup,
      coordinatesVisible,
    }
  })
  return { pins, sets: setsOut }
}

const sumLoaded = (arr: ReadonlyArray<{ loaded: boolean; tokens: number }>) =>
  arr.reduce((s, x) => s + (x.loaded ? x.tokens : 0), 0)

type ScopeLayer = {
  pins: WeighedPin[]
  sets: ScopeSetInput[]
  order: ScopeOrder
}

type CuratedLayer = {
  pins: CuratedPin[]
  sets: CuratedSet[]
  loadedTokens: number
}

/** Curate an arbitrary specific→general layer sequence under one envelope. This is the
 * structural primitive behind Personal, Project→Personal and Role→Project→Personal;
 * dedup and strict-prefix trimming happen once across the whole live session. */
const curateLayers = async <M extends CuratableMemory>(
  layers: ScopeLayer[],
  memory: M[],
  budget: number,
): Promise<{
  layers: CuratedLayer[]
  memory: Array<M & { loaded: boolean }>
  loadedTokens: number
  stopReason: ResolveStopReason
}> => {
  const groups = layers.map((layer, index) =>
    orderGroups(layer.pins, `layer-${index}-pin`, layer.sets, `layer-${index}-set`, layer.order),
  )
  const flatGroups = groups.flat()
  const result = await curateSequence(flatGroups, memory, budget)
  let groupOffset = 0
  const curated = layers.map((layer, index): CuratedLayer => {
    const rebucketed = rebucket(
      result,
      groups[index],
      groupOffset,
      `layer-${index}-pin`,
      `layer-${index}-set`,
      layer.sets,
    )
    groupOffset += groups[index].length

    return {
      ...rebucketed,
      loadedTokens: sumLoaded([...rebucketed.pins, ...rebucketed.sets.flatMap((set) => set.items)]),
    }
  })

  return {
    layers: curated,
    memory: result.memory,
    loadedTokens: result.loadedTokens,
    stopReason: result.stopReason,
  }
}

/** Curate a PERSONAL scope: pins + set items in the user's ORDER, then the eager memory
 *  summaries, deduped and trimmed to the SINGLE budget. The order is also the load
 *  PRIORITY — a higher entry survives the trim. */
export const curatePersonalScope = async <M extends CuratableMemory>(
  pins: WeighedPin[],
  sets: ScopeSetInput[],
  memory: M[],
  budget: number,
  order: ScopeOrder = [],
  role?: RoleScopeInput,
): Promise<{
  pins: CuratedPin[]
  sets: CuratedSet[]
  role?: CuratedRoleScope
  memory: Array<M & { loaded: boolean }>
  loadedTokens: number
  stopReason: ResolveStopReason
}> => {
  const result = await curateLayers(
    [
      ...(role ? [{ pins: role.pins, sets: role.sets, order: role.order ?? [] }] : []),
      { pins, sets, order },
    ],
    memory,
    budget,
  )
  const roleLayer = role ? result.layers[0] : undefined
  const personalLayer = result.layers[role ? 1 : 0]

  return {
    pins: personalLayer.pins,
    sets: personalLayer.sets,
    ...(roleLayer ? { role: roleLayer } : {}),
    memory: result.memory,
    loadedTokens: result.loadedTokens,
    stopReason: result.stopReason,
  }
}

/** Curate a PROJECT scope: the project's own pins + sets load FIRST (specific > general),
 *  then the PERSONAL background embeds into whatever of the single budget remains
 *  (re-trimmed against Q − projectLoaded). One deduped sequence — a note pinned in the
 *  project AND carried by a personal set loads once, project wins.
 */
export const curateProjectScope = async <M extends CuratableMemory>(
  projectPins: WeighedPin[],
  projectSets: ScopeSetInput[],
  personalPins: WeighedPin[],
  personalSets: ScopeSetInput[],
  personalMemory: M[],
  budget: number,
  projectOrder: ScopeOrder = [],
  personalOrder: ScopeOrder = [],
  role?: RoleScopeInput,
): Promise<{
  pins: CuratedPin[]
  sets: CuratedSet[]
  role?: CuratedRoleScope
  projectLoadedTokens: number
  personal: {
    pins: CuratedPin[]
    sets: CuratedSet[]
    memory: Array<M & { loaded: boolean }>
    loadedTokens: number
  }
  loadedTokens: number
  stopReason: ResolveStopReason
}> => {
  const result = await curateLayers(
    [
      ...(role ? [{ pins: role.pins, sets: role.sets, order: role.order ?? [] }] : []),
      { pins: projectPins, sets: projectSets, order: projectOrder },
      { pins: personalPins, sets: personalSets, order: personalOrder },
    ],
    personalMemory,
    budget,
  )
  const roleLayer = role ? result.layers[0] : undefined
  const project = result.layers[role ? 1 : 0]
  const personal = result.layers[role ? 2 : 1]
  const personalLoadedTokens =
    personal.loadedTokens + sumLoaded(result.memory.filter((item) => !item.muted))
  return {
    pins: project.pins,
    sets: project.sets,
    ...(roleLayer ? { role: roleLayer } : {}),
    projectLoadedTokens: project.loadedTokens,
    personal: {
      pins: personal.pins,
      sets: personal.sets,
      memory: result.memory,
      loadedTokens: personalLoadedTokens,
    },
    loadedTokens: result.loadedTokens,
    stopReason: result.stopReason,
  }
}

/** Shared group-order producer for the unbudgeted role identity door. It intentionally
 * does not deduplicate set membership or invent load verdicts. */
export const scopeLayerOrder = (
  pins: WeighedPin[],
  sets: ScopeSetInput[],
  order: ScopeOrder = [],
): { pinOrder: Map<string, number>; setOrder: Map<string, number> } => {
  const groups = orderGroups(pins, 'pin', sets, 'set', order)

  return {
    pinOrder: new Map(
      groups
        .filter((group) => group.kind === CONTEXT_ENTRY_KIND.pin)
        .map((group) => [group.ref, group.pos]),
    ),
    setOrder: new Map(
      groups
        .filter((group) => group.kind === CONTEXT_ENTRY_KIND.set)
        .map((group) => [group.ref, group.pos]),
    ),
  }
}

/** The read-only AUTO index of a project: the note count + top-level folder count the
 *  agent loads for free when working in this project (the pult's "Auto: index" line). */
export const projectIndexSummary = async (
  store: KnowledgeStore,
  projectPath: string,
): Promise<{ noteCount: number; folderCount: number }> => {
  const all = (await store.list({ scope: READ_SCOPE.user })).filter((m) => m.id != null)
  const visible = projectPath ? all.filter((m) => isPathUnder(m.filePath, projectPath)) : all
  const dirs = store.listDirs ? await store.listDirs() : []
  const childFolders = treeChildren(all, dirs, { path: projectPath, offset: 0, limit: 0 }).folders
  // Covers are not contents, and this number is the pult's promise to show EXACTLY what
  // the agent loads — `start_session` stopped counting them, so this has to as well or
  // the two halves of one claim disagree by the number of pages in the subtree.
  return {
    noteCount: visible.filter((m) => !isFolderPageOf(m.filePath, m.class)).length,
    folderCount: childFolders.length,
  }
}

type PinMutationStore = Pick<SpaceStore, 'mutateTags' | 'read'>

/** Manual pin/unpin and lifecycle auto-pin share one process-local FIFO per note.
 * A conditional lifecycle task reserves invocation order before resolving
 * identity, then waits for the lock-owned project transition outcome. */
const pinMutationTails = new WeakMap<object, Map<string, Promise<void>>>()
const pinReservationTails = new WeakMap<object, Promise<void>>()

const enqueuePinMutation = <T>(
  store: PinMutationStore,
  id: string,
  operation: () => Promise<T>,
): Promise<T> => {
  let storeTails = pinMutationTails.get(store)

  if (!storeTails) {
    storeTails = new Map()
    pinMutationTails.set(store, storeTails)
  }
  const previous = storeTails.get(id) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const tail = result.then(
    () => {},
    () => {},
  )
  storeTails.set(id, tail)
  void tail.then(() => {
    if (storeTails?.get(id) === tail) {
      storeTails.delete(id)
    }
  })
  return result
}

const applyPinnedDelta = async (
  store: PinMutationStore,
  id: string,
  pinned: boolean,
  principal?: string,
): Promise<{ pinned: boolean; changed: boolean }> => {
  const result = await store.mutateTags({
    id,
    ...(pinned ? { add: [ALWAYS_LOAD_TAG] } : { remove: [ALWAYS_LOAD_TAG] }),
    principal,
  })
  return { pinned, changed: result.changed }
}

/** Resolve a possibly provisional boot id before choosing the process-local FIFO
 * key. CachedStore also canonicalizes inside mutateTags, but doing it only there
 * is too late: provisional and durable spellings would reserve different queues. */
const authoritativePinId = async (store: PinMutationStore, id: string): Promise<string> => {
  const note = await store.read(id)
  return note.id ?? id
}

/** Preserve invocation order before identity resolution yields. The short
 * per-store reservation lane serializes only authoritative reads + insertion
 * into the durable-id FIFO; the mutations themselves keep per-note concurrency.
 * This closes P→D rekey races without turning every pin write into a global lock. */
const reservePinMutation = <T>(
  store: PinMutationStore,
  id: string,
  operation: (authoritativeId: string) => Promise<T>,
): Promise<T> => {
  let resolveCompletion!: (value: T | PromiseLike<T>) => void
  let rejectCompletion!: (reason?: unknown) => void
  const completion = new Promise<T>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  const previous = pinReservationTails.get(store) ?? Promise.resolve()
  const reservation = previous.then(async () => {
    try {
      const authoritativeId = await authoritativePinId(store, id)
      const result = enqueuePinMutation(store, authoritativeId, () => operation(authoritativeId))
      void result.then(resolveCompletion, rejectCompletion)
    } catch (err) {
      rejectCompletion(err)
    }
  })
  const tail = reservation.then(
    () => {},
    () => {},
  )

  pinReservationTails.set(store, tail)
  void tail.then(() => {
    if (pinReservationTails.get(store) === tail) {
      pinReservationTails.delete(store)
    }
  })
  return completion
}

/** Toggle `always-load` through the shared per-note FIFO. */
export const setNotePinned = (
  store: PinMutationStore,
  id: string,
  pinned: boolean,
  principal?: string,
): Promise<{ pinned: boolean; changed: boolean }> =>
  reservePinMutation(store, id, (authoritativeId) =>
    applyPinnedDelta(store, authoritativeId, pinned, principal),
  )

/** Reserve an auto-pin in the same FIFO before a project mark. The gate may wait
 * for the mark lock, but no note mutation claim is held while it does. */
export const enqueueConditionalNotePin = (
  store: PinMutationStore,
  id: string,
  transition: Promise<boolean>,
  principal?: string,
): { completion: Promise<{ pinned: boolean; changed: boolean }> } => ({
  completion: reservePinMutation(store, id, async (authoritativeId) =>
    (await transition)
      ? applyPinnedDelta(store, authoritativeId, true, principal)
      : { pinned: true, changed: false },
  ),
})

/** The note's current storage basename (sans `.md`) to hand back to `store.write` so a
 *  metadata-only edit keeps the file in place; undefined when the path is unknown. */
const pinFileName = (filePath: string | undefined): string | undefined => {
  if (!filePath) {
    return undefined
  }

  return basenameOf(filePath).replace(/\.md$/, '')
}

/** Toggle memory opt-out. The first read derives the fence key; the second supplies the
 *  entire CAS payload. Conflicts are not retried.
 *  canon: docs/projects.md#memory-two-axes · docs/note-model.md#agent-memory */
export const setNoteMuted = async (
  store: KnowledgeStore,
  id: string,
  muted: boolean,
  principal?: string,
): Promise<{ muted: boolean; changed: boolean }> => {
  const keyed = await store.read(id)

  // No path, no partition: `?? ''` would aim the key at the about-user root, missing
  // rememberAboutProject's fence and falsely serialising rememberAboutUser's.
  if (!keyed.filePath || !keyed.title) {
    const err = new Error(`cannot resolve the memory category of note ${id}`) as Error & {
      isToolError: boolean
    }

    err.isToolError = true
    throw err
  }

  return withMemoryCategoryFence(
    store,
    { subdir: memoryDirOf(keyed.filePath), category: keyed.title },
    async () => {
      const note = await store.read(id)
      const noteId = note.id ?? id
      const was = note.frontmatter?.muted === true || note.frontmatter?.muted === 'true'

      if (was === muted) {
        return { muted, changed: false }
      }
      await store.write({
        title: note.title ?? '',
        content: note.content,
        originalId: noteId,
        versionToken: note.versionToken ?? '',
        muted,
        principal,
        // A mute toggle is a metadata touch — keep the file's basename (see setNotePinned).
        fileName: pinFileName(note.filePath),
      })
      return { muted, changed: true }
    },
  )
}
