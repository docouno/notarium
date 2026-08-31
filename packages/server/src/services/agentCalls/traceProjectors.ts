import { createHash } from 'node:crypto'

import { AGENT_CALL_EFFECT, type AgentCallEffect } from '@notarium/contract'
import type { ToolName } from '@notarium/contract/tools'

import type { AgentTraceJson } from '../metaDb'

type TracePolicy = {
  effect: AgentCallEffect
  domain: string
  compactInput: readonly string[]
  detailedInput: readonly string[]
  byteLengths?: readonly string[]
  result: readonly string[]
}

const policy = (
  effect: AgentCallEffect,
  domain: string,
  compactInput: readonly string[],
  detailedInput: readonly string[],
  result: readonly string[],
  byteLengths: readonly string[] = [],
): TracePolicy => ({ effect, domain, compactInput, detailedInput, result, byteLengths })

/** Adding a tool requires an explicit effect/domain and projection policy. */
export const TRACE_TOOL_POLICY = {
  start_session: policy(
    AGENT_CALL_EFFECT.mutation,
    'session',
    ['project', 'role', 'session.id', 'session.name', 'acknowledge', 'responseFormat'],
    ['project', 'role', 'session.id', 'session.name', 'acknowledge', 'responseFormat'],
    ['session.id', 'session.name', 'session.state', 'session.parentId', 'projects.length'],
    ['task'],
  ),
  list_abilities: policy(
    AGENT_CALL_EFFECT.read,
    'ability',
    ['kind', 'source', 'view', 'project', 'limit'],
    ['kind', 'source', 'view', 'project', 'limit', 'q'],
    ['abilities.length', 'total'],
  ),
  get_ability: policy(
    AGENT_CALL_EFFECT.read,
    'ability',
    ['ref'],
    ['ref'],
    ['ability.name', 'ability.kind', 'ability.source'],
  ),
  create_ability: policy(
    AGENT_CALL_EFFECT.mutation,
    'ability',
    ['kind', 'name', 'scope', 'project'],
    ['kind', 'name', 'scope', 'project', 'enabled'],
    ['ref', 'status'],
    ['instructions', 'description'],
  ),
  edit_ability: policy(
    AGENT_CALL_EFFECT.mutation,
    'ability',
    ['ref', 'operation', 'enabled'],
    ['ref', 'operation', 'enabled', 'scope', 'project'],
    ['ref', 'status'],
    ['instructions', 'description', 'content', 'find'],
  ),
  delete_ability: policy(
    AGENT_CALL_EFFECT.mutation,
    'ability',
    ['ref'],
    ['ref'],
    ['ref', 'status'],
  ),
  use_role: policy(
    AGENT_CALL_EFFECT.mutation,
    'session',
    ['role', 'name', 'project'],
    ['role', 'name', 'project', 'budgetTokens'],
    ['status', 'role.name', 'role.source'],
  ),
  use_skill: policy(
    AGENT_CALL_EFFECT.control,
    'ability',
    ['skill', 'name', 'project'],
    ['skill', 'name', 'project', 'budgetTokens'],
    ['status', 'skill.name', 'skill.source'],
  ),
  whoami: policy(
    AGENT_CALL_EFFECT.read,
    'identity',
    ['session'],
    ['session'],
    ['scope', 'projects.length'],
  ),
  get_my_projects: policy(
    AGENT_CALL_EFFECT.read,
    'project',
    ['session'],
    ['session'],
    ['projects.length'],
  ),
  list_notes: policy(
    AGENT_CALL_EFFECT.read,
    'note',
    ['project', 'path', 'tag', 'limit'],
    ['project', 'path', 'tag', 'limit'],
    ['items.length', 'folders.length', 'total'],
  ),
  recent_activity: policy(
    AGENT_CALL_EFFECT.read,
    'note',
    ['project', 'limit'],
    ['project', 'limit'],
    ['items.length', 'total'],
  ),
  search: policy(
    AGENT_CALL_EFFECT.read,
    'retrieval',
    ['query', 'project', 'class', 'limit', 'responseFormat'],
    ['query', 'project', 'class', 'limit', 'responseFormat'],
    ['results.length'],
  ),
  get_note: policy(
    AGENT_CALL_EFFECT.read,
    'retrieval',
    ['ref', 'responseFormat'],
    ['ref', 'responseFormat'],
    ['noteId', 'title', 'class', 'project', 'space', 'path'],
  ),
  recall: policy(
    AGENT_CALL_EFFECT.read,
    'retrieval',
    ['query', 'project', 'budgetTokens', 'depth', 'maxPerSource'],
    ['query', 'project', 'budgetTokens', 'depth', 'maxPerSource'],
    ['sources.length', 'truncated'],
  ),
  remember_about_user: policy(
    AGENT_CALL_EFFECT.mutation,
    'memory',
    ['category'],
    ['category', 'summary'],
    ['noteId'],
    ['observation'],
  ),
  create_note: policy(
    AGENT_CALL_EFFECT.mutation,
    'note',
    ['project', 'title', 'path', 'type'],
    ['project', 'title', 'path', 'type', 'tags'],
    ['noteId'],
    ['body'],
  ),
  remember_about_project: policy(
    AGENT_CALL_EFFECT.mutation,
    'memory',
    ['project', 'category'],
    ['project', 'category', 'summary'],
    ['noteId'],
    ['observation'],
  ),
  edit_note: policy(
    AGENT_CALL_EFFECT.mutation,
    'note',
    ['ref', 'operation', 'section'],
    ['ref', 'operation', 'section'],
    ['noteId'],
    ['content', 'find'],
  ),
  delete_note: policy(AGENT_CALL_EFFECT.mutation, 'note', ['ref'], ['ref'], ['noteId', 'status']),
  move_note: policy(
    AGENT_CALL_EFFECT.mutation,
    'note',
    ['ref', 'project', 'path'],
    ['ref', 'project', 'path'],
    ['noteId', 'path'],
  ),
  rename_note: policy(
    AGENT_CALL_EFFECT.mutation,
    'note',
    ['ref', 'title'],
    ['ref', 'title'],
    ['noteId', 'title'],
  ),
  move_folder: policy(
    AGENT_CALL_EFFECT.mutation,
    'container',
    ['project', 'path', 'destination'],
    ['project', 'path', 'destination'],
    ['id', 'path'],
  ),
  rename_folder: policy(
    AGENT_CALL_EFFECT.mutation,
    'container',
    ['project', 'path', 'name'],
    ['project', 'path', 'name'],
    ['id', 'path'],
  ),
  rename_project: policy(
    AGENT_CALL_EFFECT.mutation,
    'project',
    ['project', 'slug', 'displayName'],
    ['project', 'slug', 'displayName'],
    ['id', 'handle', 'displayName'],
  ),
  link: policy(
    AGENT_CALL_EFFECT.mutation,
    'link',
    ['from', 'to', 'toTitle', 'relation'],
    ['from', 'to', 'toTitle', 'relation'],
    ['noteId', 'outcome'],
  ),
  create_notes: policy(
    AGENT_CALL_EFFECT.mutation,
    'note',
    ['project', 'notes.length'],
    ['project', 'notes.length'],
    ['results.length'],
  ),
  link_many: policy(
    AGENT_CALL_EFFECT.mutation,
    'link',
    ['links.length'],
    ['links.length'],
    ['results.length'],
  ),
} as const satisfies Record<ToolName, TracePolicy>

