// recall: assemble a token-budgeted context bundle around a query — the FTS-relevant notes
// (seeds) plus their graph neighbours (depth hops), ranked and truncated to the budget. A core
// helper over the port (composes search + graph + read). Walks the agentRecall classes; every
// candidate's class is re-checked after read() as defence-in-depth (a direct id read isn't
// visibility-scoped, so this is the belt to the search/graph braces). v1 ranking (coarse):
// rankScore = ftsScore − HOP_PENALTY·hop + (neighbour in a seed's community ? BOOST : 0); token
// cost ≈ chars ÷ 4. The transport sanitises the assembled text on the way out (length-preserving,
// so the budget stays honest).
// canon: docs/note-model.md#agent-memory

import { NOTE_CLASS, READ_SCOPE } from '../../knowledgeStore'
import type { Graph, NoteContent, NoteMeta } from '../../knowledgeStore'
import { isPathUnder } from '../../libs/path'
import { isInScope } from '../../visibility'
import { isMutedFlag, memoryDirOf } from '../memory'
import type {
  RecallCandidate,
  RecallNarrow,
  RecallOpInput,
  RecallResult,
  RecallSourceItem,
  RecallTarget,
} from './types'

/** A seed makes the hop penalty dwarf any realistic FTS score, so every seed
 *  outranks every neighbour; the community boost is smaller still, so it only
 *  reorders neighbours WITHIN a hop level. Coarse by design (spec §4). */
const HOP_PENALTY = 1_000
const COMMUNITY_BOOST = 0.5

/** The composite v1 rank score (higher = more relevant). */
export const rankScore = (c: RecallCandidate): number =>
  c.score - HOP_PENALTY * c.hop + (c.hop > 0 && c.sameCommunity ? COMMUNITY_BOOST : 0)

/** BFS the space graph out from the FTS seeds to `depth` hops, producing the
 *  per-space candidate list. PURE — no I/O. Seeds are hop 0 (their FTS score);
 *  neighbours discovered at increasing hops carry hop + a community-match flag.
 *  Links are treated UNDIRECTED (a note a seed links to, and one that links to a
 *  seed, are both context). Ghost targets (unresolved wikilinks — no note to
 *  read) and already-visited ids are skipped. */
export const planNeighbours = (
  seeds: Array<{ id: string; score: number }>,
  graph: Graph,
  depth: number,
): RecallCandidate[] => {
  // Only real nodes are reachable context (a ghost has no note behind it).
  const realIds = new Set<string>()
  const community = new Map<string, number>()

  for (const n of graph.nodes) {
    if (n.ghost) {
      continue
    }
    realIds.add(n.id)
    if (typeof n.community === 'number') {
      community.set(n.id, n.community)
    }
  }
  // Undirected adjacency among real nodes.
  const adj = new Map<string, Set<string>>()

  const addEdge = (a: string, b: string): void => {
    if (!realIds.has(a) || !realIds.has(b)) {
      return
    }
    let set = adj.get(a)

    if (!set) {
      set = new Set()
      adj.set(a, set)
    }
    set.add(b)
  }

  for (const l of graph.links) {
    addEdge(l.source, l.target)
    addEdge(l.target, l.source)
  }
  // The communities the seeds sit in (a seed not in the graph — agent-memory is
  // never a graph node — contributes none).
  const seedCommunities = new Set<number>()

  for (const s of seeds) {
    const c = community.get(s.id)

    if (c !== undefined) {
      seedCommunities.add(c)
    }
  }

  const candidates: RecallCandidate[] = []
  const visited = new Set<string>()
  let frontier: string[] = []

  for (const s of seeds) {
    if (visited.has(s.id)) {
      continue
    }
    visited.add(s.id)
    candidates.push({ noteId: s.id, hop: 0, score: s.score, sameCommunity: false })
    frontier.push(s.id)
  }
  for (let hop = 1; hop <= depth && frontier.length; hop++) {
    const next: string[] = []

    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (visited.has(nb)) {
          continue
        }
        visited.add(nb)
        const c = community.get(nb)
        candidates.push({
          noteId: nb,
          hop,
          score: 0,
          sameCommunity: c !== undefined && seedCommunities.has(c),
        })
        next.push(nb)
      }
    }
    frontier = next
  }

  return candidates
}

