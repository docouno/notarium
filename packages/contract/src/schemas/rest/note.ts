import { z } from 'zod'
import { IF_EXISTS } from '../../consts/notes'
import {
  AuthorSchema,
  DurableAddressPathSchema,
  DurableNonEmptyScalarSchema,
  IsoTimestampSchema,
  NoteClassSchema,
  SpaceSlugSchema,
} from '../primitives'
import { noteWriteFields } from './_fields'
import { AuthoredAttachmentSchema, OwnedRoleAbilityLocatorSchema } from './agent/abilities'
import { LiteralSourceSchema, RestoreAvailabilitySchema } from './history'

export const NoteDetailResponseSchema = z.object({
  id: z.string(),
  /** The space the note lives in — what scopes the client's chrome
   *  (sidebar, tree, sibling navigation) when a reader arrives through the
   *  space-free `/n/<id>`. Absent only inside the 409 conflict envelope —
   *  the saver already knows where it was saving. */
  space: SpaceSlugSchema.optional(),
  title: z.string().optional(),
  filePath: z.string().optional(),
  /** The note's class, mount-derived and read-only. Orthogonal to the
   *  free-form frontmatter `type`: `class` follows the mount, `type` is a label.
   *  canon: docs/note-model.md#note-classes */
  class: NoteClassSchema.optional(),
  /** Role and skill packages share the `skill` note class and storage machinery;
   *  this typed discriminator lets package-aware chrome choose the right surface. */
  agentKind: z.enum(['role', 'skill']).optional(),
  /** Exact authored leading H1 when the stored body has one. It can differ from
   *  the package's manifest name, which remains the note identity label. */
  documentTitle: z.string().optional(),
  content: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  /** The editable display slug, lifted from frontmatter `slug:`; the
   *  client builds the canonical `/n/<id>/<slug>` URL from it. Absent when the
   *  note has no custom slug (the URL tail then derives from the title). */
  slug: z.string().optional(),
  /** Alias-history: past human names the resolver honours, lifted from
   *  frontmatter `aliases:` to a typed field so a client round-trips them without
   *  re-parsing frontmatter. Absent when never renamed. */
  aliases: z.array(z.string()).optional(),
  /** Last content change. Precise for everything that happened on this server's
   *  watch (journal is the source); day precision when only the engine's
   *  inventory date is known. */
  modifiedAt: IsoTimestampSchema.optional(),
  /** The note's resolved creation instant, full ISO-8601 UTC — the editable
   *  date-as-data axis. Served on the read form so the metadata aside prefills the
   *  date field WITHOUT re-parsing `frontmatter.created` (which is absent when the
   *  date is birthtime-derived, not yet pinned). null = the engine knows no date. */
  createdAt: z.string().nullable().optional(),
  /** Opaque version of the content just read. Echoed back on save for
   *  compare-and-swap; the client never inspects the value.
   *  canon: docs/architecture.md#p3 */
  versionToken: z.string(),
  /** Trash state: true when this id resolves to a DELETED note — the read
   *  served its last journaled state (read-only) instead of 404ing, so the reader
   *  shows it under a "deleted" banner. The fields below ride along then; on a
   *  live note they are absent. `content` is the last body (empty when an honest
   *  gap left nothing to recover); `versionToken` is meaningless (no live note to
   *  save against) and the reader hides editing. */
  deleted: z.boolean().optional(),
  /** When the note was deleted (the delete-tombstone's journal timestamp). */
  deletedAt: z.string().optional(),
  /** Who deleted it, resolved + privacy-filtered; null = an external delete. */
  deletedBy: AuthorSchema.nullable().optional(),
  /** Whether historical content is available for the read-only preview. This is
   *  deliberately NOT restore eligibility: opaque or unsafe source can still be
   *  inspected even though publishing it back would be refused. */
  restorable: z.boolean().optional(),
  /** Authoritative restore eligibility for a deleted note. Present on deleted
   *  responses; absent on live notes. */
  restoreAvailability: RestoreAvailabilitySchema.optional(),
  /** Exact opaque source for a deleted note. UTF-8 is literal text; arbitrary
   * bytes are base64. When present, clients must not pass `content` through a
   * Markdown renderer. */
  source: LiteralSourceSchema.optional(),
})

export const CreateNoteRequestSchema = z.object({
  ...noteWriteFields,
  /** What to do when the folder already holds a note with this title. Absent =
   *  `fail`: no client can make a create replace someone else's bytes.
   *  canon: docs/note-model.md#create-collisions */
  ifExists: z.enum([IF_EXISTS.fail, IF_EXISTS.uniquify]).optional(),
})

