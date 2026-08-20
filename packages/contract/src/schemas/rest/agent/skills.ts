import { z } from 'zod'

import { ROLE_SCOPE } from '../../../consts/primitives'
import { ProjectSummarySchema } from '../../tools/primitives'
import {
  AuthoredSkillInstructionsSchema,
  SkillDescriptionSchema,
  SkillNameSchema,
} from '../_fields'
import {
  AgentAbilityAvailabilitySchema,
  AgentAbilitySummarySchema,
  OwnedSkillAbilityLocatorSchema,
} from './abilities'
import { AgentPackageLibraryPageSchema } from './packageLibrary'

const SkillIdentitySchema = {
  name: SkillNameSchema,
  title: z.string().trim().min(1).max(512),
  description: SkillDescriptionSchema,
}

const AuthoredSkillSchema = {
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
  instructions: AuthoredSkillInstructionsSchema,
}

export const CreateAgentSkillRequestSchema = z.discriminatedUnion('scope', [
  z.object({ ...AuthoredSkillSchema, scope: z.literal(ROLE_SCOPE.personal) }).strict(),
  z
    .object({
      ...AuthoredSkillSchema,
      scope: z.literal(ROLE_SCOPE.space),
      space: z.string().min(1),
      availability: AgentAbilityAvailabilitySchema,
    })
    .strict(),
])

export const AddAgentSkillRequestSchema = z.discriminatedUnion('scope', [
  z.object({ name: SkillNameSchema, scope: z.literal(ROLE_SCOPE.personal) }).strict(),
  z
    .object({
      name: SkillNameSchema,
      scope: z.literal(ROLE_SCOPE.space),
      space: z.string().min(1),
      availability: AgentAbilityAvailabilitySchema,
    })
    .strict(),
])

const SkillProvenanceSchema = {
  origin: z.string().max(128).optional(),
  originRevision: z.string().max(80).optional(),
}

const OwnedSkillIdentitySchema = {
  ...SkillIdentitySchema,
  ...SkillProvenanceSchema,
  noteId: z.string().min(1),
}

const PersonalAgentSkillSummarySchema = z
  .object({ ...OwnedSkillIdentitySchema, scope: z.literal(ROLE_SCOPE.personal) })
  .strict()
const SpaceAgentSkillSummarySchema = z
  .object({
    ...OwnedSkillIdentitySchema,
    scope: z.literal(ROLE_SCOPE.space),
    space: z.string().min(1),
    availability: AgentAbilityAvailabilitySchema,
  })
  .strict()

export const AgentSkillSummarySchema = z.discriminatedUnion('scope', [
  PersonalAgentSkillSummarySchema,
  SpaceAgentSkillSummarySchema,
])

export const MeAgentSkillsResponseSchema = z.object({
  items: z.array(
    AgentAbilitySummarySchema.refine((ability) => ability.locator.kind === 'skill', {
      message: 'skill inventory may only contain skill locators',
    }),
  ),
  projects: z.array(ProjectSummarySchema),
  ...AgentPackageLibraryPageSchema,
  truncated: z.boolean().optional(),
})

export const CreateAgentSkillResponseSchema = z.object({
  skill: AgentSkillSummarySchema,
  noteId: z.string().min(1),
  locator: OwnedSkillAbilityLocatorSchema,
  versionToken: z.string(),
})

export const AddAgentSkillResponseSchema = CreateAgentSkillResponseSchema

export type AddAgentSkillRequest = z.infer<typeof AddAgentSkillRequestSchema>
export type AddAgentSkillResponse = z.infer<typeof AddAgentSkillResponseSchema>
export type CreateAgentSkillRequest = z.infer<typeof CreateAgentSkillRequestSchema>
export type AgentSkillSummary = z.infer<typeof AgentSkillSummarySchema>
export type MeAgentSkillsResponse = z.infer<typeof MeAgentSkillsResponseSchema>
export type CreateAgentSkillResponse = z.infer<typeof CreateAgentSkillResponseSchema>
