import { z } from 'zod'

import { ROLE_SCOPE } from '../../../consts/primitives'
import { enumValues } from '../../../libs/enumValues'
import { ProjectSummarySchema } from '../../tools/primitives'

export const RoleNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase alphanumeric with inner dashes')
  .refine((name) => !name.includes('--'), 'consecutive dashes are not allowed')

export const RoleScopeSchema = z.enum(enumValues(ROLE_SCOPE))
export const InstalledRoleScopeSchema = z.enum([
  ROLE_SCOPE.personal,
  ROLE_SCOPE.space,
  ROLE_SCOPE.project,
])

export const RoleSummarySchema = z.object({
  name: RoleNameSchema,
  description: z.string().min(1).max(1024),
  scope: RoleScopeSchema,
  origin: z.string().max(128).optional(),
  originRevision: z.string().max(80).optional(),
})
export const EffectiveRoleSummarySchema = RoleSummarySchema.extend({
  scope: InstalledRoleScopeSchema,
})

export const RoleInventoryEntrySchema = z.discriminatedUnion('scope', [
  RoleSummarySchema.extend({ scope: z.literal(ROLE_SCOPE.personal) }),
  RoleSummarySchema.extend({ scope: z.literal(ROLE_SCOPE.space), space: z.string() }),
  RoleSummarySchema.extend({
    scope: z.literal(ROLE_SCOPE.project),
    space: z.string(),
    project: z.string().min(1),
  }),
])

export const MeAgentRolesResponseSchema = z.object({
  catalog: z.array(RoleSummarySchema),
  roles: z.array(RoleInventoryEntrySchema),
  projects: z.array(ProjectSummarySchema),
  activeRole: RoleNameSchema.nullable(),
  /** Honest bounded-view marker when the host has more role placements than one
   *  settings request may scan or return. */
  truncated: z.boolean().optional(),
})

export const AgentRoleDetailParamsSchema = z.object({ name: RoleNameSchema })

export const AgentRoleDetailQuerySchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal(ROLE_SCOPE.catalog) }).strict(),
  z.object({ scope: z.literal(ROLE_SCOPE.personal) }).strict(),
  z.object({ scope: z.literal(ROLE_SCOPE.space), space: z.string().min(1) }).strict(),
  z.object({ scope: z.literal(ROLE_SCOPE.project), project: z.string().min(1) }).strict(),
])
export const AgentRoleDetailRequestSchema = z.discriminatedUnion('scope', [
  z.object({ name: RoleNameSchema, scope: z.literal(ROLE_SCOPE.catalog) }).strict(),
  z.object({ name: RoleNameSchema, scope: z.literal(ROLE_SCOPE.personal) }).strict(),
  z
    .object({ name: RoleNameSchema, scope: z.literal(ROLE_SCOPE.space), space: z.string().min(1) })
    .strict(),
  z
    .object({
      name: RoleNameSchema,
      scope: z.literal(ROLE_SCOPE.project),
      project: z.string().min(1),
    })
    .strict(),
])

const RoleInstructionsSchema = z.string().max(262_144)

export const AgentRoleDetailResponseSchema = z.object({
  role: RoleSummarySchema.extend({ instructions: RoleInstructionsSchema }),
  skills: z.array(
    z.object({
      name: RoleNameSchema,
      description: z.string().min(1).max(1024),
      instructions: RoleInstructionsSchema,
    }),
  ),
  truncated: z.boolean(),
})

export const AddAgentRoleRequestSchema = z
  .object({
    name: RoleNameSchema,
    scope: z.enum([ROLE_SCOPE.personal, ROLE_SCOPE.project]),
    project: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scope === ROLE_SCOPE.project && !value.project) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['project'],
        message: 'project is required',
      })
    }
    if (value.scope === ROLE_SCOPE.personal && value.project) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['project'],
        message: 'project is only valid for project scope',
      })
    }
  })

export const AddAgentRoleResponseSchema = z.object({ role: RoleInventoryEntrySchema })

export type RoleSummary = z.infer<typeof RoleSummarySchema>
export type EffectiveRoleSummary = z.infer<typeof EffectiveRoleSummarySchema>
export type RoleInventoryEntry = z.infer<typeof RoleInventoryEntrySchema>
export type MeAgentRolesResponse = z.infer<typeof MeAgentRolesResponseSchema>
export type AddAgentRoleRequest = z.infer<typeof AddAgentRoleRequestSchema>
export type AgentRoleDetailQuery = z.infer<typeof AgentRoleDetailQuerySchema>
export type AgentRoleDetailResponse = z.infer<typeof AgentRoleDetailResponseSchema>
