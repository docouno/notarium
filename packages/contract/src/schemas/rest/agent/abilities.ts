import { z } from 'zod'
import { ABILITY_AVAILABILITY_MODE } from '../../../consts/primitives'
import {
  ABILITY_ATTACHMENT_HEALTH,
  ABILITY_KIND,
  ABILITY_ORIGIN,
  ABILITY_SAVE_OUTCOME,
  ABILITY_SAVE_STEP,
  ABILITY_SOURCE,
  ROLE_SCOPE,
} from '../../../consts/primitives'
import { GENERATED_ID, GENERATED_ID_LENGTH } from '../../../consts/primitives'
import { enumValues } from '../../../libs/enumValues'
import { DurableNonEmptyScalarSchema, isWellFormedUnicode } from '../../primitives'
import { SkillDescriptionSchema, SkillInstructionsSchema, SkillNameSchema } from '../_fields'

/** The address of an Owned package — the exact storage-address form the host mints,
 *  not any durable scalar. Stated here because the carriers state it: the file library
 *  and the in-file skill link both refuse anything else, so a wider contract published
 *  a domain a hundred times larger than the one the system can produce, address or
 *  store — and a request valid by that contract reached a bare `Error` on the Save path
 *  instead of an honest refusal. */
export const AbilityPackageIdSchema = DurableNonEmptyScalarSchema.refine(
  (value) => value.length === GENERATED_ID_LENGTH && GENERATED_ID.test(value),
  'must be a generated package address',
)

const AbilityKindSchema = z.enum(enumValues(ABILITY_KIND))

export const SystemAbilityLocatorSchema = z
  .object({
    source: z.literal(ABILITY_SOURCE.system),
    kind: AbilityKindSchema,
    packageId: AbilityPackageIdSchema,
  })
  .strict()

export const CatalogAbilityLocatorSchema = z
  .object({
    source: z.literal(ABILITY_SOURCE.catalog),
    kind: AbilityKindSchema,
    packageId: AbilityPackageIdSchema,
  })
  .strict()

export const OwnedAbilityLocationSchema = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal(ROLE_SCOPE.personal),
      spaceId: DurableNonEmptyScalarSchema,
    })
    .strict(),
  z
    .object({
      scope: z.literal(ROLE_SCOPE.space),
      spaceId: DurableNonEmptyScalarSchema,
    })
    .strict(),
  z
    .object({
      scope: z.literal(ROLE_SCOPE.project),
      spaceId: DurableNonEmptyScalarSchema,
      projectId: DurableNonEmptyScalarSchema,
    })
    .strict(),
])

const OwnedSkillLocationSchema = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal(ROLE_SCOPE.personal),
      spaceId: DurableNonEmptyScalarSchema,
    })
    .strict(),
  z
    .object({
      scope: z.literal(ROLE_SCOPE.space),
      spaceId: DurableNonEmptyScalarSchema,
    })
    .strict(),
])

export const OwnedRoleAbilityLocatorSchema = z
  .object({
    source: z.literal(ABILITY_SOURCE.owned),
    kind: z.literal(ABILITY_KIND.role),
    packageId: AbilityPackageIdSchema,
    location: OwnedAbilityLocationSchema,
  })
  .strict()

export const OwnedSkillAbilityLocatorSchema = z
  .object({
    source: z.literal(ABILITY_SOURCE.owned),
    kind: z.literal(ABILITY_KIND.skill),
    packageId: AbilityPackageIdSchema,
    location: OwnedSkillLocationSchema,
  })
  .strict()

export const OwnedAbilityLocatorSchema = z.union([
  OwnedRoleAbilityLocatorSchema,
  OwnedSkillAbilityLocatorSchema,
])

export const AbilityLocatorSchema = z.union([
  SystemAbilityLocatorSchema,
  CatalogAbilityLocatorSchema,
  OwnedAbilityLocatorSchema,
])

export const AbilitySkillLocatorSchema = z.union([
  SystemAbilityLocatorSchema.extend({ kind: z.literal(ABILITY_KIND.skill) }),
  OwnedSkillAbilityLocatorSchema,
])