/** One context block for a source note — the heading carries the title and where
 *  it lives, the body is the note content (sanitised by the gateway on the way
 *  out). Labelled most-specific-first: the project handle if the note is
 *  in one, else its space slug, else the personal domain. */
const renderBlock = (
  title: string,
  space: string | undefined,
  project: string | undefined,
  content: string,
): string => {
  const where = project ? ` (project: ${project})` : space ? ` (${space})` : ' (personal)'
  return `## ${title}${where}\n\n${content}`
}

/** Does a note belong to the narrowed project? agent-memory matches by
 *  its mount-subdir (the project's `.notarium/memory/<id>/`); everything else
 *  (user-docs) matches by living under the project's subtree. */
const matchesNarrow = (meta: NoteMeta, narrow: RecallNarrow): boolean => {
  if (meta.class === NOTE_CLASS.agentMemory) {
    return memoryDirOf(meta.filePath) === narrow.memorySubdir
  }

  return isPathUnder(meta.filePath, narrow.pathPrefix)
}

/** Cap a block at a character budget, with an ellipsis marking the cut. */
const sliceToChars = (block: string, maxChars: number): string => {
  if (block.length <= maxChars) {
    return block
  }

  return `${block.slice(0, Math.max(0, maxChars - 1))}…`
}

/** Cap a single block at the token budget (chars = tokens × 4). Used when the very
 *  top note alone exceeds the budget — recall still returns its most relevant
 *  content rather than nothing. */
const sliceToBudget = (block: string, budgetTokens: number): string =>
  sliceToChars(block, budgetTokens * 4)

/** The default per-source token cap: half the budget, floored, so a
 *  single hyper-large note can't consume the whole bundle even when the agent
 *  didn't ask for a "width" cap. A small floor keeps tiny budgets usable. */
const DEFAULT_PER_SOURCE_FRACTION = 0.5
const PER_SOURCE_FLOOR_TOKENS = 500

const defaultMaxPerSourceTokens = (budgetTokens: number): number =>
  Math.max(PER_SOURCE_FLOOR_TOKENS, Math.ceil(budgetTokens * DEFAULT_PER_SOURCE_FRACTION))

