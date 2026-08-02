// The init-context curation surface: the ONE assembly of "what the agent loads at
// session start", shared by the MCP gateway and the REST preview — the pult must show
// EXACTLY what the agent will load, not a parallel re-derivation.
// canon: docs/projects.md#init-context-curation-165-a-idinit-context-curationa

import { CONTEXT_ENTRY_KIND, NOTE_CLASS } from '@notarium/contract'
import {
  basenameOf,
  curateBudget,
  estimateTokens,
  isPathUnder,
  type KnowledgeStore,
  READ_SCOPE,
  treeChildren,
} from '@notarium/core'

import type { ContextSetRecord } from '../metaDb'
import { ALWAYS_LOAD_TAG } from './personalContent'

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
export type WeighedPin = { noteId: string; title: string; tokens: number; space?: string }
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
/** A set after curation. `homeSpace` rides through so the pult addresses the set's CRUD
 *  against its real home; item `order` and set `order` are user-ordered positions. */
export type CuratedSet = {
  id: string
  name: string
  homeSpace: string
  order: number
  items: Array<WeighedSetItem & { loaded: boolean; order: number }>
}

/** Resolve + weigh a scope's context sets under ONE reader, honest degradation: `read`
 *  returns null (reader can't reach the item's space, or the note is gone) → that item
 *  DROPS, the set stands. An empty set is KEPT so the pult can still show it.
 *  canon: docs/architecture.md#p5 */
