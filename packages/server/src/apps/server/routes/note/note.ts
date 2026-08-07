import type { FastifyInstance } from 'fastify'

import {
  FolderResponseSchema,
  MoveRequestSchema,
  MoveResponseSchema,
  MuteNoteRequestSchema,
  MuteNoteResponseSchema,
  NOTE_CLASS,
  NoteDetailResponseSchema,
  NoteRevisionDetailResponseSchema,
  NoteRevisionsQuerySchema,
  NoteRevisionsResponseSchema,
  PinNoteRequestSchema,
  PinNoteResponseSchema,
  PreviewsRequestSchema,
  PreviewsResponseSchema,
  RemoveResponseSchema,
  RestoreRequestSchema,
  SaveResponseSchema,
  UpdateNoteRequestSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import {
  deriveNoteTitle,
  FOLDER_PAGE_BASENAME,
  folderPageFilePath,
  isFolderPageNote,
  normalizeWikilinkTarget,
  type Preview,
  revisionNotFound,
  revisionsUnavailable,
  STORE_ERROR_REASON,
} from '@notarium/core'

import { redactsKeyId, withAuthors } from '../../../../libs/authors'
import { safeRelAddress } from '../../../../libs/relPath'
import { can } from '../../../../services/authz'
import { lastSegment } from '../../../../services/projects'
import { setNoteMuted, setNotePinned } from '../../../../services/spaces'
import { type ApiRouteCtx, authz, missing, notFound, s } from '../_shared'
import {
  moveToDomain,
  noteDetailToWire,
  revisionDetailToWire,
  revisionToWire,
  updateToDomain,
} from '../wire'

export const noteRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const { spaceStoreFor, noteStore, spaces, projects, folders, auth, principalId } = ctx

  // Wiki-link resolver: `ref` (path/title/permalink) resolves WITHIN this space
  // only, never crossing the boundary. canon: docs/spaces.md#model
  app.get(s('/note'), { config: authz('space:read', 'space') }, async (req, reply) => {
    const ref = normalizeWikilinkTarget(((req.query as { ref?: string }).ref || '').trim())

    if (!ref) {
      return missing(reply, 'ref')
    }
    const store = await spaceStoreFor(req)
    // Emit the CURRENT slug: the URL may carry a past-slug alias.
    const slug = spaces.slugOf(req.spaceId) ?? undefined
    const detail = store.resolveWikilink ? await store.resolveWikilink(ref) : await store.read(ref)
    return NoteDetailResponseSchema.parse(noteDetailToWire(detail, slug))
  })

  // ── id-addressed family (global) ───────────────────────────────────────────
  // noteStore enforces access on the REGISTRY's space (no client-supplied space to
  // smuggle); unknown id, tombstone, and unreadable space collapse to ONE 404
  // (anti-enumeration). canon: docs/contract.md#route-families-a-idroutinga

  app.get('/api/note', { config: authz('note:read', 'note') }, async (req, reply) => {
    const { id } = req.query as { id?: string }

    if (!id) {
      return missing(reply, 'id')
    }
    const hit = await noteStore(req.principal, id, 'note:read')

    if (!hit) {
      return notFound(reply)
    }
    // deletedView opt-in: a trashed id reads back its last state (for the "deleted"
    // banner) instead of 404ing; discovery reads omit it and still miss.
    // canon: docs/trash.md#opening-a-deleted-note
    const detail = await hit.store.read(id, { deletedView: true })
    // Deleter resolved to a privacy-filtered Author for the banner — the raw
    // principal never crosses the wire.
    const deletedBy = detail.deleted
      ? detail.deletedByPrincipal == null
        ? null
        : await auth.describeAuthor(detail.deletedByPrincipal, req.principal.username)
      : undefined
    return NoteDetailResponseSchema.parse(
      noteDetailToWire(detail, spaces.slugOf(hit.space) ?? undefined, deletedBy),
    )
  })

  // Resolve a folder by its durable id. A project id IS its folder id, so both the
  // projects and folders registries are tried; unknown id or unreadable space
  // collapse to the SAME 404 (anti-enumeration).
  // canon: docs/projects.md#project-identity-the-marker-file-pattern-51-lifted-notefolder
  app.get('/api/folder/:id', { config: authz('note:read', 'note') }, async (req, reply) => {
    const id = (req.params as { id?: string }).id ?? ''

    if (!id) {
      return notFound(reply)
    }
    const project = projects ? await projects.getById(id) : null
    const folderRow = !project && folders ? await folders.getById(id) : null
    const found = project ?? folderRow

    if (!found) {
      return notFound(reply)
    }
    const space = found.space

    if (!can(req.principal, 'note:read', { space })) {
      return notFound(reply)
    }
    const store = await spaces.store(space)
    const pageFile = folderPageFilePath(found.path)
    const page = (await store.list()).find((n) => n.filePath === pageFile)
    const name = project
      ? project.displayName
      : lastSegment(found.path) || spaces.slugOf(space) || ''
    return FolderResponseSchema.parse({
      folderId: id,
      space: spaces.slugOf(space) ?? '',
      path: found.path,
      name,
      ...(page?.id ? { pageNoteId: page.id } : {}),
    })
  })

  // Batched preview resolution; ids MAY span spaces. Unauthorized/unknown ids are
  // silently absent — the batch is no enumeration channel. canon: docs/feed-page.md#data-flow
  app.post('/api/previews', { config: authz('note:read', 'note') }, async (req, reply) => {
    const body = PreviewsRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    const abort = new AbortController()
    // Client-gone rides the RESPONSE stream; `writableEnded` tells a real abort from
    // a normal end. FOOTGUN: req.raw 'close' fires when the request BODY is consumed
    // (Node 15+), not on disconnect.
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) {
        abort.abort()
      }
    })
    // NOT the shared noteStore: this peek filters tombstones (noteStore resolves them
    // and lets read() decide) and silently skips unauthorized/unknown ids. If you ever
    // unify them, keep the tombstone filter + silent-continue.
    const bySpace = new Map<string, string[]>()

    for (const id of body.data.ids) {
      const resolved = await spaces.resolveNote(id)

      if (!resolved || resolved.deletedAt) {
        continue
      }
      // Archived-space note: resolveNote still finds it, but spaces.store() would
      // throw — skip so one such id can't crash the whole batch.
      if (spaces.recOf(resolved.space)?.archivedAt) {
        continue
      }
      if (!can(req.principal, 'note:read', { space: resolved.space })) {
        continue
      }
      const list = bySpace.get(resolved.space)

      if (list) {
        list.push(id)
      } else {
        bySpace.set(resolved.space, [id])
      }
    }
    const previews: Record<string, Preview> = {}
    await Promise.all(
      [...bySpace.entries()].map(async ([slug, ids]) => {
        const store = await spaces.store(slug)
        Object.assign(
          previews,
          await store.previews(ids, { background: true, signal: abort.signal }),
        )
      }),
    )
    return PreviewsResponseSchema.parse({ previews })
  })

  app.post('/api/note', { config: authz('note:write', 'note') }, async (req, reply) => {
    const body = (req.body || {}) as Record<string, unknown>

    if (!body.originalId) {
      return missing(reply, 'originalId')
    }
    // CAS: every writer must prove what it overwrites (machine-readable reason).
    // canon: docs/contract.md#optimistic-concurrency-a-idcasa
    if (!body.versionToken) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({
        error: 'versionToken is required with originalId',
        reason: STORE_ERROR_REASON.versionTokenRequired,
      })
    }
    const parsed = UpdateNoteRequestSchema.parse(body)

    // Body-first title: the editor saves the doc (leading `# H1`) with no `title`
    // field; derive it, refusing only a note with no title at all.
    if (!deriveNoteTitle(parsed.content ?? '', parsed.title)) {
      return missing(reply, 'title')
    }
    let directory: string | undefined

    if (parsed.directory !== undefined) {
      const safe = safeRelAddress(parsed.directory)

      if (safe === null) {
        return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad directory path' })
      }
      directory = safe
    }
    const hit = await noteStore(req.principal, parsed.originalId, 'note:write')

    if (!hit) {
      return notFound(reply)
    }
    const live = await hit.store.read(parsed.originalId)
    const r = await hit.store.write({
      ...updateToDomain(
        { ...parsed, directory, originalId: live.id ?? parsed.originalId },
        principalId(req),
      ),
      // A folder page's identity is the reserved basename `index.md`, not its title —
      // preserve it on edit so saving the body doesn't demote it to a child note.
      ...(live.filePath && isFolderPageNote(live.filePath)
        ? { fileName: FOLDER_PAGE_BASENAME }
        : {}),
    })
    return SaveResponseSchema.parse({
      ok: true,
      id: r.id,
      filePath: r.filePath,
      versionToken: r.versionToken,
    })
  })

  // ── init-context curation write channels ─────────────────────────────
  // Metadata toggles that re-save the body with one frontmatter field flipped; a
  // no-op toggle doesn't churn the journal.
  // canon: docs/projects.md#init-context-curation-165-a-idinit-context-curationa

  // Pin/unpin: toggles the `always-load` tag.
  app.put('/api/note/pin', { config: authz('note:write', 'note') }, async (req, reply) => {
    const body = PinNoteRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    const hit = await noteStore(req.principal, body.data.id, 'note:write')

    if (!hit) {
      return notFound(reply)
    }
    const note = await hit.store.read(body.data.id)

    if (note.class !== NOTE_CLASS.userDoc) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'only user-doc notes can be pinned' })
    }
    const r = await setNotePinned(hit.store, body.data.id, body.data.pinned, principalId(req))
    return PinNoteResponseSchema.parse({ ok: true, pinned: r.pinned })
  })

  // Mute/unmute: toggles a memory category's `muted` opt-out — dropped from the
  // agent's eager profile, kept in the audit. canon: docs/note-model.md#agent-memory
  app.put('/api/note/mute', { config: authz('note:write', 'note') }, async (req, reply) => {
    const body = MuteNoteRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    const hit = await noteStore(req.principal, body.data.id, 'note:write')

    if (!hit) {
      return notFound(reply)
    }
    const note = await hit.store.read(body.data.id)

    if (note.class !== NOTE_CLASS.agentMemory) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'only agent-memory notes can be muted' })
    }
    const r = await setNoteMuted(hit.store, body.data.id, body.data.muted, principalId(req))
    return MuteNoteResponseSchema.parse({ ok: true, muted: r.muted })
  })

  // ── note history ─────────────────────────────────────────────────────
  // A store that doesn't journal answers 404 `revisions_unavailable` — honest
  // capability degradation (P5), not an error. canon: docs/note-history.md#deliberate-boundaries

  app.get('/api/note/revisions', { config: authz('note:read', 'note') }, async (req, reply) => {
    const q = NoteRevisionsQuerySchema.safeParse(req.query)

    if (!q.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: q.error.issues[0]?.message || 'bad query' })
    }
    const hit = await noteStore(req.principal, q.data.id, 'note:read')

    if (!hit) {
      return notFound(reply)
    }
    if (!hit.store.revisions) {
      throw revisionsUnavailable()
    }
    const { items, total } = await hit.store.revisions(q.data.id, {
      offset: q.data.offset,
      limit: q.data.limit,
    })
    const revisions = await withAuthors(
      items.map(revisionToWire),
      req.principal.username,
      auth.describeAuthor,
    )
    return NoteRevisionsResponseSchema.parse({ revisions, total })
  })

  app.get('/api/note/revision', { config: authz('note:read', 'note') }, async (req, reply) => {
    const { id, revisionId } = req.query as { id?: string; revisionId?: string }

    if (!id || !revisionId) {
      return missing(reply, 'id or revisionId')
    }
    const hit = await noteStore(req.principal, id, 'note:read')

    if (!hit) {
      return notFound(reply)
    }
    if (!hit.store.revision) {
      throw revisionsUnavailable()
    }
    const detail = await hit.store.revision(id, revisionId)

    if (!detail) {
      throw revisionNotFound(revisionId)
    }
    const author = await auth.describeAuthor(detail.principal, req.principal.username)
    // Redact a foreign agent's key id (privacy), matching withAuthors.
    return NoteRevisionDetailResponseSchema.parse({
      ...revisionDetailToWire(detail),
      principal: redactsKeyId(author) ? null : detail.principal,
      author,
    })
  })

  // Restore = a save whose body is taken from the revision, not the client (no
  // smuggling content under a `restore` record), pushed through the same CAS path.
  // canon: docs/note-history.md#how-its-written
  app.post('/api/note/restore', { config: authz('note:write', 'note') }, async (req, reply) => {
    const body = RestoreRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    const hit = await noteStore(req.principal, body.data.id, 'note:write')

    if (!hit) {
      return notFound(reply)
    }
    if (!hit.store.restore) {
      throw revisionsUnavailable()
    }
    const r = await hit.store.restore({
      id: body.data.id,
      revisionId: body.data.revisionId,
      versionToken: body.data.versionToken,
      principal: principalId(req),
    })
    return SaveResponseSchema.parse({
      ok: true,
      id: r.id,
      filePath: r.filePath,
      versionToken: r.versionToken,
    })
  })

  app.delete('/api/note', { config: authz('note:delete', 'note') }, async (req, reply) => {
    const { id } = req.query as { id?: string }

    if (!id) {
      return missing(reply, 'id')
    }
    const hit = await noteStore(req.principal, id, 'note:delete')

    if (!hit) {
      return notFound(reply)
    }
    await hit.store.remove(id, { principal: principalId(req) })
    return RemoveResponseSchema.parse({ ok: true })
  })

  app.post('/api/move', { config: authz('note:write', 'note') }, async (req, reply) => {
    const body = MoveRequestSchema.safeParse(req.body)

    if (!body.success || !body.data.id || !body.data.destinationPath) {
      return missing(reply, 'id or destinationPath')
    }
    const destination = safeRelAddress(body.data.destinationPath)

    if (destination === null) {
      return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad destination path' })
    }
    const hit = await noteStore(req.principal, body.data.id, 'note:write')

    if (!hit) {
      return notFound(reply)
    }
    await hit.store.move(moveToDomain({ id: body.data.id, destinationPath: destination }))
    return MoveResponseSchema.parse({ ok: true })
  })
}
