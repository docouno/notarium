import { z } from 'zod'

import {
  ABILITY_ATTACHMENT_HEALTH,
  ABILITY_CONTINUATION_REASON,
  ABILITY_CONTINUATION_REQUIREMENT,
  ABILITY_CREATE_OUTCOME,
  ABILITY_CREATE_WARNING,
  ABILITY_KIND,
  ABILITY_LIST_VIEW,
  ABILITY_SAVE_OUTCOME,
  ABILITY_SAVE_STEP,
  ABILITY_SOURCE,
  AGENT_PACKAGE_LIBRARY_QUERY_MAX,
  ROLE_SCOPE,
} from '../../consts'
import { enumValues } from '../../libs/enumValues'
import {
  AuthoredSkillInstructionsSchema,
  SkillDescriptionSchema,
  SkillNameSchema,
} from '../rest/_fields'
import {
  AgentAbilityAvailabilitySchema,
  AgentAbilityAvailabilityStateSchema,
} from '../rest/agent/abilities'
import { sessionField } from './_fields'
import { ProjectHandleSchema } from './primitives'

const AbilityRefSchema = z.string().min(1).max(512)

const AbilityFacts = {
  ref: AbilityRefSchema,
  name: SkillNameSchema,
  title: z.string().trim().min(1).max(512),
  description: SkillDescriptionSchema,
}

const SystemRoleSummarySchema = z
  .object({
    ...AbilityFacts,
    source: z.literal(ABILITY_SOURCE.system),
    kind: z.literal(ABILITY_KIND.role),
    effective: z.boolean().optional(),
    healthy: z.literal(false).optional(),
  })
  .strict()

const SystemSkillSummarySchema = z
  .object({
    ...AbilityFacts,
    source: z.literal(ABILITY_SOURCE.system),
    kind: z.literal(ABILITY_KIND.skill),
    effective: z.boolean().optional(),
  })
  .strict()

export const AbilityVersionSchema = z
  .object({
    project: ProjectHandleSchema,
    ref: AbilityRefSchema,
  })
  .strict()

const OwnedFacts = {
  ...AbilityFacts,
  source: z.literal(ABILITY_SOURCE.owned),
  enabled: z.boolean(),
  effective: z.boolean(),
}

const OwnedRoleSummarySchema = z
  .object({
    ...OwnedFacts,
    kind: z.literal(ABILITY_KIND.role),
    scope: z.enum([ROLE_SCOPE.personal, ROLE_SCOPE.space, ROLE_SCOPE.project]),
    healthy: z.literal(false).optional(),
    versions: z.array(AbilityVersionSchema).max(128).optional(),
  })
  .strict()

const OwnedSkillSummarySchema = z
  .object({
    ...OwnedFacts,
    kind: z.literal(ABILITY_KIND.skill),
    scope: z.enum([ROLE_SCOPE.personal, ROLE_SCOPE.space]),
  })
  .strict()

export const AbilitySummarySchema = z.union([
  SystemRoleSummarySchema,
  SystemSkillSummarySchema,
  OwnedRoleSummarySchema,
  OwnedSkillSummarySchema,
])

const RuntimeAbilityFacts = {
  name: SkillNameSchema,
  title: z.string().trim().min(1).max(512),
  description: SkillDescriptionSchema,
}

const SystemRuntimeRoleSummarySchema = z
  .object({
    ...RuntimeAbilityFacts,
    kind: z.literal(ABILITY_KIND.role),
    source: z.literal(ABILITY_SOURCE.system),
  })
  .strict()

const SystemRuntimeSkillSummarySchema = z
  .object({
    ...RuntimeAbilityFacts,
    kind: z.literal(ABILITY_KIND.skill),
    source: z.literal(ABILITY_SOURCE.system),
  })
  .strict()

const OwnedRuntimeRoleSummarySchema = z
  .object({
    ...RuntimeAbilityFacts,
    kind: z.literal(ABILITY_KIND.role),
    source: z.literal(ABILITY_SOURCE.owned),
    scope: z.enum([ROLE_SCOPE.personal, ROLE_SCOPE.space, ROLE_SCOPE.project]),
  })
  .strict()

const OwnedRuntimeSkillSummarySchema = z
  .object({
    ...RuntimeAbilityFacts,
    kind: z.literal(ABILITY_KIND.skill),
    source: z.literal(ABILITY_SOURCE.owned),
    scope: z.enum([ROLE_SCOPE.personal, ROLE_SCOPE.space]),
  })
  .strict()