export const AuthoredAttachmentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('exact'),
      locator: AbilitySkillLocatorSchema,
      label: SkillNameSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('invalid'),
      /** Exactly what the PARSER can produce, and deliberately NOT a durable scalar.
       *
       *  This arm exists so an unrecognisable token travels verbatim, so any bound
       *  tighter than recognition is not a stricter wire — it is a door that answers 500
       *  for a package the host called valid. "Fixing" that by narrowing recognition
       *  instead deletes the author's token, and that mistake has already been made once
       *  here.
       *
       *  READING IS WIDER THAN WRITING, and that is stated rather than hidden. Not every
       *  token this arm carries can go back into the file: `yaml.stringify` puts
       *  `U+007F`, C1, NEL, LS and PS into quotes raw and the durable-frontmatter gate
       *  refuses the line, and it folds a long quoted scalar around column 80 — splitting
       *  a surrogate pair if one lands there. So a hand-edited package stays OPENABLE,
       *  and an edit of its attachment list is refused BY NAME (`unwritableSkillLinks`,
       *  next to the two writers) instead of falling through to a bare 400 from a gate
       *  that knows nothing about attachments.
       *
       *  Two axes, and the first pass only got one of them. LENGTH: counted in CODE
       *  POINTS, because core's quantifier is a `/u` regex and counts them too —
       *  measured in UTF-16 units, a token of 1 024 emoji is refused by the wire and
       *  accepted by the parser. CHARACTERS: the durable-scalar family bans C0/C1,
       *  `U+0085`, `U+2028` and `U+2029`, and the parser bans none of those — it stops
       *  only at `]`, CR and LF. A hand-edited `SKILL.md` carrying one of them was read
       *  as an attachment and refused on the way out.
       *
       *  Well-formed Unicode stays required: that is about being representable at all,
       *  not about being tidy. Mirrors `MAX_SKILL_TOKEN` in core, held to it by the
       *  drift arc in `enumDrift`. */
      raw: z
        .string()
        .refine(isWellFormedUnicode, 'must contain well-formed Unicode')
        .refine(
          (value) => /^\[\[[^\]\r\n]+\]\]$/u.test(value),
          'must be an attachment token the parser can produce',
        )
        .refine((value) => [...value].length <= 1_028, 'must contain at most 1028 code points'),
      reason: z.literal('invalid-locator'),
    })
    .strict(),
])

export const AbilityAttachmentStateSchema = z
  .object({
    attachment: AuthoredAttachmentSchema,
    health: z.enum(enumValues(ABILITY_ATTACHMENT_HEALTH)),
  })
  .strict()

export const AbilityHealthSchema = z
  .object({
    healthy: z.boolean(),
    attachments: z.array(AbilityAttachmentStateSchema).max(64),
  })
  .strict()

export const OwnedAbilityOriginSchema = z.enum(enumValues(ABILITY_ORIGIN))

export const AgentAbilityAvailabilityStateSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal(ABILITY_AVAILABILITY_MODE.allProjects) }).strict(),
  z
    .object({
      mode: z.literal(ABILITY_AVAILABILITY_MODE.selectedProjects),
      projectIds: z.array(DurableNonEmptyScalarSchema).max(128),
    })
    .strict(),
])

/** The same reach, spelled the way a CREATE request can spell it: a caller that is
 *  publishing an ability does not know the project ids yet, so it names handles.
 *  Reads and updates use the stable-id form above. */
export const AgentAbilityAvailabilitySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal(ABILITY_AVAILABILITY_MODE.allProjects) }).strict(),
  z
    .object({
      mode: z.literal(ABILITY_AVAILABILITY_MODE.selectedProjects),
      projects: z.array(z.string().min(1)).min(1).max(128),
    })
    .strict(),
])

const AbilityIdentityFields = {
  locator: AbilityLocatorSchema,
  title: DurableNonEmptyScalarSchema.refine(
    (value) => value.length <= 512,
    'must contain at most 512 characters',
  ),
  name: SkillNameSchema,
  description: SkillDescriptionSchema,
}

const OriginRevisionSchema = DurableNonEmptyScalarSchema.refine(
  (value) => value.length <= 80,
  'must contain at most 80 characters',
)

const SystemAbilitySummarySchema = z
  .object({
    ...AbilityIdentityFields,
    locator: SystemAbilityLocatorSchema,
    source: z.literal(ABILITY_SOURCE.system),
    enabled: z.boolean(),
  })
  .strict()

const CatalogAbilitySummarySchema = z
  .object({
    ...AbilityIdentityFields,
    locator: CatalogAbilityLocatorSchema,
    source: z.literal(ABILITY_SOURCE.catalog),
  })
  .strict()

