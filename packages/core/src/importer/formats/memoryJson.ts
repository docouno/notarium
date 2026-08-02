// MCP `memory.json` → notes. The `@modelcontextprotocol/server-memory`
// knowledge graph is JSONL (one object per LINE, not an array): `entity` and
// `relation` records. One entity → one note; observations become bullet lines,
// outgoing relations become `- <relType> [[target]]` wikilinks — so an imported
// memory graph LIGHTS UP our graph view for free (we derive edges from [[...]]).

import { IMPORT_SOURCE } from '../consts'
import { cappedSlug } from '../helpers/format'
import type { ImportNote } from '../types'

type Entity = { name: string; entityType: string; observations: string[] }
type Relation = { from: string; to: string; relationType: string }

const asEntity = (o: Record<string, unknown>): Entity | null => {
  const name = (o.name ?? o.entityName ?? o.id) as string | undefined

  if (!name || typeof name !== 'string') {
    return null
  }
  const entityType = (o.entityType ?? o.type ?? 'entity') as string
  const obs = Array.isArray(o.observations)
    ? (o.observations as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  return { name, entityType: String(entityType) || 'entity', observations: obs }
}

const asRelation = (o: Record<string, unknown>): Relation | null => {
  const from = (o.from ?? o.from_id) as string | undefined
  const to = (o.to ?? o.to_id) as string | undefined
  const relationType = (o.relationType ?? o.relation_type ?? 'related to') as string

  if (!from || !to) {
    return null
  }

  return { from: String(from), to: String(to), relationType: String(relationType) }
}

/** Streaming accumulator for the memory graph. The MCP server's memory.json
 *  is JSONL and the graph needs both passes (entities, then their outgoing
 *  relations), so the streaming importer feeds it one parsed line-object at a
 *  time via `add()` and reads the notes out with `toNotes()` at EOF. The state is
 *  bounded by the GRAPH size (entities + relations), not the file's raw bytes —
 *  so a memory.json larger than V8's 512 MB single-string limit still imports. */
export class MemoryGraph {
  private entities = new Map<string, Entity>()
  private relationsBySource = new Map<string, Relation[]>()
  skipped = 0

  /** Feed one parsed JSONL record (an entity or relation). */
  add(obj: Record<string, unknown>): void {
    if (obj.type === 'relation' || obj.relationType || obj.relation_type) {
      const r = asRelation(obj)

      if (r) {
        const bucket = this.relationsBySource.get(r.from) ?? []
        bucket.push(r)
        this.relationsBySource.set(r.from, bucket)
      }

      return
    }
    const e = asEntity(obj)

    if (!e) {
      this.skipped++
      return
    }
    this.entities.set(e.name, e) // last write wins on a duplicate name
  }

  /** Feed the OTHER common shape: a single object `{entities:[…],
   *  relations:[…]}` (what `read_graph` returns / many hand-saved memory.json),
   *  not JSONL. Routes each member through `add` (entities first, then relations
   *  — `add` discriminates by shape). */
  ingestObject(obj: { entities?: unknown; relations?: unknown }): void {
    const ents = Array.isArray(obj.entities) ? obj.entities : []
    const rels = Array.isArray(obj.relations) ? obj.relations : []

    for (const e of ents) {
      if (e && typeof e === 'object') {
        this.add(e as Record<string, unknown>)
      }
    }
    for (const r of rels) {
      if (r && typeof r === 'object') {
        this.add({ ...(r as Record<string, unknown>), type: 'relation' })
      }
    }
  }

  toNotes(): ImportNote[] {
    const notes: ImportNote[] = []

    for (const e of this.entities.values()) {
      const lines: string[] = []

      for (const obs of e.observations) {
        lines.push(`- ${obs}`)
      }
      for (const r of this.relationsBySource.get(e.name) ?? []) {
        lines.push(`- ${r.relationType} [[${r.to}]]`)
      }
      notes.push({
        title: e.name,
        body: lines.join('\n'),
        directory: `memory/${cappedSlug(e.entityType, 40) || 'entity'}`,
        tags: ['memory', e.entityType].filter(Boolean),
        noteType: e.entityType,
        // memory.json carries no timestamps — dates fall back to import time.
        // The entity name IS the identity (idempotent); capped for the OS limit.
        fileName: cappedSlug(e.name) || 'entity',
        source: IMPORT_SOURCE.memory,
      })
    }

    return notes
  }

  warnings(): string[] {
    const w: string[] = []

    if (this.skipped) {
      w.push(
        `memory-json: skipped ${this.skipped} entit${this.skipped === 1 ? 'y' : 'ies'} with no name`,
      )
    }
    if (!this.entities.size) {
      w.push('memory-json: no entities found')
    }

    return w
  }
}

export const parseMemoryJson = (raw: string): { notes: ImportNote[]; warnings: string[] } => {
  const graph = new MemoryGraph()
  // The single-object shape `{entities:[…],relations:[…]}` (a whole-graph JSON,
  // not JSONL) — feed it directly; otherwise treat the input as JSONL.
  const trimmed = raw.trim()

  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed)

      if (obj && (Array.isArray(obj.entities) || Array.isArray(obj.relations))) {
        graph.ingestObject(obj)
        return { notes: graph.toNotes(), warnings: graph.warnings() }
      }
    } catch {
      /* not a single object — fall through to JSONL */
    }
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()

    if (!t) {
      continue
    }
    try {
      graph.add(JSON.parse(t))
    } catch {
      /* skip a malformed line */
    }
  }

  return { notes: graph.toNotes(), warnings: graph.warnings() }
}
