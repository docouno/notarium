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
  RestoreResponseSchema,
  SaveResponseSchema,
  SetNoteFieldsRequestSchema,
  SetNoteFieldsResponseSchema,
  UpdateNoteRequestSchema,
} from '@notarium/contract'
import { HTTP_STATUS } from '@notarium/contract/http'
import {
  deriveNoteTitle,
  directoryOf,
  DOCUMENT_ROLE,
  FOLDER_PAGE_BASENAME,
  isFolderPageNote,
  normalizeNoteType,
  normalizeWikilinkTarget,
  normTags,
  type Preview,
  promoteBodyTitle,
  revisionNotFound,
  revisionsUnavailable,
  STORE_ERROR_REASON,
} from '@notarium/core'

import { redactsKeyId, withAuthors } from '../../../../libs/authors'
import { safeRelAddress } from '../../../../libs/relPath'
import { can } from '../../../../services/authz'
import { prepareFieldWrite } from '../../../../services/fields'
import { folderPageNoteOf, lastSegment } from '../../../../services/projects'
import { RoleDependencyConflictError } from '../../../../services/roles'
import { setNoteFields, setNoteMuted, setNotePinned } from '../../../../services/spaces'
import { type ApiRouteCtx, authz, missing, notFound, s } from '../_shared'
import {
  moveToDomain,
  noteDetailToWire,
  revisionDetailToWire,
  revisionToWire,
  unattributedIfGap,
  updateToDomain,
} from '../wire'