export const resolveContextSets = async (
  sets: readonly ContextSetRecord[],
  read: (noteId: string) => Promise<{ content: string; title: string; spaceSlug: string } | null>,
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
            noteId: ref.noteId,
            title: note.title,
            tokens: estimateTokens(note.content),
            space: note.spaceSlug,
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
  read: (noteId: string) => Promise<{ content: string; title: string; spaceSlug: string } | null>,
): Promise<WeighedSetItem[]> => {
  const resolved = await Promise.all(
    noteIds.map(async (noteId) => {
      const note = await read(noteId)

      if (!note) {
        return null
      }

      return {
        noteId,
        title: note.title,
        tokens: estimateTokens(note.content),
        space: note.spaceSlug,
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
  return Promise.all(
    tagged.map(async (m) => ({
      noteId: m.id as string,
      title: m.title,
      tokens: estimateTokens((await store.read(m.id as string)).content),
    })),
  )
}

/** The reserved identity note (`class: profile`), loaded FIRST in a personal session.
 *  Weight is 0 on purpose — a free lead, never counted against a scope budget. Null when
 *  the user never saved one. canon: docs/note-model.md#note-classes */
export const personalProfilePin = async (store: KnowledgeStore): Promise<WeighedPin | null> => {
  const note = (await store.list({ scope: READ_SCOPE.all })).find(
    (m) => m.id != null && m.class === NOTE_CLASS.profile,
  )
  return note ? { noteId: note.id as string, title: note.title, tokens: 0 } : null
}

/** A scope's user-defined order: pin+set entries in rank order. Pins and sets share ONE
 *  rank space (a set can outrank a pin); entries absent from the list keep the DEFAULT
 *  sequence (pins, then sets, insertion) AFTER the ranked ones — a self-healing merge. */
export type ScopeOrder = ReadonlyArray<{ kind: 'pin' | 'set'; ref: string }>

const orderKey = (kind: 'pin' | 'set', ref: string) => `${kind}:${ref}`

/** One pin-like entry riding a scope budget (a pin OR a set item), tagged with its
 *  `bucket`/`setIdx` so survivors can be re-bucketed after the joint budgeting. */
type ScopeEntry = WeighedPin & { space: string; bucket: string; setIdx: number }
/** One draggable GROUP of a scope's pin+set list: a pin (one entry) or a set (all its
 *  items, moving together). `pos` is the 0-based wire `order` so the client renders the
 *  interleaved list without re-deriving the sequence. */
type ScopeGroup = {
  kind: 'pin' | 'set'
  ref: string
  setIdx: number
  pos: number
  entries: ScopeEntry[]
}

/** Order a scope's pin+set GROUPS by the user overlay: ranked first, then the unranked in
 *  the default sequence (pins, then sets, insertion). Positions are 0-based over THIS
 *  block — project and embedded-personal blocks are ordered independently (per-panel). */
const orderGroups = (
  pins: WeighedPin[],
  pinBucket: string,
  sets: WeighedSet[],
  setBucket: string,
  order: ScopeOrder,
): ScopeGroup[] => {
  const rank = new Map(order.map((e, i) => [orderKey(e.kind, e.ref), i]))
  const raw: Omit<ScopeGroup, 'pos'>[] = [
    ...pins.map((p) => ({
      kind: CONTEXT_ENTRY_KIND.pin,
      ref: p.noteId,
      setIdx: -1,
      entries: [{ ...p, space: p.space ?? '', bucket: pinBucket, setIdx: -1 }],
    })),
    ...sets.map((s, i) => ({
      kind: CONTEXT_ENTRY_KIND.set,
      ref: s.id,
      setIdx: i,
      entries: s.items.map((it) => ({ ...it, bucket: setBucket, setIdx: i })),
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

/** Dedup an ORDERED entry sequence by note id (first occurrence wins — a note pinned AND
 *  in a set loads ONCE, higher rank wins), then budget survivors jointly with the memory
 *  summaries under ONE budget: the strict prefix that fits is `loaded`. Muted memory is
 *  excluded from the budget but KEPT (loaded:false) so the audit still shows it. */
const budgetSequence = <M extends CuratableMemory>(
  entries: readonly ScopeEntry[],
  memory: M[],
  budget: number,
): {
  entries: Array<ScopeEntry & { loaded: boolean }>
  memory: Array<M & { loaded: boolean }>
  loadedTokens: number
  totalTokens: number
} => {
  const seen = new Set<string>()
  const survivors = entries.filter((e) => (seen.has(e.noteId) ? false : (seen.add(e.noteId), true)))
  const active = memory.filter((m) => !m.muted)
  const weights = [...survivors.map((e) => e.tokens), ...active.map((m) => m.tokens)]
  const { loaded, loadedTokens, totalTokens } = curateBudget(weights, budget, SCOPE_ITEM_CAP)
  const entriesOut = survivors.map((e, i) => ({ ...e, loaded: loaded[i] }))
  const activeLoaded = new Map(active.map((m, k) => [m.noteId, loaded[survivors.length + k]]))
  const memoryOut = memory.map((m) => ({
    ...m,
    loaded: m.muted ? false : (activeLoaded.get(m.noteId) ?? false),
  }))
  return { entries: entriesOut, memory: memoryOut, loadedTokens, totalTokens }
}

/** Re-bucket budgeted survivors into curated pins + sets, stamping each with its
 *  user-order position. An empty set keeps its group position (read from `groups`, not the
 *  items) so a fully-dropped set still renders where the user placed it. */
const rebucket = (
  entries: Array<ScopeEntry & { loaded: boolean }>,
  groups: ScopeGroup[],
  pinBucket: string,
  setBucket: string,
  sets: WeighedSet[],
): { pins: CuratedPin[]; sets: CuratedSet[] } => {
  const pinPos = new Map(
    groups.filter((g) => g.kind === CONTEXT_ENTRY_KIND.pin).map((g) => [g.ref, g.pos]),
  )
  const setPos = new Map(
    groups.filter((g) => g.kind === CONTEXT_ENTRY_KIND.set).map((g) => [g.setIdx, g.pos]),
  )
  const pins = entries
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
    }))
  const setsOut = sets.map((s, i) => ({
    id: s.id,
    name: s.name,
    homeSpace: s.homeSpace,
    order: setPos.get(i) ?? 0,
    items: entries
      .filter((e) => e.bucket === setBucket && e.setIdx === i)
      .map((e, idx) => ({
        noteId: e.noteId,
        title: e.title,
        tokens: e.tokens,
        space: e.space,
        loaded: e.loaded,
        order: idx,
      })),
  }))
  return { pins, sets: setsOut }
}

const sumLoaded = (arr: ReadonlyArray<{ loaded: boolean; tokens: number }>) =>
  arr.reduce((s, x) => s + (x.loaded ? x.tokens : 0), 0)

/** Curate a PERSONAL scope: pins + set items in the user's ORDER, then the eager memory
 *  summaries, deduped and trimmed to the SINGLE budget. The order is also the load
 *  PRIORITY — a higher entry survives the trim. */
export const curatePersonalScope = <M extends CuratableMemory>(
  pins: WeighedPin[],
  sets: WeighedSet[],
  memory: M[],
  budget: number,
  order: ScopeOrder = [],
): {
  pins: CuratedPin[]
  sets: CuratedSet[]
  memory: Array<M & { loaded: boolean }>
  loadedTokens: number
  totalTokens: number
} => {
  const groups = orderGroups(pins, 'pin', sets, 'set', order)
  const res = budgetSequence(
    groups.flatMap((g) => g.entries),
    memory,
    budget,
  )
  const { pins: pinsOut, sets: setsOut } = rebucket(res.entries, groups, 'pin', 'set', sets)
  return {
    pins: pinsOut,
    sets: setsOut,
    memory: res.memory,
    loadedTokens: res.loadedTokens,
    totalTokens: res.totalTokens,
  }
}

/** Curate a PROJECT scope: the project's own pins + sets load FIRST (specific > general),
 *  then the PERSONAL background embeds into whatever of the single budget remains
 *  (re-trimmed against Q − projectLoaded). One deduped sequence — a note pinned in the
 *  project AND carried by a personal set loads once, project wins.
 */
export const curateProjectScope = <M extends CuratableMemory>(
  projectPins: WeighedPin[],
  projectSets: WeighedSet[],
  personalPins: WeighedPin[],
  personalSets: WeighedSet[],
  personalMemory: M[],
  budget: number,
  projectOrder: ScopeOrder = [],
  personalOrder: ScopeOrder = [],
): {
  pins: CuratedPin[]
  sets: CuratedSet[]
  projectLoadedTokens: number
  personal: {
    pins: CuratedPin[]
    sets: CuratedSet[]
    memory: Array<M & { loaded: boolean }>
    loadedTokens: number
  }
  loadedTokens: number
  totalTokens: number
} => {
  const projGroups = orderGroups(projectPins, 'projectPin', projectSets, 'projectSet', projectOrder)
  const persGroups = orderGroups(
    personalPins,
    'personalPin',
    personalSets,
    'personalSet',
    personalOrder,
  )
  const res = budgetSequence(
    [...projGroups, ...persGroups].flatMap((g) => g.entries),
    personalMemory,
    budget,
  )
  const project = rebucket(res.entries, projGroups, 'projectPin', 'projectSet', projectSets)
  const personal = rebucket(res.entries, persGroups, 'personalPin', 'personalSet', personalSets)
  const projectItems = [...project.pins, ...project.sets.flatMap((s) => s.items)]
  const personalItems = [...personal.pins, ...personal.sets.flatMap((s) => s.items)]
  const projectLoadedTokens = sumLoaded(projectItems)
  const personalLoadedTokens =
    sumLoaded(personalItems) + sumLoaded(res.memory.filter((m) => !m.muted))
  return {
    pins: project.pins,
    sets: project.sets,
    projectLoadedTokens,
    personal: {
      pins: personal.pins,
      sets: personal.sets,
      memory: res.memory,
      loadedTokens: personalLoadedTokens,
    },
    loadedTokens: res.loadedTokens,
    totalTokens: res.totalTokens,
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
  return { noteCount: visible.length, folderCount: childFolders.length }
}

/** Toggle the `always-load` tag on a note (pin/unpin): a narrow, CAS-guarded metadata
 *  edit — re-save the current body with the tag set changed (the engine carries the other
 *  frontmatter forward as passthrough). `changed:false` = already in the desired state, a
 *  no-op so the audit isn't churned. canon: docs/contract.md#cas */
export const setNotePinned = async (
  store: KnowledgeStore,
  id: string,
  pinned: boolean,
  principal?: string,
): Promise<{ pinned: boolean; changed: boolean }> => {
  const note = await store.read(id)
  const tags = Array.isArray(note.frontmatter?.tags)
    ? (note.frontmatter.tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : []
  const has = tags.includes(ALWAYS_LOAD_TAG)

  if (has === pinned) {
    return { pinned, changed: false }
  }
  const nextTags = pinned ? [...tags, ALWAYS_LOAD_TAG] : tags.filter((t) => t !== ALWAYS_LOAD_TAG)
  await store.write({
    title: note.title ?? '',
    content: note.content,
    originalId: id,
    versionToken: note.versionToken ?? '',
    tags: nextTags,
    principal,
    // Keep the note's CURRENT basename — a pin toggle is a metadata touch, it must NOT
    // rename the file to slug(title) (a seeded/imported note whose basename diverges
    // from its title would otherwise MOVE, and the reverse toggle would then collide).
    fileName: pinFileName(note.filePath),
  })
  return { pinned, changed: true }
}

/** The note's current storage basename (sans `.md`) to hand back to `store.write` so a
 *  metadata-only edit keeps the file in place; undefined when the path is unknown. */
const pinFileName = (filePath: string | undefined): string | undefined => {
  if (!filePath) {
    return undefined
  }

  return basenameOf(filePath).replace(/\.md$/, '')
}

/** Toggle the `muted` flag on a memory note (mute/unmute): the human opt-out that keeps a
 *  category in the audit but drops it from the agent's eager profile. Narrow, CAS-guarded
 *  metadata edit, body untouched. canon: docs/projects.md#memory-two-axes */
export const setNoteMuted = async (
  store: KnowledgeStore,
  id: string,
  muted: boolean,
  principal?: string,
): Promise<{ muted: boolean; changed: boolean }> => {
  const note = await store.read(id)
  const was = note.frontmatter?.muted === true || note.frontmatter?.muted === 'true'

  if (was === muted) {
    return { muted, changed: false }
  }
  await store.write({
    title: note.title ?? '',
    content: note.content,
    originalId: id,
    versionToken: note.versionToken ?? '',
    muted,
    principal,
    // A mute toggle is a metadata touch — keep the file's basename (see setNotePinned).
    fileName: pinFileName(note.filePath),
  })
  return { muted, changed: true }
}
