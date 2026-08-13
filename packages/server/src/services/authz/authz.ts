// The authz seam: the pure, synchronous P14 access decision — can(principal, action,
// resource). Fastify enforcement wiring lives in apps/server/perimeter/authz.ts.
// canon: docs/auth.md#model · docs/architecture.md#p14

export type Action =
  | 'space:read'
  | 'space:write'
  | 'space:manage'
  | 'note:read'
  | 'note:write'
  | 'note:delete'
  | 'spaces:list'
  | 'spaces:create'
  | 'config:read'
  | 'members:read'
  | 'members:manage'
  | 'users:manage'
  | 'self:read'
  | 'self:manage'

export type SpaceRole = 'owner' | 'writer' | 'reader'

/** The authenticated caller with grants pre-loaded; the P14 principal.
 *  canon: docs/auth.md#credentials */
export type Principal = {
  id: string
  username: string | null
  admin: boolean
  scope: 'read' | 'write' | 'manage'
  grants: ReadonlyMap<string, SpaceRole>
  spaces: ReadonlySet<string> | null
  system: boolean
  /** Acting agent credential's display name, snapshotted at auth time — the retrieval
   *  audit reads it without a lookup that could race token rotation.
   *  canon: docs/mcp-gateway.md#security */
  label?: string | null
}

export type AuthzConfig =
  | { public: true }
  | { action: Action; resource: 'space' | 'space-replay' | 'note' | 'note-replay' | 'host' }

/** The single all-access principal of AUTH_MODE=none (also the e2e fake's default).
 *  id stays 'ui' for backward-compatible journal attribution. canon: docs/auth.md#modes */
export const SYSTEM_PRINCIPAL: Principal = {
  id: 'ui',
  username: null,
  admin: true,
  scope: 'manage',
  grants: new Map(),
  spaces: null,
  system: true,
}

/** Stable owner key for self-scoped agent state. Password principals use their
 * username; the trusted authless host uses a namespace that cannot be a valid
 * username, so changing AUTH_MODE cannot expose one principal's history to the
 * other. */
export const AGENT_SYSTEM_OWNER = '@system'

export const agentOwnerOf = (principal: Pick<Principal, 'username' | 'system'>): string | null =>
  principal.system ? AGENT_SYSTEM_OWNER : principal.username

const LEVEL = { read: 1, write: 2, manage: 3 } as const
const ROLE = { reader: 1, writer: 2, owner: 3 } as const

type Rule = {
  level: keyof typeof LEVEL
  need: 'any' | 'admin' | 'reader' | 'writer' | 'owner'
}

const RULES: Record<Action, Rule> = {
  'space:read': { level: 'read', need: 'reader' },
  'space:write': { level: 'write', need: 'writer' },
  'space:manage': { level: 'manage', need: 'owner' },
  'note:read': { level: 'read', need: 'reader' },
  'note:write': { level: 'write', need: 'writer' },
  'note:delete': { level: 'write', need: 'writer' },
  'spaces:list': { level: 'read', need: 'any' },
  'spaces:create': { level: 'manage', need: 'admin' },
  'config:read': { level: 'read', need: 'any' },
  'members:read': { level: 'read', need: 'reader' },
  'members:manage': { level: 'manage', need: 'owner' },
  'users:manage': { level: 'manage', need: 'admin' },
  'self:read': { level: 'read', need: 'any' },
  'self:manage': { level: 'manage', need: 'any' },
}

/** THE access decision (P14): scope ceiling ∩ membership grant, synchronous and pure.
 */
export const can = (
  principal: Principal,
  action: Action,
  resource: { space?: string },
): boolean => {
  if (principal.system) {
    return true
  }
  const rule = RULES[action]

  if (LEVEL[principal.scope] < LEVEL[rule.level]) {
    return false
  }
  if (rule.need === 'any') {
    return true
  }
  if (rule.need === 'admin') {
    return principal.admin
  }
  const space = resource.space

  if (!space) {
    return false
  }
  if (principal.spaces && !principal.spaces.has(space)) {
    return false
  }
  const role = principal.grants.get(space)

  if (role && ROLE[role] >= ROLE[rule.need]) {
    return true
  }

  // Admin override for management only (the recovery path) — never for data.
  return rule.need === 'owner' && principal.admin
}

/** The credential's space-free UPPER BOUND on an action (scope ceiling, no grant
 *  lookup) — drives the gateway's tools/list filter.
 *  NOT a substitute for can(): a role-need action passes the ceiling whenever the scope
 *  level fits; the real per-resource decision is still can() at call time.
 *  Deliberately ignores grants — a write-scope PAT with an empty/narrowed grant set still
 *  SEES the write tools (can() denies at call). Do NOT add a grant check here: it would
 *  filter the surface on a membership snapshot the credential may legitimately gain. */
export const scopeAllows = (principal: Principal, action: Action): boolean => {
  if (principal.system) {
    return true
  }
  const rule = RULES[action]

  if (LEVEL[principal.scope] < LEVEL[rule.level]) {
    return false
  }
  if (rule.need === 'admin') {
    return principal.admin
  }

  return true
}
