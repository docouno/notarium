import { z } from 'zod'

import { ROLE_ATTACHMENT_STATE } from '../../consts'
import { PinnedNoteSchema } from '../rest/agent/context'
import { EffectiveRoleSummarySchema, RoleNameSchema } from '../rest/agent/roles'
import { sessionField } from './_fields'
import { RuntimeSkillSummarySchema } from './abilities'
import { ProjectHandleSchema } from './primitives'

const roleSelector = {
  role: RoleNameSchema.optional(),
  /** Compatibility alias for clients that follow a literal generic-name schema. */
  name: RoleNameSchema.optional(),
}

export const RoleSelectorSchema = z
  .object(roleSelector)
  .strict()
  .superRefine((value, ctx) => {
    const count = Number(value.role !== undefined) + Number(value.name !== undefined)

    if (count !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'provide exactly one of role or name',
      })
    }
  })

/** The handler enforces the exactly-one selector with its public guiding error. */
export const UseRoleInputSchema = z
  .object({
    ...sessionField,
    ...roleSelector,
    /** The current project handle when activating a project/space override. */
    project: ProjectHandleSchema.optional(),
    budgetTokens: z.number().int().min(100).max(16_000).default(4_000),
  })
  .strict()

const AttachmentFactsSchema = z.object({
  name: RoleNameSchema,
  title: z.string().trim().min(1).max(512),
  description: z.string(),
})

export const LoadedRoleSkillSchema = AttachmentFactsSchema.extend({
  state: z.literal(ROLE_ATTACHMENT_STATE.loaded),
  instructions: z.string(),
}).strict()

export const OmittedRoleSkillSchema = AttachmentFactsSchema.extend({
  state: z.literal(ROLE_ATTACHMENT_STATE.omittedByBudget),
}).strict()

export const RoleAttachmentStateSchema = z.discriminatedUnion('state', [
  LoadedRoleSkillSchema,
  OmittedRoleSkillSchema,
])

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
  skills: z.array(RoleAttachmentStateSchema).optional(),
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

export const UseSkillInputSchema = z
  .object({
    ...sessionField,
    skill: RoleNameSchema.optional().describe(
      'Canonical standalone-skill selector. Provide exactly one of `skill` or compatibility alias `name`.',
    ),
    name: RoleNameSchema.optional().describe(
      'Compatibility alias for `skill`. Provide exactly one of `skill` or `name`, never both.',
    ),
    project: ProjectHandleSchema.optional(),
    budgetTokens: z.number().int().min(100).max(16_000).default(4_000),
  })
  .strict()

export const UseSkillOutputSchema = z
  .object({
    status: z.literal('activated'),
    skill: RuntimeSkillSummarySchema,
    instructions: z.string(),
  })
  .strict()

export type UseRoleInput = z.infer<typeof UseRoleInputSchema>
export type UseRoleOutput = z.infer<typeof UseRoleOutputSchema>
export type RoleAttachmentState = z.infer<typeof RoleAttachmentStateSchema>
export type UseSkillInput = z.infer<typeof UseSkillInputSchema>
export type UseSkillOutput = z.infer<typeof UseSkillOutputSchema>
