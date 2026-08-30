import { z } from 'zod'
import { FieldPatchSchema, FieldValueSchema, SpaceSlugSchema } from '../primitives'
import { ProjectHandleSchema } from './primitives'

const CONTROL_TAG_KEY =
  /<\/?(?:system|systemprompt|instructions?|assistant|developer|human|user|tool_call|tool_result|tool_use|function_calls?|function_results?|antml)\b[^>]*>/i

/** Shared by the MCP input contract and output sanitizer so a pseudo-control key
 * is refused before nested validation can reflect it back to an agent. */
export const isUnsafeMcpFieldKey = (key: string): boolean => CONTROL_TAG_KEY.test(key)

export const McpFieldPatchSchema = z.unknown().transform((value, ctx) => {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.getOwnPropertyNames(value).some(isUnsafeMcpFieldKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'field key is not available through the agent interface',
      })
      return z.NEVER
    }
  }
  const parsed = FieldPatchSchema.safeParse(value)

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: issue.path })
    }

    return z.NEVER
  }

  return parsed.data
})

/** JSON-schema publication twin. Runtime validation stays on McpFieldPatchSchema;
 * this shape only tells clients the exact open record grammar. */
export const McpFieldPatchPublishedSchema = z.record(z.string(), FieldValueSchema)

/** The THREE-state location an agent reads on a hit/change — a single `project?`
 *  can't tell a free note in a work space from a personal-domain one, so all three
 *  are independent:
 *    • `space?` absent ⇒ the personal domain; present ⇒ that work space.
 *    • `project?` present ⇒ its handle (round-trips back into a tool's `project`).
 *    • `path?` the note's space-relative stem WITHOUT `.md`. READ-ONLY (references
 *      are always by note-id). It is a NOTE stem, NOT a folder — the create/move
 *      tools take a FOLDER (a `folders` entry); drop the last segment for its folder. */
export const locationFields = {
  space: SpaceSlugSchema.optional(),
  project: ProjectHandleSchema.optional(),
  path: z.string().optional(),
}

/** A server-minted agent-work episode id. The long behavioural instructions live
 * on start_session; repeating them on every tool would bloat tools/list. */
export const AgentSessionIdSchema = z.string().regex(/^ses_[A-Za-z0-9_-]{12}$/)

/** Every auditable/delta-relevant tool carries this field. Batch tools attach once
 * at the outer call, never per item. whoami/get_my_projects deliberately omit it. */
export const sessionField = {
  session: AgentSessionIdSchema.optional().describe('the sessionId from start_session'),
}