/** One project version of a Role, addressed by its own exact locator. A version is
 *  a PROPERTY of the role it overrides, never an item of its own: the agent names a
 *  role and a project, and the system resolves which body applies. */
export const AbilityVersionSchema = z
  .object({
    projectId: DurableNonEmptyScalarSchema,
    locator: OwnedRoleAbilityLocatorSchema,
  })
  .strict()

const OwnedAbilitySummarySchema = z
  .object({
    ...AbilityIdentityFields,
    locator: OwnedAbilityLocatorSchema,
    source: z.literal(ABILITY_SOURCE.owned),
    noteId: DurableNonEmptyScalarSchema,
    origin: OwnedAbilityOriginSchema,
    originRevision: OriginRevisionSchema.optional(),
    enabled: z.boolean(),
    availability: AgentAbilityAvailabilityStateSchema.optional(),
    /** Present on a collapsed Role listing. Empty is not the same as absent: absent
     *  means the surface does not collapse versions at all. */
    versions: z.array(AbilityVersionSchema).max(128).optional(),
    /** The Space base a project version overrides. Absent means this role only ever
     *  existed in its project — which is a different thing to tell the reader. */
    baseLocator: OwnedRoleAbilityLocatorSchema.optional(),
  })
  .strict()

export const AgentAbilitySummarySchema = z.discriminatedUnion('source', [
  SystemAbilitySummarySchema,
  CatalogAbilitySummarySchema,
  OwnedAbilitySummarySchema,
])

export const AgentAbilityDetailSchema = z.discriminatedUnion('source', [
  SystemAbilitySummarySchema.extend({ instructions: SkillInstructionsSchema }),
  CatalogAbilitySummarySchema.extend({ instructions: SkillInstructionsSchema }),
  OwnedAbilitySummarySchema.extend({ instructions: SkillInstructionsSchema }),
])

export const AgentAbilityDetailResponseSchema = z
  .object({
    ability: AgentAbilityDetailSchema,
    health: AbilityHealthSchema.optional(),
    truncated: z.boolean(),
  })
  .strict()

export const SetAgentAbilityEnabledRequestSchema = z.object({ enabled: z.boolean() }).strict()

export const SetAgentAbilityEnabledResponseSchema = z
  .object({ locator: AbilityLocatorSchema, enabled: z.boolean() })
  .strict()

export const SetAgentAbilityAvailabilityRequestSchema = AgentAbilityAvailabilityStateSchema.refine(
  (value) => value.mode === ABILITY_AVAILABILITY_MODE.allProjects || value.projectIds.length > 0,
  'selected-projects requires at least one project',
)

export const SetAgentAbilityAvailabilityResponseSchema = z
  .object({
    locator: OwnedAbilityLocatorSchema,
    availability: SetAgentAbilityAvailabilityRequestSchema,
  })
  .strict()

/** Fork a Space base into a project version of the same Role. */
export const CreateAbilityVersionRequestSchema = z
  .object({ projectId: DurableNonEmptyScalarSchema })
  .strict()

export const CreateAbilityVersionResponseSchema = z
  .object({
    locator: OwnedRoleAbilityLocatorSchema,
    noteId: DurableNonEmptyScalarSchema,
    versionToken: z.string(),
  })
  .strict()

/** Lifting a project version up to be its Space's base — the one move a role makes.
 *  The space is not part of the request because it cannot change: Personal ↔ Space is
 *  a move between two note stores, which the engine has no operation for, and faking
 *  it with publish+delete would change the package address every durable pointer is
 *  keyed by. Going the other way is not a move at all: a project version is CREATED
 *  from a base (`/versions`), so a downward wire would only be a second way to reach
 *  a state the first one already owns. `scope` is spelled out so the day a second
 *  destination exists, it is an added member and not a new shape. */
export const SetAbilityHomeRequestSchema = z.object({ scope: z.literal(ROLE_SCOPE.space) }).strict()

export const SetAbilityHomeResponseSchema = z
  .object({
    locator: OwnedRoleAbilityLocatorSchema,
    /** The reach the role kept: exactly the project it used to serve. Moving up must
     *  not widen what a role applies to. */
    availability: AgentAbilityAvailabilityStateSchema,
    noteId: DurableNonEmptyScalarSchema,
  })
  .strict()

