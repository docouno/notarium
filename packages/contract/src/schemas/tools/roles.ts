import { z } from 'zod'

import { PinnedNoteSchema } from '../rest/agent/context'
import { EffectiveRoleSummarySchema, RoleNameSchema } from '../rest/agent/roles'
import { sessionField } from './_fields'
import { ProjectHandleSchema } from './primitives'

const roleSelector = {
  role: RoleNameSchema.optional(),
  /** Compatibility alias for clients that follow a literal generic-name schema. */
  name: RoleNameSchema.optional(),
}

export const RoleSelectorSchema = z.object(roleSelector).superRefine((value, ctx) => {
  const count = Number(value.role !== undefined) + Number(value.name !== undefined)

  if (count !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provide exactly one of role or name',
    })
  }
})

/** Top-level stays a plain ZodObject because the MCP SDK reads `.shape`.
 * The handler enforces exactly-one selector. */
export const UseRoleInputSchema = z.object({
  ...sessionField,
  ...roleSelector,
  /** The current project handle when activating a project/space override. */
  project: ProjectHandleSchema.optional(),
  budgetTokens: z.number().int().min(100).max(16_000).default(4_000),
})

export const ListRolesInputSchema = z.object({
  ...sessionField,
  /** Same hint as start_session/use_role: resolves Project > Space > Personal. */
  project: ProjectHandleSchema.optional(),
  cursor: z
    .string()
    .regex(/^\d+$/)
    .refine((value) => Number.isSafeInteger(Number(value)), 'cursor is out of range')
    .optional(),
  limit: z.number().int().min(1).max(50).default(20),
})

export const LoadedRoleSkillSchema = z.object({
  name: RoleNameSchema,
  description: z.string(),
  instructions: z.string(),
})

const EffectiveBaseContextSchema = z.object({
  profile: z.object({
    memory: z.array(z.object({ noteId: z.string(), category: z.string(), summary: z.string() })),
    alwaysLoad: z.array(PinnedNoteSchema),
  }),
  project: z.object({ alwaysLoad: z.array(PinnedNoteSchema) }).optional(),
})

export const UseRoleOutputSchema = z.object({
  status: z.enum(['activated', 'already_active']),
  role: EffectiveRoleSummarySchema,
  instructions: z.string().optional(),
  skills: z.array(LoadedRoleSkillSchema).optional(),
  /** Exact role slice selected under the session's shared budget. Late activation also
   * returns the full surviving base replacement: refs absent from it were evicted by the
   * role-first curation and must no longer be treated as always-load. */
  context: z
    .object({
      alwaysLoad: z.array(PinnedNoteSchema),
      replacement: EffectiveBaseContextSchema.optional(),
      truncated: z.boolean().optional(),
    })
    .optional(),
  truncated: z.boolean().optional(),
})

export const ListRolesOutputSchema = z.object({
  roles: z.array(EffectiveRoleSummarySchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().optional(),
  /** The underlying owned library hit a host bound; this page is honest but not exhaustive. */
  truncated: z.boolean().optional(),
})

export type UseRoleInput = z.infer<typeof UseRoleInputSchema>
export type UseRoleOutput = z.infer<typeof UseRoleOutputSchema>
export type ListRolesInput = z.infer<typeof ListRolesInputSchema>
export type ListRolesOutput = z.infer<typeof ListRolesOutputSchema>
