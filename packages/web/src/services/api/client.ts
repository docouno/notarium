import type { ImportSummary, Job, NoteDetail as WireNoteDetail } from '@notarium/contract'
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
  current?: NoteDetailView
  /** Field-level causes of a `reason: 'validation'` 400 — present so a form can
   *  point at the offending field; the generic message is the lead issue. */
  issues?: { path: string; message: string }[]
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
      unauthorizedHandler?.()
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
    if (err.reason === 'version_conflict' && data.current) {
      err.current = noteDetailView(data.current as WireNoteDetail)
    }
    if (Array.isArray(data.issues)) {
      err.issues = data.issues as { path: string; message: string }[]
    }
    throw err
  }

  return data as T
}

/** The space-scoped route family's prefix. */
export const sp = (space: string) => `/api/s/${encodeURIComponent(space)}`

/** Read a synchronous-import NDJSON stream (the none-mode fallback of POST /import,
 *  #191): periodic `{type:'progress',imported}` heartbeats feed `onProgress`, a final
 *  `{type:'done',...summary}` resolves, a `{type:'error'}` rejects. The durable path
 *  never touches this — it returns a Job the caller tracks via jobGet/SSE instead. */
const readImportStream = async (
  res: Response,
  onProgress: (imported: number) => void,
): Promise<ImportSummary> => {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let result: ImportSummary | null = null
  let failure: string | null = null

  const handle = (line: string) => {
    const t = line.trim()

    if (!t) {
      return
    }
    let msg: { type?: string; imported?: number; error?: string } & Record<string, unknown>

    try {
      msg = JSON.parse(t)
    } catch {
      return
    }
    if (msg.type === 'progress') {
      onProgress(msg.imported ?? 0)
    } else if (msg.type === 'done') {
      result = msg as unknown as ImportSummary
    } else if (msg.type === 'error') {
      failure = msg.error || 'import failed'
    }
  }

  for (;;) {
    const { value, done } = await reader.read()

    if (done) {
      break
    }
    buf += decoder.decode(value, { stream: true })
    for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
      handle(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  }
  buf += decoder.decode() // flush any trailing multibyte remainder
  handle(buf)
  if (failure) {
    throw new ApiError(failure)
  }
  if (!result) {
    throw new ApiError('import produced no result')
  }

  return result
}

/** Import (#11, #191): upload a Claude/ChatGPT/memory export (a .zip or bare
 *  .json/.jsonl) → notes. FormData (the browser sets the multipart boundary); the
 *  file is appended LAST because the server reads the text fields off the file part.
 *  One POST, streamed once (a large archive is never re-sent); the response tells
 *  the mode:
 *   • DURABLE (202): a meta-DB backs jobs → returns the enqueued Job. Track it via
 *     jobGet / the `job` SSE event; its ImportSummary lands in job.result on success;
 *     it survives a closed tab / restart and can be canceled.
 *   • SYNC (200 NDJSON): none-mode fallback → returns `run(onProgress)` that drives
 *     the hijacked stream to the summary — honest capability degradation.
 *  A pre-stream error (413/400/401) throws ApiError (status set). Pass `signal` to
 *  abort the upload (the sync fallback's Cancel). */
export const importStart = async (
  space: string,
  file: File,
  opts: {
    format?: string
    root?: string
    skipExisting?: boolean
    memory?: 'folder' | 'space' | 'skip'
  } = {},
  signal?: AbortSignal,
): Promise<
  | { mode: 'job'; job: Job }
  | { mode: 'sync'; run: (onProgress: (imported: number) => void) => Promise<ImportSummary> }
> => {
  const form = new FormData()

  if (opts.format) {
    form.append('format', opts.format)
  }
  if (opts.root) {
    form.append('root', opts.root)
  }
  if (opts.skipExisting) {
    form.append('skipExisting', 'true')
  }
  if (opts.memory) {
    form.append('memory', opts.memory)
  }
  form.append('file', file)
  const res = await fetch(`${sp(space)}/import`, { method: 'POST', body: form, signal })

  if (!res.ok || !res.body) {
    // A pre-stream error (413/400) carries a real JSON `{error}` body — surface it
    // instead of a bare "HTTP 413", and mirror req()'s 401 → logout handling.
    if (res.status === HTTP_STATUS.UNAUTHORIZED) {
      unauthorizedHandler?.()
    }
    const data = (await res.json().catch(() => ({}))) as { error?: unknown }
    const err = new ApiError(
      typeof data.error === 'string' && data.error ? data.error : `HTTP ${res.status}`,
    )
    err.status = res.status
    throw err
  }
  // 202 = a durable import job was enqueued; 200 = the synchronous NDJSON fallback.
  if (res.status === HTTP_STATUS.ACCEPTED) {
    return { mode: 'job', job: (await res.json()) as Job }
  }

  return { mode: 'sync', run: (onProgress) => readImportStream(res, onProgress) }
}
