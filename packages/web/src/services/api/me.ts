import type {
  AbilityLocator,
  AbilitySaveRequest,
  AbilitySaveResponse,
  AddAgentRoleRequest,
  AddAgentRoleResponse,
  AddAgentSkillRequest,
  AddAgentSkillResponse,
  AgentAbilityDetailResponse,
  AgentPackageLibraryQueryInput,
  ConnectionPatchRequest,
  ConnectionsResponse,
  CreateAbilityVersionResponse,
  CreateAgentRoleRequest,
  CreateAgentRoleResponse,
  CreateAgentSkillRequest,
  CreateAgentSkillResponse,
  Me,
  MeAgentRolesResponse,
  MeAgentSkillsResponse,
  MeMemory,
  MeMemoryQuery,
  MePatchRequest,
  PatCreateRequest,
  PatCreateResponse,
  PatPatchRequest,
  PatsResponse,
  Profile,
  ProfilePutRequest,
  SetAgentAbilityEnabledResponse,
} from '@notarium/contract'
import { encodeAbilityLocator } from '@notarium/core'
import { req } from './client'
import { memoryQs } from './query'

const packageLibraryQuery = (query: AgentPackageLibraryQueryInput): string => {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value))
    }
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

export const meApi = {
  // ── self-service (#10): /api/me ─────────────────────────────────────────────
  meGet: () => req<Me>('/api/me'),
  agentRolesGet: (query: AgentPackageLibraryQueryInput = {}) =>
    req<MeAgentRolesResponse>(`/api/me/agent-roles${packageLibraryQuery(query)}`),
  agentAbilityGet: (locator: AbilityLocator) =>
    req<AgentAbilityDetailResponse>(
      `/api/me/agent-abilities/${encodeURIComponent(encodeAbilityLocator(locator))}`,
    ),
  agentAbilitySetEnabled: (
    locator: Exclude<AbilityLocator, { source: 'catalog' }>,
    enabled: boolean,
  ) =>
    req<SetAgentAbilityEnabledResponse>(
      `/api/me/agent-abilities/${encodeURIComponent(encodeAbilityLocator(locator))}/enabled`,
      { method: 'PUT', body: JSON.stringify({ enabled }) },
    ),
  agentAbilityCreateVersion: (
    locator: Extract<AbilityLocator, { source: 'owned'; kind: 'role' }>,
    projectId: string,
  ) =>
    req<CreateAbilityVersionResponse>(
      `/api/me/agent-abilities/${encodeURIComponent(encodeAbilityLocator(locator))}/versions`,
      { method: 'POST', body: JSON.stringify({ projectId }) },
    ),
  agentAbilitySave: (
    locator: Extract<AbilityLocator, { source: 'owned' }>,
    input: AbilitySaveRequest,
  ) =>
    req<AbilitySaveResponse>(
      `/api/me/agent-abilities/${encodeURIComponent(encodeAbilityLocator(locator))}/save`,
      { method: 'PUT', body: JSON.stringify(input) },
    ),
  agentRoleAddExact: (input: AddAgentRoleRequest) =>
    req<AddAgentRoleResponse>('/api/me/agent-roles', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  agentRoleCreate: (input: CreateAgentRoleRequest) =>
    req<CreateAgentRoleResponse>('/api/me/agent-roles/custom', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  agentSkillsGet: (query: AgentPackageLibraryQueryInput = {}) =>
    req<MeAgentSkillsResponse>(`/api/me/agent-skills${packageLibraryQuery(query)}`),
  agentSkillPublish: (input: CreateAgentSkillRequest) =>
    req<CreateAgentSkillResponse>('/api/me/agent-skills', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  agentSkillAddExact: (input: AddAgentSkillRequest) =>
    req<AddAgentSkillResponse>('/api/me/agent-skills/catalog', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** Who I am: rename and/or set the e-mail (session-only). The answer is the fresh
   *  `me` — read the new handle from it, never from the request. */
  mePatch: (patch: MePatchRequest) =>
    req<Me>('/api/me', { method: 'PATCH', body: JSON.stringify(patch) }),
  passwordChange: (currentPassword: string, newPassword: string) =>
    req<{ ok: true }>('/api/me/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  patsGet: () => req<PatsResponse>('/api/me/tokens').then((d) => d.tokens),
  /** The response's `token` is the bearer secret, shown exactly once — the
   *  server stores a hash and honestly can't repeat it. */
  patCreate: (input: PatCreateRequest) =>
    req<PatCreateResponse>('/api/me/tokens', { method: 'POST', body: JSON.stringify(input) }),
  /** Change a live token's scope/narrowing without re-minting (#162). */
  patPatch: (id: string, input: PatPatchRequest) =>
    req<{ ok: true }>(`/api/me/tokens/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  patRevoke: (id: string) =>
    req<{ ok: true }>(`/api/me/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── connected apps (#96): the user's OAuth connections (claude.ai/chatgpt) ──
  connectionsGet: () => req<ConnectionsResponse>('/api/me/connections').then((d) => d.connections),
  /** Change a connected app's access level read↔write (#162) and/or per-space
   *  narrowing (#181) without re-consent. */
  connectionUpdate: (id: string, input: ConnectionPatchRequest) =>
    req<{ ok: true }>(`/api/me/connections/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  connectionRevoke: (id: string) =>
    req<{ ok: true }>(`/api/me/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── the personal layer (#13): /api/me/memory + /api/me/profile ──────────────
  // Me-scoped — the personal-domain slug never crosses the wire. Memory is the
  // agent-authored audit feed; the profile is the human-authored always-load
  // note + display name. Individual memory notes use the id-addressed routes
  // above (noteGet/noteSave/noteRemove/revisionsGet) — they are ordinary notes.
  meMemoryGet: (query: MeMemoryQuery = {}) =>
    req<MeMemory>(`/api/me/memory${memoryQs(query)}`).then((d) => d.categories),
  profileGet: () => req<Profile>('/api/me/profile'),
  profilePut: (input: ProfilePutRequest) =>
    req<Profile>('/api/me/profile', { method: 'PUT', body: JSON.stringify(input) }),
}