export const RuntimeAbilitySummarySchema = z.union([
  SystemRuntimeRoleSummarySchema,
  SystemRuntimeSkillSummarySchema,
  OwnedRuntimeRoleSummarySchema,
  OwnedRuntimeSkillSummarySchema,
])

export const RuntimeSkillSummarySchema = z.union([
  SystemRuntimeSkillSummarySchema,
  OwnedRuntimeSkillSummarySchema,
])

export const ListAbilitiesInputSchema = z
  .object({
    ...sessionField,
    view: z.enum(enumValues(ABILITY_LIST_VIEW)).default(ABILITY_LIST_VIEW.runtime),
    kind: z.enum(enumValues(ABILITY_KIND)).optional(),
    source: z.enum([ABILITY_SOURCE.system, ABILITY_SOURCE.owned]).optional(),
    project: ProjectHandleSchema.optional(),
    q: z.string().trim().min(1).max(AGENT_PACKAGE_LIBRARY_QUERY_MAX).optional(),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16}$/)
      .optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict()

export const NextAbilityActionSchema = z
  .object({
    tool: z.literal('list_abilities'),
    arguments: ListAbilitiesInputSchema,
    reason: z.enum(enumValues(ABILITY_CONTINUATION_REASON)),
    requiredBefore: z.literal(ABILITY_CONTINUATION_REQUIREMENT.activationOrAnswer),
  })
  .strict()

export const ListAbilitiesOutputSchema = z
  .object({
    abilities: z.array(AbilitySummarySchema),
    total: z.number().int().nonnegative(),
    nextCursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16}$/)
      .optional(),
    nextAction: NextAbilityActionSchema.optional(),
    truncated: z.literal(true).optional(),
  })
  .strict()

const FullAbilityFacts = {
  ref: AbilityRefSchema,
  name: SkillNameSchema,
  title: z.string().trim().min(1).max(512),
  description: SkillDescriptionSchema,
  instructions: AuthoredSkillInstructionsSchema,
  enabled: z.boolean(),
}

export const AbilityAuthoringAttachmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), ref: AbilityRefSchema, label: SkillNameSchema }).strict(),
  z
    .object({
      kind: z.literal('invalid'),
      raw: z.string(),
      reason: z.literal(ABILITY_ATTACHMENT_HEALTH.invalidLocator),
    })
    .strict(),
])

export const AbilityAuthoringHealthSchema = z
  .object({
    healthy: z.boolean(),
    attachments: z
      .array(
        z
          .object({
            attachment: AbilityAuthoringAttachmentSchema,
            health: z.enum(enumValues(ABILITY_ATTACHMENT_HEALTH)),
          })
          .strict(),
      )
      .max(64),
  })
  .strict()

const SystemRoleDetailsSchema = z
  .object({
    ...FullAbilityFacts,
    source: z.literal(ABILITY_SOURCE.system),
    kind: z.literal(ABILITY_KIND.role),
    health: AbilityAuthoringHealthSchema,
  })
  .strict()

const SystemSkillDetailsSchema = z
  .object({
    ...FullAbilityFacts,
    source: z.literal(ABILITY_SOURCE.system),
    kind: z.literal(ABILITY_KIND.skill),
  })
  .strict()

const OwnedDetailsFacts = {
  ...FullAbilityFacts,
  source: z.literal(ABILITY_SOURCE.owned),
  versionToken: z.string().min(1),
}

const OwnedRoleDetailsSchema = z
  .object({
    ...OwnedDetailsFacts,
    kind: z.literal(ABILITY_KIND.role),
    scope: z.enum([ROLE_SCOPE.personal, ROLE_SCOPE.space, ROLE_SCOPE.project]),
    availability: AgentAbilityAvailabilityStateSchema.optional(),
    health: AbilityAuthoringHealthSchema,
  })
  .strict()

const OwnedSkillDetailsSchema = z
  .object({
    ...OwnedDetailsFacts,
    kind: z.literal(ABILITY_KIND.skill),
    scope: z.enum([ROLE_SCOPE.personal, ROLE_SCOPE.space]),
    availability: AgentAbilityAvailabilityStateSchema.optional(),
  })
  .strict()

export const AbilityDetailsSchema = z.union([
  SystemRoleDetailsSchema,
  SystemSkillDetailsSchema,
  OwnedRoleDetailsSchema,
  OwnedSkillDetailsSchema,
])

export const GetAbilityInputSchema = z.object({ ...sessionField, ref: AbilityRefSchema }).strict()

export const GetAbilityOutputSchema = z.object({ ability: AbilityDetailsSchema }).strict()