/** One human Save over the authored document and the placement-owned settings.
 * `covers:null` means every project; a non-empty list names the exact project ids.
 * Attachments stay omission-sensitive: absent preserves the authored list, while an
 * empty list deliberately removes it. */
export const AbilitySaveRequestSchema = z
  .object({
    content: z.string(),
    description: SkillDescriptionSchema,
    attachments: z.array(AuthoredAttachmentSchema).max(64).optional(),
    covers: z.array(DurableNonEmptyScalarSchema).min(1).max(128).nullable(),
    enabled: z.boolean().optional(),
    versionToken: z.string(),
  })
  .strict()

const AbilitySaveStepSchema = z.enum(enumValues(ABILITY_SAVE_STEP))

export const AbilitySaveStepResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      step: AbilitySaveStepSchema,
      outcome: z.literal(ABILITY_SAVE_OUTCOME.applied),
    })
    .strict(),
  z
    .object({
      step: AbilitySaveStepSchema,
      outcome: z.literal(ABILITY_SAVE_OUTCOME.skipped),
    })
    .strict(),
  z
    .object({
      step: AbilitySaveStepSchema,
      outcome: z.literal(ABILITY_SAVE_OUTCOME.failed),
      error: z.string().min(1),
      reason: z.string().min(1).optional(),
    })
    .strict(),
])

export const AbilitySaveResponseSchema = z
  .object({
    locator: OwnedAbilityLocatorSchema,
    noteId: DurableNonEmptyScalarSchema,
    versionToken: z.string(),
    steps: z.array(AbilitySaveStepResultSchema).min(1).max(4),
  })
  .strict()

export type AbilityPackageId = z.infer<typeof AbilityPackageIdSchema>
export type SystemAbilityLocator = z.infer<typeof SystemAbilityLocatorSchema>
export type CatalogAbilityLocator = z.infer<typeof CatalogAbilityLocatorSchema>
export type OwnedAbilityLocation = z.infer<typeof OwnedAbilityLocationSchema>
export type OwnedAbilityLocator = z.infer<typeof OwnedAbilityLocatorSchema>
export type AbilityLocator = z.infer<typeof AbilityLocatorSchema>
export type AbilitySkillLocator = z.infer<typeof AbilitySkillLocatorSchema>
export type AuthoredAttachment = z.infer<typeof AuthoredAttachmentSchema>
export type AbilityAttachmentState = z.infer<typeof AbilityAttachmentStateSchema>
export type AbilityHealth = z.infer<typeof AbilityHealthSchema>
export type OwnedAbilityOrigin = z.infer<typeof OwnedAbilityOriginSchema>
export type AgentAbilityAvailabilityState = z.infer<typeof AgentAbilityAvailabilityStateSchema>
export type AgentAbilityAvailability = z.infer<typeof AgentAbilityAvailabilitySchema>
export type AgentAbilitySummary = z.infer<typeof AgentAbilitySummarySchema>
export type AgentAbilityDetailResponse = z.infer<typeof AgentAbilityDetailResponseSchema>
export type SetAgentAbilityEnabledRequest = z.infer<typeof SetAgentAbilityEnabledRequestSchema>
export type SetAgentAbilityEnabledResponse = z.infer<typeof SetAgentAbilityEnabledResponseSchema>
export type SetAgentAbilityAvailabilityRequest = z.infer<
  typeof SetAgentAbilityAvailabilityRequestSchema
>
export type SetAgentAbilityAvailabilityResponse = z.infer<
  typeof SetAgentAbilityAvailabilityResponseSchema
>
export type AbilityVersion = z.infer<typeof AbilityVersionSchema>
export type CreateAbilityVersionRequest = z.infer<typeof CreateAbilityVersionRequestSchema>
export type CreateAbilityVersionResponse = z.infer<typeof CreateAbilityVersionResponseSchema>
export type SetAbilityHomeRequest = z.infer<typeof SetAbilityHomeRequestSchema>
export type SetAbilityHomeResponse = z.infer<typeof SetAbilityHomeResponseSchema>
export type AbilitySaveRequest = z.infer<typeof AbilitySaveRequestSchema>
export type AbilitySaveStepResult = z.infer<typeof AbilitySaveStepResultSchema>
export type AbilitySaveResponse = z.infer<typeof AbilitySaveResponseSchema>
