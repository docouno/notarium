import { z } from 'zod'
import { DurableScalarSchema, DurableTextSchema, FieldPatchSchema } from '../primitives'

export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase alphanumeric with inner dashes')
  .refine((name) => !name.includes('--'), 'consecutive dashes are not allowed')

export const SkillDescriptionSchema = z
  .string()
  .max(1024)
  .refine(
    (description) => description.length === 0 || description.trim().length > 0,
    'description must be empty or contain non-whitespace text',
  )

export const SkillInstructionsSchema = z.string().max(262_144)

export const AuthoredSkillInstructionsSchema = SkillInstructionsSchema.min(1).refine(
  (instructions) => /^(?:[ \t]*\r?\n)*[ \t]*#(?!#)[ \t]+\S[^\r\n]*(?:\r?\n|$)/.test(instructions),
  'instructions must start with an H1 title',
)

export const noteWriteFields = {
  /** Optional: a note's title is a PROJECTION of its body (the leading
   *  `# H1`). The web editor omits this field entirely and authors the title as the
   *  document's first line; the server derives it at the write chokepoint. A present
   *  value is still honoured as an explicit title (and a leading duplicate `# title`
   *  in the body is peeled off), but no client need send it. */
  title: DurableScalarSchema.optional(),
  content: DurableTextSchema.optional(),
  /** The Agent Skill manifest description. The host admits it only for a root note
   * in the skill class and merges it into authored frontmatter by key. The manifest
   * NAME is absent on purpose: it is the package's machine key, minted once at
   * publication, and a display rename must not rekey locators, attachments or the
   * base a project version overrides.
   * canon: docs/note-model.md#roles-and-skills */
  description: SkillDescriptionSchema.optional(),
  /** Untrusted storage path. The lexical guard cannot live on the schema: a package
   *  member echoes its own hidden `.notarium/…` directory, which the ordinary address
   *  form rejects by design. So the rule moved to the route, and EVERY writer of this
   *  field owes it — pass it through `safeRelAddress` (or refuse the change outright,
   *  the way a skill member does) before the engine sees it. There is no schema-level
   *  net under a route that forgets. security spec: docs/architecture.md#p8 */
  directory: DurableScalarSchema.optional(),
  noteType: DurableScalarSchema.optional(),
  tags: z.union([z.array(DurableScalarSchema), DurableScalarSchema]).optional(),
  /** Authored frontmatter point patch carried by the ordinary editor Save. The
   * same domain patch also powers the dedicated point endpoint; the UI intent,
   * not a second patch grammar, decides which route is used. */
  fields: FieldPatchSchema.optional(),
  /** The editable display slug the user typed — three-state like the
   *  domain WriteInput: absent LEAVES the file's `slug:` untouched, a string SETS
   *  it (cleaned + kept only when it diverges from slug(title)), `''` CLEARS a
   *  custom slug. The server passes it straight to WriteInput.slug. */
  slug: DurableScalarSchema.optional(),
  /** Authored creation instant: the date-as-data axis the user edits in the
   *  metadata aside to correct historicity (an imported note, a migration). A FULL
   *  ISO-8601 datetime — this REST channel carries (and STRICTLY validates) minute
   *  precision, so a future time-of-day UI lands an exact instant, even though today's
   *  picker only sets a calendar day (the client builds local-midnight). Absent LEAVES
   *  the note's existing `created:` untouched (a normal body save never restamps it);
   *  a value SETS/overwrites it. `modified` is NOT editable — it stays the real mtime
   *  signal. The DOMAIN channel is shared with the agent `create_note.createdAt`
   *  (WriteInput.createdAt), but that MCP tool validates its own input — this
   *  strict datetime guard is REST-only. */
  createdAt: z.string().datetime({ offset: true }).optional(),
}