export const UpdateNoteRequestSchema = z
  .object({
    ...noteWriteFields,
    /** Exact Role package whose authored attachment list is being replaced. This
     *  is sent only when that list changed; ordinary instruction saves omit both
     *  fields and therefore preserve even currently-invalid raw attachment tokens. */
    abilityLocator: OwnedRoleAbilityLocatorSchema.optional(),
    attachments: z.array(AuthoredAttachmentSchema).max(64).optional(),
    /** The note-id being edited in place — triggers move-then-write so a
     *  title/folder change renames rather than duplicating (the rename invariant). */
    originalId: DurableNonEmptyScalarSchema,
    /** The version the editor read (see NoteDetailResponseSchema.versionToken): the
     *  writer must prove what it's overwriting. A stale token → 409 ConflictResponse. */
    versionToken: z.string(),
  })
  .superRefine((value, ctx) => {
    if ((value.abilityLocator === undefined) !== (value.attachments === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'abilityLocator and attachments must be passed together',
      })
    }
  })

export const SaveResponseSchema = z.object({
  ok: z.literal(true),
  /** The saved note's identity — what the client navigates to. Stable across
   *  renames: equals originalId when one was sent. */
  id: z.string(),
  filePath: z.string().optional(),
  /** The title the note actually landed under — the server derives it from the body,
   *  and an `ifExists:'uniquify'` create may have stepped aside to a free one, so the
   *  saver cannot assume it got what it sent. */
  title: z.string().optional(),
  /** Version of the note as just written — lets a client (or agent) chain a
   *  follow-up save without an interim read. */
  versionToken: z.string(),
})

/** One note restored by a batch trash-restore: the same write echo as a
 *  single restore/save, minus the envelope's top-level `ok`. */
export const RestoredNoteSchema = SaveResponseSchema.omit({ ok: true })

/** 409 envelope for a save whose versionToken went stale: the writer's
 *  read happened before someone else's write. Carries the LIVE note — content
 *  and a fresh token — so the client can show the other side and let the user
 *  decide; neither version is lost silently (P3). Re-sending the save with
 *  `current.versionToken` is the explicit "I saw it, overwrite" move. */
export const ConflictResponseSchema = z.object({
  error: z.string(),
  reason: z.literal('version_conflict'),
  current: NoteDetailResponseSchema,
})

/** 409 envelope for a create the server refused because a note already holds the
 *  destination — the same "nothing was overwritten, here is the other side" shape as
 *  the CAS conflict above. `existing` names the occupant so the client can offer to
 *  open it; absent when the collision was caught by disk truth (an unindexed file has
 *  no identity to name). Re-sending with `ifExists: 'uniquify'` is the explicit
 *  "put mine beside it" move. */
export const NoteExistsResponseSchema = z.object({
  error: z.string(),
  reason: z.literal('note_already_exists'),
  existing: z.object({ id: z.string(), title: z.string(), filePath: z.string() }).optional(),
  /** The title an `ifExists:'uniquify'` retry would take, so the client can offer it by
   *  name. A PREVIEW, not a reservation — a racing writer can take it first, and the
   *  save answers with the name it actually got. */
  suggestedTitle: z.string().optional(),
})

export const RemoveResponseSchema = z.object({
  ok: z.literal(true),
})

export const MoveRequestSchema = z.object({
  id: DurableNonEmptyScalarSchema,
  destinationPath: DurableAddressPathSchema,
})

export const MoveResponseSchema = z.object({
  ok: z.literal(true),
})

/** PUT /api/note/pin — toggle a note's `always-load` membership: pin adds the tag,
 *  unpin removes it. WHERE it then surfaces (personal profile vs a project bundle) follows
 *  from WHERE the note lives — the scan owns that (a note outside the personal domain and
 *  any project pins nowhere; the UI hides the action there). `note:write` on the note's
 *  registry space. */
export const PinNoteRequestSchema = z.object({ id: z.string(), pinned: z.boolean() })

export const PinNoteResponseSchema = z.object({ ok: z.literal(true), pinned: z.boolean() })

/** PUT /api/note/mute — toggle a memory category's `muted` opt-out: muted
 *  stays in the audit but drops from the agent's eager profile. `note:write` on the
 *  note's registry space (the personal domain for about-user memory, the project's
 *  space for about-project memory). */
export const MuteNoteRequestSchema = z.object({ id: z.string(), muted: z.boolean() })

export const MuteNoteResponseSchema = z.object({ ok: z.literal(true), muted: z.boolean() })

export type NoteDetail = z.infer<typeof NoteDetailResponseSchema>

export type CreateNoteRequest = z.infer<typeof CreateNoteRequestSchema>

export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequestSchema>

export type MoveRequest = z.infer<typeof MoveRequestSchema>

export type SaveResponse = z.infer<typeof SaveResponseSchema>

export type RestoredNote = z.infer<typeof RestoredNoteSchema>

export type ConflictResponse = z.infer<typeof ConflictResponseSchema>

export type NoteExistsResponse = z.infer<typeof NoteExistsResponseSchema>

export type RemoveResponse = z.infer<typeof RemoveResponseSchema>

export type MoveResponse = z.infer<typeof MoveResponseSchema>

export type PinNoteRequest = z.infer<typeof PinNoteRequestSchema>

export type PinNoteResponse = z.infer<typeof PinNoteResponseSchema>

export type MuteNoteRequest = z.infer<typeof MuteNoteRequestSchema>

export type MuteNoteResponse = z.infer<typeof MuteNoteResponseSchema>
