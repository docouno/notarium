import { z } from 'zod'

import { ABILITY_SOURCE, ROLE_SCOPE } from '../../../consts/primitives'
import { enumValues } from '../../../libs/enumValues'
import { ProjectSummarySchema } from '../../tools/primitives'
import {
  AuthoredSkillInstructionsSchema,
  SkillDescriptionSchema,
  SkillNameSchema,
} from '../_fields'
import {
  AgentAbilityAvailabilitySchema,
  AgentAbilitySummarySchema,
  AuthoredAttachmentSchema,
  OwnedRoleAbilityLocatorSchema,
} from './abilities'
import { AgentPackageLibraryPageSchema } from './packageLibrary'

export const RoleNameSchema = SkillNameSchema

export const RoleScopeSchema = z.enum(enumValues(ROLE_SCOPE))
export const InstalledRoleScopeSchema = z.enum([
  ROLE_SCOPE.personal,
  ROLE_SCOPE.space,
  ROLE_SCOPE.project,
])

export const RoleSummarySchema = z.object({
  name: RoleNameSchema,
  title: z.string().trim().min(1).max(512),
  description: SkillDescriptionSchema,
  scope: RoleScopeSchema,
  origin: z.string().max(128).optional(),
  originRevision: z.string().max(80).optional(),
})
/** What every role summary states about itself, with no placement in it. */
const RoleFactsSchema = RoleSummarySchema.omit({ scope: true })

/** The Owned arm: a role that LIVES somewhere the caller can address. */
export const EffectiveOwnedRoleSummarySchema = RoleFactsSchema.extend({
  source: z.literal(ABILITY_SOURCE.owned),
  scope: InstalledRoleScopeSchema,
}).strict()

/** A role that ANSWERS in this context. A union on `source`, not an optional `scope`:
 *  a System role ships with the host and has no placement, and the shape that demanded
 *  one could not express it — which is how the resolver came to have no System link at
 *  all while the taxonomy, the library surface and the docs all said it did. */
export const EffectiveRoleSummarySchema = z.discriminatedUnion('source', [
  // Strict on both arms, like the neighbouring inventory and skill shapes: without it
  // the System arm silently accepts a `scope` it has no placement to put there, and a
  // producer that invented one would never be caught.
  RoleFactsSchema.extend({ source: z.literal(ABILITY_SOURCE.system) }).strict(),
  EffectiveOwnedRoleSummarySchema,
])

export const RoleInventoryEntrySchema = z.discriminatedUnion('scope', [
  RoleSummarySchema.extend({ scope: z.literal(ROLE_SCOPE.personal), noteId: z.string().min(1) }),
  RoleSummarySchema.extend({
    scope: z.literal(ROLE_SCOPE.space),
    space: z.string(),
    noteId: z.string().min(1),
  }),
  RoleSummarySchema.extend({
    scope: z.literal(ROLE_SCOPE.project),
    space: z.string(),
    project: z.string().min(1),
    noteId: z.string().min(1),
  }),
])

export const MeAgentRolesResponseSchema = z.object({
  items: z.array(
    AgentAbilitySummarySchema.refine((ability) => ability.locator.kind === 'role', {
      message: 'role inventory may only contain role locators',
    }),
  ),
  projects: z.array(ProjectSummarySchema),
  activeRole: RoleNameSchema.nullable(),
  ...AgentPackageLibraryPageSchema,
  /** Honest bounded-view marker when the host has more role placements than one
   *  settings request may scan or return. */
  truncated: z.boolean().optional(),
  /** Where this deployment can actually publish a role package. A storage backend
   *  that cannot install one atomically is not a per-user setting and not an
   *  error to discover after the click — the client offers only the targets that
   *  answer true here.
   *
   *  `projects` is keyed by the exact value an Add would send — here a project
   *  handle from `projects` above — and a Project is true only when BOTH its
   *  placements are publishable: the role package goes to the project, its linked
   *  skills to the Space. Optional on the wire for rolling clients, and a missing
   *  field or key reads as `false` — an old response fails closed rather than
   *  advertising an install the host would refuse. */
  installAvailability: z
    .object({ personal: z.boolean(), projects: z.record(z.string(), z.boolean()) })
    .strict()
    .optional(),
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

export const AddAgentRoleResponseSchema = z.object({
  role: RoleInventoryEntrySchema,
  locator: OwnedRoleAbilityLocatorSchema,
  versionToken: z.string(),
})

const CustomRoleFields = {
  name: RoleNameSchema,
  description: SkillDescriptionSchema,
  instructions: AuthoredSkillInstructionsSchema,
  attachments: z.array(AuthoredAttachmentSchema).max(64).optional(),
}

export const CreateAgentRoleRequestSchema = z.discriminatedUnion('scope', [
  z.object({ ...CustomRoleFields, scope: z.literal(ROLE_SCOPE.personal) }).strict(),
  z
    .object({
      ...CustomRoleFields,
      scope: z.literal(ROLE_SCOPE.space),
      space: z.string().min(1),
      /** Optional, unlike a Skill's: "not stated" is the Space-wide reach a Space
       *  role has always had, so every existing caller keeps meaning what it meant. */
      availability: AgentAbilityAvailabilitySchema.optional(),
    })
    .strict(),
  z
    .object({
      ...CustomRoleFields,
      scope: z.literal(ROLE_SCOPE.project),
      project: z.string().min(1),
    })
    .strict(),
])

export const CreateAgentRoleResponseSchema = z.object({
  role: RoleInventoryEntrySchema,
  noteId: z.string().min(1),
  locator: OwnedRoleAbilityLocatorSchema,
  versionToken: z.string(),
})

export type RoleSummary = z.infer<typeof RoleSummarySchema>
export type EffectiveRoleSummary = z.infer<typeof EffectiveRoleSummarySchema>
export type RoleInventoryEntry = z.infer<typeof RoleInventoryEntrySchema>
export type MeAgentRolesResponse = z.infer<typeof MeAgentRolesResponseSchema>
export type AddAgentRoleRequest = z.infer<typeof AddAgentRoleRequestSchema>
export type AddAgentRoleResponse = z.infer<typeof AddAgentRoleResponseSchema>
export type CreateAgentRoleRequest = z.infer<typeof CreateAgentRoleRequestSchema>
export type CreateAgentRoleResponse = z.infer<typeof CreateAgentRoleResponseSchema>