export const AbilityPlacementSchema = z.discriminatedUnion('home', [
  z.object({ home: z.literal(ROLE_SCOPE.personal) }).strict(),
  z
    .object({ home: z.literal(ROLE_SCOPE.space), space: z.string().trim().min(1).max(200) })
    .strict(),
  z.object({ home: z.literal(ROLE_SCOPE.project), project: ProjectHandleSchema }).strict(),
])

export const AbilityAuthoredAttachmentInputSchema = z
  .object({ ref: AbilityRefSchema, label: SkillNameSchema.optional() })
  .strict()

export const CreateAbilityInputSchema = z
  .object({
    ...sessionField,
    idempotencyKey: z.string().min(1).max(200).optional(),
    kind: z.enum(enumValues(ABILITY_KIND)),
    name: SkillNameSchema,
    description: SkillDescriptionSchema,
    instructions: AuthoredSkillInstructionsSchema,
    placement: AbilityPlacementSchema,
    availability: AgentAbilityAvailabilitySchema.optional(),
    attachments: z.array(AbilityAuthoredAttachmentInputSchema).max(64).optional(),
  })
  .strict()

export const CreateAbilityOutputSchema = z
  .object({
    ref: AbilityRefSchema,
    versionToken: z.string().min(1),
    name: SkillNameSchema,
    outcome: z.enum(enumValues(ABILITY_CREATE_OUTCOME)),
    warnings: z
      .array(z.enum(enumValues(ABILITY_CREATE_WARNING)))
      .max(1)
      .optional(),
  })
  .strict()

export const EditAbilityInputSchema = z
  .object({
    ...sessionField,
    ref: AbilityRefSchema,
    versionToken: z.string().min(1).optional(),
    description: SkillDescriptionSchema.optional(),
    instructions: AuthoredSkillInstructionsSchema.optional(),
    attachments: z.array(AbilityAuthoredAttachmentInputSchema).max(64).optional(),
    availability: AgentAbilityAvailabilitySchema.optional(),
    enabled: z.boolean().optional(),
    home: z
      .object({ home: z.literal(ROLE_SCOPE.space) })
      .strict()
      .optional(),
  })
  .strict()

export const AbilityStepSchema = z.enum(enumValues(ABILITY_SAVE_STEP))

export const AbilityStepOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ step: AbilityStepSchema, outcome: z.literal(ABILITY_SAVE_OUTCOME.applied) }).strict(),
  z.object({ step: AbilityStepSchema, outcome: z.literal(ABILITY_SAVE_OUTCOME.skipped) }).strict(),
  z
    .object({
      step: AbilityStepSchema,
      outcome: z.literal(ABILITY_SAVE_OUTCOME.failed),
      error: z.string().min(1),
    })
    .strict(),
])

export const EditAbilityOutputSchema = z
  .object({
    ref: AbilityRefSchema,
    versionToken: z.string().min(1).optional(),
    steps: z.array(AbilityStepOutcomeSchema).min(1).max(4),
  })
  .strict()

export const DeleteAbilityInputSchema = z
  .object({ ...sessionField, ref: AbilityRefSchema })
  .strict()

export const DeleteAbilityOutputSchema = z
  .object({ ref: AbilityRefSchema, name: SkillNameSchema })
  .strict()

export type AbilitySummary = z.infer<typeof AbilitySummarySchema>
export type RuntimeAbilitySummary = z.infer<typeof RuntimeAbilitySummarySchema>
export type RuntimeSkillSummary = z.infer<typeof RuntimeSkillSummarySchema>
export type ListAbilitiesInput = z.infer<typeof ListAbilitiesInputSchema>
export type NextAbilityAction = z.infer<typeof NextAbilityActionSchema>
export type ListAbilitiesOutput = z.infer<typeof ListAbilitiesOutputSchema>
export type AbilityDetails = z.infer<typeof AbilityDetailsSchema>
export type GetAbilityInput = z.infer<typeof GetAbilityInputSchema>
export type GetAbilityOutput = z.infer<typeof GetAbilityOutputSchema>
export type AbilityPlacement = z.infer<typeof AbilityPlacementSchema>
export type AbilityAuthoredAttachmentInput = z.infer<typeof AbilityAuthoredAttachmentInputSchema>
export type CreateAbilityInput = z.infer<typeof CreateAbilityInputSchema>
export type CreateAbilityOutput = z.infer<typeof CreateAbilityOutputSchema>
export type EditAbilityInput = z.infer<typeof EditAbilityInputSchema>
export type EditAbilityOutput = z.infer<typeof EditAbilityOutputSchema>
export type DeleteAbilityInput = z.infer<typeof DeleteAbilityInputSchema>
export type DeleteAbilityOutput = z.infer<typeof DeleteAbilityOutputSchema>
