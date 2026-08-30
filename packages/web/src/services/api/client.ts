import type {
  CredentialReference,
  ImportSummary,
  NoteExistsResponse,
  ProviderAttachmentView,
  ProviderRetargetConflictReference,
  NoteDetail as WireNoteDetail,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import { noteDetailView, type NoteDetailView } from '../../libs/wire'

// The typed fetch transport under the /api/* wire contract, shared by every
// resource family (services/api/*). Method naming — {resource}{Action}
// (docs/web-ui.md). Types come from @notarium/contract as type-only
// imports, so zod never reaches the browser bundle.
//
// SPACES (#16): the wire has two route families and the client mirrors them —
// space-scoped methods take the slug as their FIRST argument and hit
// `/api/s/<slug>/…` (callers thread the active space from SpaceProvider);
// id-addressed methods (noteGet, previews, update, move, revisions) stay
// global — the server's identity registry is the space arbiter, never us.
//
// camelCase domain views + wire mappers live in libs/wire (notes/search/graph)
// and libs/revisions (note history), so presentational widgets can share the
// shapes too (widgets never import services). Since contract v2 (#54) the wire
// speaks the same camelCase — the families assemble request bodies verbatim.

/** Transport error carrying the wire's machine-readable cause: `status` plus
 *  the 503 `reason` ("engine_unreachable"/"engine_timeout") so callers can tell
 *  "knowledge engine down" (retryable) from a real bug. A save's 409
 *  (`version_conflict`, #50) additionally carries `current` — the live note
 *  with a fresh versionToken, what the conflict dialog shows and retries with. */
export class ApiError extends Error {
  status?: number
  reason?: string
  operationId?: string
  current?: NoteDetailView
  /** The note holding the destination of a refused create (`note_already_exists`,
   *  the create-collision twin of `current`). Absent when the server caught the
   *  collision on disk truth alone and has no note to name. */
  existing?: NoteExistsResponse['existing']
  /** The name a "save under a free name" retry would take — a preview the collision
   *  dialog offers by name; the save reports what it actually got. */
  suggestedTitle?: string
  /** Field-level causes of a `reason: 'validation'` 400 — present so a form can
   *  point at the offending field; the generic message is the lead issue. */
  issues?: { path: string; message: string }[]
  /** Provider management conflicts return the safe references the UI must explain.
   *  Credential references and retarget references are distinguishable by their
   *  `kind` / `resolution` fields; neither shape contains a secret. */
  references?: CredentialReference[] | ProviderRetargetConflictReference[]
  /** Fresh attachment projection returned with an epoch conflict. The acceptance
   *  surface replaces its stale row with this instead of painting an error. */
  providerView?: ProviderAttachmentView
  /** A synchronous import that failed AFTER writing some notes carries what it did
   *  finish. The error is the outcome, but the notes are real — dropping this would
   *  tell the user nothing happened. canon: docs/import.md#what-an-import-reports-302 */
  partial?: ImportSummary
}

// The session-died hook (#10): a mid-flight 401 means the cookie is gone
// (expired, revoked, user disabled) — the app must fall back to the login
// screen, and the AuthProvider is the one who knows how. /api/auth/* is
// exempt: a failed login/setup attempt is the SCREEN's error to show, looping
// it through the handler would re-gate the screen the user is already on.
let unauthorizedHandler: (() => void) | null = null

export const setUnauthorizedHandler = (fn: (() => void) | null): void => {
  unauthorizedHandler = fn
}

/** Resource families with a non-JSON transport still share the same session hook. */
export const notifyUnauthorized = (): void => unauthorizedHandler?.()

// The space-access probe (#111): a 403/404 on a SPACE-SCOPED route (/api/s/…)
// can mean the principal just lost their grant on that space (membership
// revoked, or the space archived/deleted) — but it can equally be a genuinely
// missing note. We can't tell from the status alone (anti-enumeration #16
// deliberately returns the same 404), so the api layer doesn't decide: it just
// reports the slug, and the SpaceAccessProvider re-checks the live grants for
// the ACTIVE space (the authority) before taking the app over. Note-level 404s
// thus self-clear — the space is still in the grants.
let spaceAccessProbe: ((slug: string) => void) | null = null

export const setSpaceAccessProbe = (fn: ((slug: string) => void) | null): void => {
  spaceAccessProbe = fn
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
const fieldValues = (value: unknown): boolean =>
  record(value) &&
  Object.getOwnPropertyNames(value).every(
    (key) => typeof value[key] === 'string' || strings(value[key]),
  )

/** Error envelopes are not trusted merely because the happy note endpoint is typed.
 * Keep this lightweight (no Zod in the browser bundle), but admit only the exact
 * conflict members the editor can render or reuse as a CAS token. */
const conflictCurrent = (value: unknown): WireNoteDetail | undefined => {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    typeof value.content !== 'string' ||
    !record(value.frontmatter) ||
    typeof value.versionToken !== 'string'
  ) {
    return undefined
  }
  const result: WireNoteDetail = {
    id: value.id,
    content: value.content,
    frontmatter: value.frontmatter,
    versionToken: value.versionToken,
  }

  for (const key of [
    'space',
    'title',
    'filePath',
    'class',
    'agentKind',
    'documentTitle',
    'slug',
  ] as const) {
    const member = value[key]

    if (member !== undefined) {
      if (typeof member !== 'string') {
        return undefined
      }
      Object.assign(result, { [key]: member })
    }
  }
  if (value.aliases !== undefined) {
    if (!strings(value.aliases)) {
      return undefined
    }
    result.aliases = value.aliases
  }
  for (const key of ['modifiedAt', 'createdAt'] as const) {
    const member = value[key]

    if (member !== undefined) {
      if (member !== null && typeof member !== 'string') {
        return undefined
      }
      Object.assign(result, { [key]: member })
    }
  }
  if (value.fields !== undefined) {
    const fields = value.fields

    if (
      !record(fields) ||
      !fieldValues(fields.keys) ||
      !strings(fields.order) ||
      !['unreadable', 'truncated'].every(
        (key) => fields[key] === undefined || strings(fields[key]),
      ) ||
      !['unreadableMore', 'truncatedMore'].every(
        (key) => fields[key] === undefined || typeof fields[key] === 'number',
      )
    ) {
      return undefined
    }
    result.fields = fields as WireNoteDetail['fields']
  }

  return result
}

// Pull the slug out of a space-scoped path (/api/s/<slug>/…); null for any other
// route family (host-level, id-addressed) — those never carry a space grant.
const spaceOfPath = (path: string): string | null => {
  const m = /^\/api\/s\/([^/?]+)/.exec(path)
  return m ? decodeURIComponent(m[1]) : null
}

export const req = async <T>(path: string, opts: RequestInit = {}): Promise<T> => {
  const res = await fetch(path, {
    ...opts,
    headers: {
      // Only claim a JSON body when one is actually sent. A bodyless POST/DELETE
      // (logout, member-remove, token-revoke) carrying this header makes
      // Fastify's JSON parser reject the empty body with a 500 — which silently
      // aborted logout: the cookie was never cleared, so a reload re-authed.
      ...(opts.body != null ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  })
  const text = await res.text()
  let data: Record<string, unknown>

  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    data = { error: text }
  }
  if (!res.ok) {
    if (res.status === HTTP_STATUS.UNAUTHORIZED && !path.startsWith('/api/auth/')) {
      notifyUnauthorized()
    }
    // A 403/404 on a space-scoped route → let the access detector decide whether
    // the active space was lost (it re-checks the live grants). 401 is already
    // the session-died path above; here we catch the still-authenticated cases.
    if (
      (res.status === HTTP_STATUS.FORBIDDEN || res.status === HTTP_STATUS.NOT_FOUND) &&
      spaceAccessProbe
    ) {
      const slug = spaceOfPath(path)

      if (slug) {
        spaceAccessProbe(slug)
      }
    }
    const err = new ApiError(
      typeof data.error === 'string' && data.error ? data.error : `HTTP ${res.status}`,
    )
    err.status = res.status
    if (typeof data.reason === 'string') {
      err.reason = data.reason
    }
    if (typeof data.operationId === 'string') {
      err.operationId = data.operationId
    }
    if (err.reason === 'version_conflict' && data.current) {
      const current = conflictCurrent(data.current)

      if (current) {
        err.current = noteDetailView(current)
      }
    }
    if (err.reason === 'note_already_exists') {
      if (data.existing) {
        err.existing = data.existing as NoteExistsResponse['existing']
      }
      if (typeof data.suggestedTitle === 'string') {
        err.suggestedTitle = data.suggestedTitle
      }
    }
    if (Array.isArray(data.issues)) {
      err.issues = data.issues as { path: string; message: string }[]
    }
    if (Array.isArray(data.references)) {
      err.references = data.references as
        CredentialReference[] | ProviderRetargetConflictReference[]
    }
    if (data.view) {
      err.providerView = data.view as ProviderAttachmentView
    }
    throw err
  }

  return data as T
}

/** The space-scoped route family's prefix. */
export const sp = (space: string) => `/api/s/${encodeURIComponent(space)}`
