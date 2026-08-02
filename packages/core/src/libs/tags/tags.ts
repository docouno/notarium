import type { TagFacetNode } from './types'

/**
 * Normalise a note's tags to a string array. Frontmatter may carry tags as a
 * YAML list or a comma-separated string; anything else means "no tags".
 */
export const normTags = (tags: unknown): string[] | undefined => {
  if (Array.isArray(tags)) {
    return tags as string[]
  }
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  }

  return undefined
}

/**
 * The tag matching/grouping key — tags are an axis of NAVIGATION, folded
 * like the slug algebra (`slugify`) so `ML` and `ml` share one bucket: one shared
 * function everywhere a tag is matched, faceted or de-duplicated, so the wire keeps
 * authored casing for DISPLAY while the index agrees on identity.
 * @see docs/note-model.md#note-ontology
 * Hierarchical tags split on `/`; each segment is trimmed + lowercased and empty
 * segments collapse, so `Work / Projects ` and `work/projects` fold equal.
 * NON-destructive: the stored frontmatter tag is never rewritten — folding happens
 * at read time only.
 */
export const foldTag = (tag: string): string =>
  tag
    .split('/')
    .map((seg) => seg.trim().toLowerCase())
    .filter(Boolean)
    .join('/')

/**
 * Does a note (carrying `noteTags`) satisfy a single query tag, HIERARCHICALLY?
 * A query `ml` matches a note tagged `ml` (exact) OR `ml/nlp`, `ml/nlp/bert`
 * (descendants) — the same subtree-cascade the folder facet uses, so clicking a
 * parent tag pulls its whole subtree. Both sides are folded first. An empty
 * query tag (a stray `tags=`) matches nothing.
 */
export const noteHasTag = (noteTags: readonly string[] | undefined, queryTag: string): boolean => {
  const want = foldTag(queryTag)

  if (!want || !noteTags?.length) {
    return false
  }
  for (const t of noteTags) {
    const have = foldTag(t)

    if (have === want || have.startsWith(want + '/')) {
      return true
    }
  }

  return false
}

/**
 * The filter predicate for a tag set: a note passes when it satisfies ANY
 * query tag (OR — the union "add to see more" model, unified with the folder facet;
 * across facets — folder ∧ tag — it's still AND), each matched hierarchically (see
 * `noteHasTag`). An empty/absent query set is no constraint (every note passes).
 * @see docs/note-model.md#note-ontology
 */
export const matchesTags = (
  noteTags: readonly string[] | undefined,
  queryTags: readonly string[] | undefined,
): boolean => {
  if (!queryTags?.length) {
    return true
  }

  return queryTags.some((q) => noteHasTag(noteTags, q))
}

/**
 * Build the tag facet from a set of notes' raw tag lists — the single
 * shared shaper behind the server's `GET /tags` and the graph's client-side tag
 * pane, so the two never disagree on counts or hierarchy. Each tag folds (see
 * `foldTag`) into a `/`-path whose every ancestor is a node: `count` is the
 * whole-subtree note population (a note tagged `ml/nlp` counts for `ml` too),
 * `direct` only the notes tagged exactly this node. Per-note dedupe — a note
 * tagged both `ml` and `ml/nlp` counts ONCE for the `ml` subtree. `label` keeps
 * the first-seen author casing (deterministic over a stable input order).
 * `q` substring-filters the folded path; `limit` caps to the top-N by count.
 * `total` is the distinct-node count BEFORE the limit cut (so a UI shows "+N").
 * Visibility is the caller's job — pass an already class-scoped list.
 */
export const buildTagFacet = (
  tagLists: readonly (readonly string[] | undefined)[],
  opts?: { q?: string; limit?: number },
): { tags: TagFacetNode[]; total: number } => {
  const direct = new Map<string, number>()
  const subtree = new Map<string, number>()
  const labels = new Map<string, string>() // folded node path → display last-segment

  for (const tags of tagLists) {
    if (!tags?.length) {
      continue
    }
    // Per-note sets so a repeated tag / an ancestor-also-present can't double-count.
    const exact = new Set<string>()
    const nodes = new Set<string>()

    for (const raw of tags) {
      const origSegs = raw
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean)
      const foldSegs = origSegs.map((s) => s.toLowerCase())

      if (!foldSegs.length) {
        continue
      }
      exact.add(foldSegs.join('/'))
      let acc = ''

      for (let i = 0; i < foldSegs.length; i++) {
        acc = acc ? `${acc}/${foldSegs[i]}` : foldSegs[i]
        nodes.add(acc)
        // First-seen casing wins — deterministic over a stable input order.
        if (!labels.has(acc)) {
          labels.set(acc, origSegs[i])
        }
      }
    }
    for (const p of exact) {
      direct.set(p, (direct.get(p) || 0) + 1)
    }
    for (const p of nodes) {
      subtree.set(p, (subtree.get(p) || 0) + 1)
    }
  }

  let nodes: TagFacetNode[] = [...subtree.keys()].map((tag) => ({
    tag,
    label: labels.get(tag) ?? tag.split('/').pop()!,
    count: subtree.get(tag)!,
    direct: direct.get(tag) || 0,
  }))

  const q = opts?.q ? foldTag(opts.q) : ''

  if (q) {
    nodes = nodes.filter((n) => n.tag.includes(q))
  }
  const total = nodes.length
  // Most-used first, then name — the natural tag-pane order and the basis for the
  // top-N truncation; nesting is by `tag` path on the client, independent of order.
  nodes.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  if (opts?.limit !== undefined) {
    nodes = nodes.slice(0, opts.limit)
  }

  return { tags: nodes, total }
}