export const recall = async (
  targets: RecallTarget[],
  input: RecallOpInput,
): Promise<RecallResult> => {
  // 1. Per space: FTS seeds (agentRecall) + their graph neighbours → candidates,
  //    tagged with the space they came from.
  type Tagged = RecallCandidate & { slug: string; isPersonal: boolean }
  const candidates: Tagged[] = []

  for (const t of targets) {
    const hits = await t.store.search(input.query, { scope: READ_SCOPE.agentRecall })
    const seeds = hits.filter((h) => h.id).map((h) => ({ id: h.id as string, score: h.score ?? 0 }))

    if (!seeds.length) {
      continue
    }
    // depth 0 = seeds only; skip the (potentially heavy) graph fetch entirely.
    const graph: Graph = input.depth > 0 ? await t.store.graph() : { nodes: [], links: [] }
    let planned = planNeighbours(seeds, graph, input.depth)

    if (t.narrow) {
      // Project-scope narrowing: keep only candidates inside the project — subtree
      // user-docs + THIS project's memory subdir. A candidate filter, NOT a pushed-down `pathPrefix`,
      // because recall walks user-docs UNION agent-memory and the two live under DIFFERENT prefixes
      // (user-docs under `project.path`, memory under `.notarium/memory/<id>/`); one pathPrefix would
      // silently drop the project's own memory. Applied before the budget assembly, so still in-query.
      // v1 limitation: the graph BFS ran over the un-narrowed space, so a depth≥2 in-project node
      // reachable only via an out-of-project hop is pruned (acceptable — depth defaults 1).
      const narrow = t.narrow
      const metaById = new Map<string, NoteMeta>()

      for (const m of await t.store.list({ scope: READ_SCOPE.agentRecall })) {
        if (m.id) {
          metaById.set(m.id, m)
        }
      }
      planned = planned.filter((c) => {
        const m = metaById.get(c.noteId)
        return m ? matchesNarrow(m, narrow) : false
      })
    }
    for (const c of planned) {
      candidates.push({ ...c, slug: t.slug, isPersonal: t.isPersonal })
    }
  }
  // 2. Global rank. One engine kind per host → scores are comparable across the
  //    fanned-out spaces (same assumption search makes). Deterministic tiebreak
  //    on note-id so the bundle is stable run to run.
  candidates.sort((a, b) => {
    const d = rankScore(b) - rankScore(a)

    if (d !== 0) {
      return d
    }

    return a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0
  })

  // 3. Budget-assemble: read each in rank order and accumulate whole notes until
  //    the next one would overflow. The top note is included even if it alone
  //    overflows (sliced to the budget) so recall never returns an empty bundle
  //    for a budget smaller than its best hit.
  //    Accounted in CHARACTERS (budgetTokens × 4 — the v1 «chars ÷ 4» token
  //    estimate, no tokenizer yet) against the ACTUAL assembled length, INCLUDING
  //    the "\n\n" join() inserts between blocks, so context.length never exceeds
  //    the cap (a per-block token ceil with uncounted separators would let a
  //    multi-note bundle drift a few % over).
  const budgetChars = input.budgetTokens * 4
  // Per-source cap ("width"): trim any one note to at most this many chars
  // BEFORE the budget accounting, so a single large note can't eat the whole budget
  // and starve the neighbours that give recall its breadth. Always on — an omitted
  // maxPerSource falls back to half the budget (floored).
  const perSourceChars = (input.maxPerSource ?? defaultMaxPerSourceTokens(input.budgetTokens)) * 4
  const storeBySlug = new Map(targets.map((t) => [t.slug, t]))
  const sources: RecallSourceItem[] = []
  const blocks: string[] = []
  let usedChars = 0
  let truncated = false

  for (const c of candidates) {
    const t = storeBySlug.get(c.slug)

    if (!t) {
      continue
    }
    let note: NoteContent

    try {
      note = await t.store.read(c.noteId)
    } catch {
      continue // moved/removed between the snapshot and the read — skip, never fail recall
    }
    // Defence-in-depth: a direct id read is NOT visibility-scoped, so re-check
    // the class — never emit a chat (or any non-recall) note even if one ever
    // surfaced as a seed/neighbour.
    if (!isInScope(READ_SCOPE.agentRecall, note.class)) {
      continue
    }
    // The human's `muted` opt-out drops a category from the agent's
    // AUTO-pushed context, not just the eager profile: a muted agent-memory category
    // never enters recall either (personal OR project — project memory is recall-on-
    // demand, so this is where its mute bites). It STAYS findable in the explicit
    // pull channels — the `search` tool (the dedup surface) and the REST audit
    // feed — so the human can re-find and un-mute it and the agent won't re-create it.
    if (note.class === NOTE_CLASS.agentMemory && isMutedFlag(note.frontmatter?.muted)) {
      continue
    }
    // Resolve the three-state project handle via the gateway-injected resolver (the
    // op stays registry-agnostic) — drives both the context label and the source.
    const project = note.filePath ? t.projectOf?.(note.filePath, note.class) : undefined
    const full = renderBlock(
      note.title ?? '(untitled)',
      c.isPersonal ? undefined : c.slug,
      project,
      note.content,
    )
    // Apply the per-source cap; a trim means content was dropped → the bundle is
    // truncated (the agent can get the whole note via get_note).
    const block = sliceToChars(full, perSourceChars)

    if (block.length < full.length) {
      truncated = true
    }
    const source: RecallSourceItem = {
      noteId: c.noteId,
      title: note.title ?? '(untitled)',
      ...(c.isPersonal ? {} : { space: c.slug }),
      ...(project ? { project } : {}),
      ...(note.filePath ? { filePath: note.filePath } : {}),
      ...(note.class ? { class: note.class } : {}),
    }
    const sep = blocks.length === 0 ? 0 : 2 // the "\n\n" that will join this block to the prior one

    if (usedChars + sep + block.length <= budgetChars) {
      usedChars += sep + block.length
      blocks.push(block)
      sources.push(source)
      continue
    }
    // The next (already per-source-capped) note still overflows the remaining budget.
    if (blocks.length === 0) {
      blocks.push(sliceToBudget(block, input.budgetTokens))
      sources.push(source)
    }
    truncated = true
    break
  }

  return { context: blocks.join('\n\n'), sources, truncated }
}