const OMITTED_KEYS = /^(?:versionToken|idempotencyKey|authorization|cookie|token|secret|headers?)$/i
const MAX_SHAPE_FIELDS = 64
const MAX_SHAPE_DEPTH = 4
const MAX_PROJECTED_TEXT = 256
const MAX_RETRIEVAL_TEXT = 4096

type ShapeEntry = {
  path: string
  type: string
  count?: string
  stringBytes?: string
}

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8')
const bucket = (value: number): string =>
  value === 0
    ? '0'
    : value <= 16
      ? '1-16'
      : value <= 64
        ? '17-64'
        : value <= 256
          ? '65-256'
          : '257+'

const knownInputPaths = (tool: ToolName | null): Set<string> => {
  if (!tool) {
    return new Set()
  }
  const entry = TRACE_TOOL_POLICY[tool]
  return new Set([
    ...entry.compactInput,
    ...entry.detailedInput,
    ...(entry.byteLengths ?? []),
    'session',
  ])
}

const safeSegment = (
  key: string,
  parent: string,
  allowed: ReadonlySet<string>,
): { segment: string; path: string } => {
  if (OMITTED_KEYS.test(key)) {
    return { segment: '<omitted>', path: parent ? `${parent}.<omitted>` : '<omitted>' }
  }
  const path = parent ? `${parent}.${key}` : key
  const known = [...allowed].some(
    (candidate) =>
      candidate === path || candidate.startsWith(`${path}.`) || path.startsWith(`${candidate}.`),
  )
  return { segment: known ? key : '<field>', path }
}

