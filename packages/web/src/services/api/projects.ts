import type {
  PatchProjectRequest,
  ProjectAgentContext,
  ProjectMemory,
  ProjectRow,
  ProjectsResponse,
  RemoveResponse,
} from '@notarium/contract'
import { req, sp } from './client'

export const projectsApi = {
  // ── projects (#13) ────────────────────────────────────────────────────────
  /** The space's projects (the management view). */
  projectsGet: (space: string) =>
    req<ProjectsResponse>(`${sp(space)}/projects`).then((d) => d.projects),
  /** Mark a folder (or the root, folderPath '') as a project — the human
   *  management act (write-through marker + registry row, idempotent). `create`
   *  mints a NEW empty project folder instead of marking an existing one (#13). */
  markProject: (space: string, folderPath: string, displayName?: string, create?: boolean) =>
    req<ProjectRow>(`${sp(space)}/projects`, {
      method: 'POST',
      body: JSON.stringify({ folderPath, displayName, create }),
    }),
  /** Unmark a project by id (toggle OFF) — removes the marker + the row. */
  unmarkProject: (space: string, id: string) =>
    req<RemoveResponse>(`${sp(space)}/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Rename a project by id (#100 phase 2) — change its handle slug and/or displayName.
   *  A changed slug retires the old one into the alias history, so `space/<old>`
   *  keeps resolving; the server 409s a slug already in use, 400s the root project. */
  patchProject: (space: string, id: string, patch: PatchProjectRequest) =>
    req<ProjectRow>(`${sp(space)}/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /** The about-PROJECT memory axis (#13 I5/F4): every agent-memory category the
   *  agent recorded about THIS project, with #12 provenance — the space-scoped
   *  twin of meMemoryGet. An empty list = nothing recorded yet (honest, not an
   *  error); a foreign/unknown id 404s (anti-enumeration #16). */
  projectMemoryGet: (space: string, projectId: string, order?: 'eager') =>
    req<ProjectMemory>(
      `${sp(space)}/projects/${encodeURIComponent(projectId)}/memory${order ? `?order=${order}` : ''}`,
    ).then((d) => d.categories),
  /** The PROJECT agent-context preview (#165): capped alwaysLoad for the agent,
   *  full pins[] for the UI, plus the read-only auto index. */
  projectAgentContextGet: (space: string, projectId: string) =>
    req<ProjectAgentContext>(
      `${sp(space)}/projects/${encodeURIComponent(projectId)}/agent-context`,
    ),
}