export const noteRoutes = async (app: FastifyInstance, ctx: ApiRouteCtx) => {
  const {
    spaceStoreFor,
    noteStore,
    spaces,
    projects,
    folders,
    auth,
    principalId,
    restoreCoordinator,
    fieldSchemaStore,
    abilities,
  } = ctx

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
      noteDetailToWire(
        detail,
        spaces.slugOf(hit.space) ?? undefined,
        deletedBy,
        restoreCoordinator != null,
      ),
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
    const page = await folderPageNoteOf(store, found.path)
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
    const hit = await noteStore(req.principal, parsed.originalId, 'note:write')

    if (!hit) {
      return notFound(reply)
    }
    const live = await hit.store.read(parsed.originalId)
    const skillMember = live.class === NOTE_CLASS.skill && live.filePath != null
    // Asked of the note, not of its name. Whether a file is the package ROOT is a
    // mount-relative question — `.notarium/skills/<pkg>/references/SKILL.md` ends the
    // same way and is an auxiliary — and the engine already answered it when it built
    // the row. A second answer derived from the path here is how the two disagreed.
    const skillRoot = live.documentState?.role === DOCUMENT_ROLE.skillRoot
    let directory: string | undefined

    if (parsed.directory !== undefined) {
      if (skillMember) {
        if (parsed.directory !== directoryOf(live.filePath!)) {
          return reply
            .code(HTTP_STATUS.BAD_REQUEST)
            .send({ error: 'skill package directory cannot be changed' })
        }
      } else {
        const safe = safeRelAddress(parsed.directory)

        if (safe === null) {
          return reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: 'bad directory path' })
        }
        directory = safe
      }
    }
    if (parsed.description !== undefined && !skillRoot) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'skill manifest fields require a skill package root' })
    }
    const domain = updateToDomain(
      { ...parsed, directory, originalId: live.id ?? parsed.originalId },
      principalId(req),
    )
    const hasFields = Object.getOwnPropertyNames(parsed.fields ?? {}).length > 0
    const fieldsUnquoted = hasFields
      ? await prepareFieldWrite(fieldSchemaStore, hit.space, parsed.fields!)
      : undefined
    const promoted = promoteBodyTitle(domain.content ?? '', domain.title)
    const sameTags =
      domain.tags === undefined ||
      JSON.stringify(normTags(domain.tags) ?? []) ===
        JSON.stringify(normTags(live.frontmatter.tags) ?? [])
    const sameType =
      domain.noteType === undefined ||
      normalizeNoteType(domain.noteType) ===
        normalizeNoteType(
          typeof live.frontmatter.type === 'string' ? live.frontmatter.type : 'note',
        )
    const sameCreated =
      domain.createdAt === undefined || new Date(domain.createdAt).toISOString() === live.createdAt
    const sameDirectory =
      domain.directory === undefined ||
      (live.filePath !== undefined && domain.directory === directoryOf(live.filePath))
    const sameSlug =
      domain.slug === undefined || (domain.slug || undefined) === (live.slug || undefined)
    const derivedContentUnchanged =
      hasFields &&
      promoted.title === live.title &&
      promoted.body === live.content &&
      sameTags &&
      sameType &&
      sameCreated &&
      sameDirectory &&
      sameSlug
    const preparedDomain = {
      ...domain,
      ...(fieldsUnquoted ? { fieldsUnquoted } : {}),
      ...(derivedContentUnchanged ? { derivedContentUnchanged: true as const } : {}),
    }

    if (skillRoot && abilities) {
      try {
        const target = abilities.authorizeDocument(req.principal, { ...hit, note: live })

        if (!target) {
          return notFound(reply)
        }
        const saved = await abilities.writeDocument(req.principal, {
          target,
          input: preparedDomain,
          description: parsed.description,
          ...(parsed.abilityLocator && parsed.attachments
            ? { locator: parsed.abilityLocator, attachments: parsed.attachments }
            : {}),
        })

        return SaveResponseSchema.parse({
          ok: true,
          id: saved.id,
          filePath: saved.filePath,
          versionToken: saved.versionToken,
        })
      } catch (error) {
        if (error instanceof RoleDependencyConflictError) {
          return reply.code(HTTP_STATUS.CONFLICT).send({
            error: error.message,
            reason: 'role_dependency_conflict',
          })
        }
        throw error
      }
    }
    const r = await hit.store.write({
      ...preparedDomain,
      // A folder page's identity is the reserved basename `index.md`, not its title —
      // preserve it on edit so saving the body doesn't demote it to a child note.
      ...(live.filePath && isFolderPageNote(live.filePath)
        ? { fileName: FOLDER_PAGE_BASENAME }
        : {}),
      ...(skillRoot ? { preservePath: true } : {}),
    })
    return SaveResponseSchema.parse({
      ok: true,
      id: r.id,
      filePath: r.filePath,
      versionToken: r.versionToken,
    })
  })

  // Point patch over authored frontmatter. The schema only decides byte shape;
  // undeclared keys remain writable (open world).
  app.put('/api/note/fields', { config: authz('note:write', 'note') }, async (req, reply) => {
    const body = SetNoteFieldsRequestSchema.safeParse(req.body)

    if (!body.success) {
      return reply
        .code(HTTP_STATUS.BAD_REQUEST)
        .send({ error: body.error.issues[0]?.message || 'bad request' })
    }
    const hit = await noteStore(req.principal, body.data.id, 'note:write')

    if (!hit) {
      return notFound(reply)
    }
    const result = await setNoteFields({
      store: hit.store,
      fieldSchemaStore,
      space: hit.space,
      id: body.data.id,
      versionToken: body.data.versionToken,
      fields: body.data.fields,
      principal: principalId(req),
    })
    return SetNoteFieldsResponseSchema.parse({ ok: true, versionToken: result.versionToken })
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
    const revisions = (
      await withAuthors(
        items.map((revision) => revisionToWire(revision, restoreCoordinator != null)),
        req.principal.username,
        auth.describeAuthor,
      )
    ).map(unattributedIfGap)
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
    return NoteRevisionDetailResponseSchema.parse(
      unattributedIfGap({
        ...revisionDetailToWire(detail, restoreCoordinator != null),
        principal: redactsKeyId(author) ? null : detail.principal,
        author,
      }),
    )
  })

  // Strict single-note restore: durable idempotency + physical staging + one
  // terminal metadata commit. Retry is the same POST; there is no status endpoint.
  app.post(
    '/api/note/restore',
    { config: authz('note:write', 'note-replay') },
    async (req, reply) => {
      const body = RestoreRequestSchema.safeParse(req.body)

      if (!body.success) {
        return reply
          .code(HTTP_STATUS.BAD_REQUEST)
          .send({ error: body.error.issues[0]?.message || 'bad request' })
      }
      if (!restoreCoordinator) {
        return reply.code(HTTP_STATUS.SERVICE_UNAVAILABLE).send(
          RestoreResponseSchema.parse({
            status: 'busy',
            error: 'restore unavailable',
            reason: 'strict-restore-unavailable',
          }),
        )
      }
      const result = await restoreCoordinator.execute({
        mode: 'history',
        principal: req.principal,
        noteId: body.data.id,
        revisionId: body.data.revisionId,
        versionToken: body.data.versionToken,
        idempotencyKey: body.data.idempotencyKey,
      })

      if (
        result.status === 'not-found' ||
        (result.status === 'busy' && result.reason === 'space-not-active')
      ) {
        return notFound(reply)
      }
      const wire =
        result.status === 'succeeded'
          ? { ...result, id: result.noteId, noteId: undefined }
          : result.status === 'conflict'
            ? { ...result, error: 'restore conflict' }
            : result.status === 'not-restorable'
              ? { ...result, error: 'revision is not restorable' }
              : result.status === 'busy'
                ? { ...result, error: 'restore unavailable' }
                : result
      const status =
        result.status === 'succeeded'
          ? HTTP_STATUS.OK
          : result.status === 'pending'
            ? HTTP_STATUS.ACCEPTED
            : result.status === 'conflict'
              ? HTTP_STATUS.CONFLICT
              : result.status === 'not-restorable'
                ? HTTP_STATUS.UNPROCESSABLE_ENTITY
                : HTTP_STATUS.SERVICE_UNAVAILABLE

      return reply.code(status).send(RestoreResponseSchema.parse(wire))
    },
  )

  app.delete('/api/note', { config: authz('note:delete', 'note') }, async (req, reply) => {
    const { id } = req.query as { id?: string }

    if (!id) {
      return missing(reply, 'id')
    }
    const hit = await noteStore(req.principal, id, 'note:delete')

    if (!hit) {
      return notFound(reply)
    }
    const live = await hit.store.read(id)

    // Deleting the package ROOT is a package operation; deleting any other member of
    // the package is one tombstone. Same one answer as the write path above.
    const target = abilities?.authorizeDocument(req.principal, { ...hit, note: live })
    const removedPackage =
      target && abilities
        ? await abilities.removeDocument(req.principal, target, { principal: principalId(req) })
        : false

    if (!removedPackage) {
      await hit.store.remove(id, { principal: principalId(req) })
    }

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