export const inputShapeOf = (
  value: unknown,
  tool: ToolName | null = null,
): { shape: AgentTraceJson; truncated: boolean } => {
  const fields: ShapeEntry[] = []
  const allowed = knownInputPaths(tool)
  let truncated = false

  const visit = (entry: unknown, path: string, rawPath: string, depth: number): void => {
    if (fields.length >= MAX_SHAPE_FIELDS || depth > MAX_SHAPE_DEPTH) {
      truncated = true
      return
    }
    if (entry === null) {
      fields.push({ path, type: 'null' })
      return
    }
    if (Array.isArray(entry)) {
      fields.push({ path, type: 'array', count: bucket(entry.length) })
      for (const item of entry.slice(0, 4)) {
        visit(item, `${path}[]`, `${rawPath}[]`, depth + 1)
      }
      if (entry.length > 4) {
        truncated = true
      }

      return
    }
    if (typeof entry === 'object') {
      const entries = Object.entries(entry as Record<string, unknown>)
      fields.push({ path, type: 'object', count: bucket(entries.length) })
      for (const [key, child] of entries.slice(0, 16)) {
        if (OMITTED_KEYS.test(key)) {
          continue
        }
        const safe = safeSegment(key, rawPath, allowed)
        visit(child, path ? `${path}.${safe.segment}` : safe.segment, safe.path, depth + 1)
      }
      if (entries.length > 16) {
        truncated = true
      }

      return
    }
    if (typeof entry === 'string') {
      fields.push({ path, type: 'string', stringBytes: bucket(bytes(entry)) })
      return
    }
    fields.push({ path, type: typeof entry })
  }

  visit(value, '$', '', 0)
  return { shape: fields as unknown as AgentTraceJson, truncated }
}

const atPath = (value: unknown, path: string): unknown => {
  let current = value

  for (const segment of path.split('.')) {
    if (segment === 'length') {
      return Array.isArray(current) || typeof current === 'string' ? current.length : undefined
    }
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

const safeScalar = (
  value: unknown,
  max = MAX_PROJECTED_TEXT,
): { value: AgentTraceJson | undefined; truncated: boolean } => {
  if (typeof value === 'string') {
    return { value: value.slice(0, max), truncated: value.length > max }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { value, truncated: false }
  }
  if (typeof value === 'boolean' || value === null) {
    return { value, truncated: false }
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return {
      value: value.slice(0, 20).map((entry) => entry.slice(0, 128)),
      truncated: value.length > 20 || value.some((entry) => entry.length > 128),
    }
  }

  return { value: undefined, truncated: false }
}

const picked = (
  value: unknown,
  paths: readonly string[],
): { value: AgentTraceJson; truncated: boolean } => {
  const result: Record<string, AgentTraceJson> = {}
  let truncated = false

  for (const path of paths) {
    const max = path === 'query' || path === 'ref' ? MAX_RETRIEVAL_TEXT : MAX_PROJECTED_TEXT
    const safe = safeScalar(atPath(value, path), max)

    if (safe.value !== undefined) {
      result[path] = safe.value
      truncated ||= safe.truncated
    }
  }

  return { value: result, truncated }
}

const retrievalHits = (
  tool: ToolName,
  output: unknown,
): { value: AgentTraceJson | undefined; truncated: boolean; redacted: boolean } => {
  const record = output && typeof output === 'object' ? (output as Record<string, unknown>) : null
  const rows = tool === 'search' ? record?.results : tool === 'recall' ? record?.sources : undefined

  if (!Array.isArray(rows)) {
    return { value: undefined, truncated: false, redacted: false }
  }
  let truncated = rows.length > 5
  let redacted = false
  const value = rows.slice(0, 5).flatMap((row) => {
    if (!row || typeof row !== 'object') {
      return []
    }
    const source = row as Record<string, unknown>
    const hit: Record<string, AgentTraceJson> = {}
    redacted ||= Object.keys(source).some(
      (key) => !['noteId', 'title', 'class', 'score'].includes(key),
    )

    for (const key of ['noteId', 'title', 'class', 'score'] as const) {
      const safe = safeScalar(source[key])

      if (safe.value !== undefined) {
        hit[key] = safe.value
        truncated ||= safe.truncated
      }
    }

    return [hit]
  })
  return { value, truncated, redacted }
}

const projectionDropsTopLevel = (value: unknown, paths: readonly string[]): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const direct = new Set(paths.filter((path) => !path.includes('.')))
  return Object.keys(value as Record<string, unknown>).some(
    (key) => key !== 'session' && !direct.has(key),
  )
}

export const traceInputOf = (
  tool: ToolName,
  input: unknown,
  detailed: boolean,
): {
  compact: AgentTraceJson
  detail: AgentTraceJson
  redacted: boolean
  truncated: boolean
} => {
  const entry = TRACE_TOOL_POLICY[tool]
  const compact = picked(input, entry.compactInput)
  const detail = picked(input, detailed ? entry.detailedInput : [])
  const byteLengths: Record<string, AgentTraceJson> = {}

  for (const path of entry.byteLengths ?? []) {
    const value = atPath(input, path)

    if (typeof value === 'string') {
      byteLengths[`${path}Bytes`] = bytes(value)
    }
  }

  return {
    compact: { ...(compact.value as object), ...byteLengths } as AgentTraceJson,
    detail: detail.value,
    redacted:
      Object.keys(byteLengths).length > 0 || projectionDropsTopLevel(input, entry.compactInput),
    truncated: compact.truncated || detail.truncated,
  }
}

export const traceResultOf = (
  tool: ToolName,
  output: unknown,
  detailed: boolean,
): {
  compact: AgentTraceJson
  detail: AgentTraceJson
  redacted: boolean
  truncated: boolean
} => {
  const entry = TRACE_TOOL_POLICY[tool]
  const compact = picked(output, entry.result)
  const hits = retrievalHits(tool, output)

  return {
    compact: hits.value
      ? ({ ...(compact.value as object), hits: hits.value } as AgentTraceJson)
      : compact.value,
    detail: detailed ? picked(output, entry.result).value : {},
    redacted: projectionDropsTopLevel(output, entry.result) || hits.redacted,
    truncated: compact.truncated || hits.truncated,
  }
}

export type TraceIssue = { path?: readonly PropertyKey[]; code?: string; expected?: unknown }

export const issueSummaryOf = (
  issues: readonly TraceIssue[],
  tool: ToolName | null = null,
): AgentTraceJson => {
  const allowed = knownInputPaths(tool)
  return issues.slice(0, 20).map((issue) => {
    let parent = ''
    const path = (issue.path ?? []).map((part) => {
      if (typeof part === 'number') {
        parent = `${parent}[]`
        return part
      }
      if (typeof part !== 'string') {
        return '<field>'
      }
      const safe = safeSegment(part, parent, allowed)
      parent = safe.path
      return safe.segment
    })
    return {
      path,
      code: typeof issue.code === 'string' ? issue.code.slice(0, 64) : 'invalid',
      ...(typeof issue.expected === 'string' ? { expected: issue.expected.slice(0, 64) } : {}),
    }
  })
}

export const fingerprintOf = (
  tool: string,
  shape: AgentTraceJson,
  issues: AgentTraceJson | null,
): string =>
  createHash('sha256').update(JSON.stringify({ tool, shape, issues })).digest('hex').slice(0, 32)
