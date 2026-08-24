import {
  ABILITY_AVAILABILITY_MODE,
  ABILITY_CONTINUATION_REASON,
  ABILITY_CONTINUATION_REQUIREMENT,
  ABILITY_CREATE_OUTCOME,
  ABILITY_KIND,
  ABILITY_LIST_VIEW,
  ABILITY_SOURCE,
  type AbilitySkillLocator,
  ROLE_SCOPE,
} from '@notarium/contract'
import type {
  AbilityAuthoredAttachmentInput,
  AbilityDetails,
  CreateAbilityInput,
  CreateAbilityOutput,
  DeleteAbilityInput,
  DeleteAbilityOutput,
  EditAbilityInput,
  EditAbilityOutput,
  GetAbilityInput,
  GetAbilityOutput,
  ListAbilitiesInput,
  ListAbilitiesOutput,
  NextAbilityAction,
} from '@notarium/contract/tools'
import {
  type AgentWriteAttribution,
  decodeAbilityLocator,
  encodeAbilityLocator,
  sha256Hex,
} from '@notarium/core'

import {
  AbilityDiscoveryCursorError,
  type AgentAbilityPage,
  type DeferredAbilityAttachments,
} from '../../../abilities'
import { ownedRoleLocator, ownedSkillLocator } from '../../../roles'
import { type Handler, ToolFailure } from '../../gateway'
import { dedupedWrite } from '../../helpers/dedup'
import { writeAttributionOf } from '../../helpers/writeAttribution'
import { sanitizeText } from '../../sanitize'
import { roleContext, sessionProjectHintText } from '../roles'

const abilityService = (ctx: Parameters<Handler>[0]) => {
  if (!ctx.abilities) {
    throw new ToolFailure('ability authoring is unavailable on this host')
  }

  return ctx.abilities
}

const locatorOf = (ref: string) => {
  const locator = decodeAbilityLocator(ref)

  if (!locator) {
    throw new ToolFailure('no such ability')
  }

  return locator
}

const authoredInstructions = (title: string, body: string): string =>
  /^(?:[ \t]*\r?\n)*[ \t]*#(?!#)[ \t]+\S/.test(body) ? body : `# ${title}\n\n${body}`

const detailsOf = (
  detail: NonNullable<Awaited<ReturnType<ReturnType<typeof abilityService>['get']>>>,
): AbilityDetails => {
  const ability = detail.ability

  if (ability.source === ABILITY_SOURCE.catalog) {
    throw new ToolFailure('no such ability')
  }
  const facts = {
    ref: encodeAbilityLocator(ability.locator),
    source: ability.source,
    kind: ability.locator.kind,
    name: sanitizeText(ability.name),
    title: sanitizeText(ability.title),
    description: sanitizeText(ability.description),
    instructions: sanitizeText(authoredInstructions(ability.title, ability.instructions)),
    enabled: ability.enabled,
  }
  const health = detail.health
    ? {
        healthy: detail.health.healthy,
        attachments: detail.health.attachments.map(({ attachment, health: state }) => ({
          attachment:
            attachment.kind === 'exact'
              ? {
                  kind: 'exact' as const,
                  ref: encodeAbilityLocator(attachment.locator),
                  label: sanitizeText(attachment.label),
                }
              : { ...attachment, raw: sanitizeText(attachment.raw) },
          health: state,
        })),
      }
    : { healthy: true, attachments: [] }

  if (ability.source === ABILITY_SOURCE.system) {
    return ability.locator.kind === ABILITY_KIND.role
      ? {
          ...facts,
          source: ABILITY_SOURCE.system,
          kind: ABILITY_KIND.role,
          health,
        }
      : { ...facts, source: ABILITY_SOURCE.system, kind: ABILITY_KIND.skill }
  }
  if (ability.source !== ABILITY_SOURCE.owned || !detail.versionToken) {
    throw new ToolFailure('no such ability')
  }
  const owned = {
    ...facts,
    source: ABILITY_SOURCE.owned,
    versionToken: detail.versionToken,
    ...(ability.availability ? { availability: ability.availability } : {}),
  }

  return ability.locator.kind === ABILITY_KIND.role
    ? {
        ...owned,
        kind: ABILITY_KIND.role,
        scope: ability.locator.location.scope,
        health,
      }
    : {
        ...owned,
        kind: ABILITY_KIND.skill,
        scope: ability.locator.location.scope,
      }
}

type DeferredAttachment = {
  ref: string
  locator: AbilitySkillLocator
  label?: string
}

const deferredAttachments = (
  attachments: readonly AbilityAuthoredAttachmentInput[] | undefined,
): DeferredAttachment[] | undefined => {
  if (attachments === undefined) {
    return undefined
  }

  return attachments.map(({ ref, label }) => {
    const locator = locatorOf(ref)

    if (locator.kind !== ABILITY_KIND.skill || locator.source === ABILITY_SOURCE.catalog) {
      throw new ToolFailure(`attachment ref does not address a readable skill: ${ref}`)
    }

    return { ref, locator: locator as AbilitySkillLocator, ...(label ? { label } : {}) }
  })
}

const authoredAttachments = async (
  ctx: Parameters<Handler>[0],
  attachments: readonly DeferredAttachment[],
) => {
  const abilities = abilityService(ctx)

  return Promise.all(
    attachments.map(async ({ ref, locator, label }) => {
      const detail = await abilities.get('authoring', ctx.principal, locator)

      if (!detail || detail.ability.locator.kind !== ABILITY_KIND.skill) {
        throw new ToolFailure(`attachment ref does not address a readable skill: ${ref}`)
      }

      return {
        kind: 'exact' as const,
        locator,
        label: label ?? detail.ability.name,
      }
    }),
  )
}

const actionArguments = (
  input: ListAbilitiesInput,
  overrides: Partial<ListAbilitiesInput>,
): ListAbilitiesInput => ({
  ...(input.session ? { session: input.session } : {}),
  view: input.view,
  ...(input.kind ? { kind: input.kind } : {}),
  ...(input.source ? { source: input.source } : {}),
  ...(input.project ? { project: input.project } : {}),
  ...(input.q ? { q: input.q } : {}),
  limit: input.limit,
  ...overrides,
})

export const abilityNextAction = (
  arguments_: ListAbilitiesInput,
  reason: NextAbilityAction['reason'],
): NextAbilityAction => ({
  tool: 'list_abilities',
  arguments: arguments_,
  reason,
  requiredBefore: ABILITY_CONTINUATION_REQUIREMENT.activationOrAnswer,
})

const nextActionFor = (
  input: ListAbilitiesInput,
  page: AgentAbilityPage,
): NextAbilityAction | undefined => {
  if (page.nextCursor) {
    return abilityNextAction(
      actionArguments(input, { cursor: page.nextCursor }),
      ABILITY_CONTINUATION_REASON.nextPage,
    )
  }
  if (page.total === 0 && input.q) {
    const broadened = actionArguments(input, { q: undefined, cursor: undefined })

    delete broadened.q
    delete broadened.cursor
    return abilityNextAction(broadened, ABILITY_CONTINUATION_REASON.zeroResults)
  }

  return undefined
}

export const handleListAbilities: Handler = async (ctx, rawArgs) => {
  const input = rawArgs as ListAbilitiesInput
  const project = input.project ? await ctx.resolveProject(input.project) : undefined
  const context = await roleContext(ctx, project)
  let page: AgentAbilityPage

  try {
    page = ctx.abilities
      ? await ctx.abilities.list(input.view, context, ctx.principal, input)
      : { abilities: [], total: 0, truncated: false }
  } catch (error) {
    if (error instanceof AbilityDiscoveryCursorError) {
      throw new ToolFailure('cursor does not match this ability view, filter, or project context')
    }
    throw error
  }
  const abilities = page.abilities.map((ability) => ({
    ...ability,
    name: sanitizeText(ability.name),
    title: sanitizeText(ability.title),
    description: sanitizeText(ability.description),
  }))
  const nextAction = nextActionFor(input, page)
  const structured: ListAbilitiesOutput = {
    abilities,
    total: page.total,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(page.truncated ? { truncated: true } : {}),
  }
  const lines = abilities.length
    ? [
        `**${input.view === ABILITY_LIST_VIEW.runtime ? 'Runtime' : 'Authoring'} abilities (${abilities.length} of ${page.total}):**`,
        ...abilities.map(
          (ability) =>
            `- \`${ability.name}\` (${ability.kind}, ${ability.source === 'system' ? 'system' : ability.scope}) — ${ability.description}`,
        ),
      ]
    : ['No abilities matched this request.']

  if (nextAction) {
    lines.push('', `Required next action: \`${JSON.stringify(nextAction)}\``)
  }
  if (page.truncated) {
    lines.push('', 'Warning: the underlying ability inventory exceeded host bounds.')
  }
  const hint = sessionProjectHintText(context)

  if (hint) {
    lines.unshift(hint, '')
  }

  return { markdown: lines.join('\n'), structured }
}

export const handleGetAbility: Handler = async (ctx, rawArgs) => {
  const input = rawArgs as GetAbilityInput
  const locator = locatorOf(input.ref)
  const detail = await abilityService(ctx).get('authoring', ctx.principal, locator)

  if (!detail) {
    throw new ToolFailure('no such ability')
  }
  const structured: GetAbilityOutput = { ability: detailsOf(detail) }

  return {
    markdown: `Read ${structured.ability.kind} \`${sanitizeText(structured.ability.name)}\` (${structured.ability.source}).`,
    structured,
  }
}

const assertCreateFields = (input: CreateAbilityInput): void => {
  if (input.kind === ABILITY_KIND.skill && input.placement.home === ROLE_SCOPE.project) {
    throw new ToolFailure('a skill cannot use project placement')
  }
  if (input.kind === ABILITY_KIND.skill && input.attachments !== undefined) {
    throw new ToolFailure('a skill cannot have attachments')
  }
  if (input.availability && input.placement.home !== ROLE_SCOPE.space) {
    throw new ToolFailure('availability is only valid for a Space placement')
  }
}

export const handleCreateAbility: Handler = async (ctx, rawArgs) => {
  const input = rawArgs as CreateAbilityInput

  assertCreateFields(input)
  const attachments = deferredAttachments(input.attachments)
  const placement = input.placement
  const body = {
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    ...(placement.home === ROLE_SCOPE.personal
      ? { scope: ROLE_SCOPE.personal }
      : placement.home === ROLE_SCOPE.space
        ? {
            scope: ROLE_SCOPE.space,
            space: placement.space,
            ...(input.kind === ABILITY_KIND.skill
              ? {
                  availability: input.availability ?? {
                    mode: ABILITY_AVAILABILITY_MODE.allProjects,
                  },
                }
              : input.availability
                ? { availability: input.availability }
                : {}),
          }
        : { scope: ROLE_SCOPE.project, project: placement.project }),
  }
  const abilities = abilityService(ctx)
  const prepared = await abilities.prepareCreate(ctx.principal, {
    kind: input.kind,
    source: 'custom',
    body,
  } as never)
  const scopeKey = JSON.stringify({
    location: prepared.location,
    kind: input.kind,
    name: input.name.normalize('NFKC').toLowerCase(),
  })
  const legacyRequestFingerprint = JSON.stringify({
    kind: input.kind,
    body: {
      ...body,
      ...(attachments
        ? {
            attachments: attachments.map(({ locator, label }) => ({
              locator,
              ...(label ? { label } : {}),
            })),
          }
        : {}),
    },
    location: prepared.location,
    availability: prepared.availability ?? null,
  })
  const requestFingerprint = JSON.stringify({
    request: JSON.parse(legacyRequestFingerprint) as unknown,
    systemNamePolicy: 'reject',
  })
  const gatewayScopeKey = `${scopeKey}:${await sha256Hex(requestFingerprint)}`
  const dedup = await dedupedWrite(
    ctx,
    {
      toolName: 'create_ability',
      idempotencyKey: input.idempotencyKey,
      // The generic gateway cache predates request fingerprints. Partitioning its
      // private scope by the canonical fingerprint lets a changed payload reach the
      // durable creator, which owns the explicit idempotency-conflict verdict.
      scopeKey: gatewayScopeKey,
    },
    async () => {
      const published = await abilities.create(
        prepared,
        writeAttributionOf(ctx),
        {
          idempotencyKey: input.idempotencyKey,
          scopeKey,
          systemNamePolicy: 'reject',
          requestFingerprint,
          legacyRequestFingerprint,
        },
        attachments
          ? async (candidate) => {
              if (candidate.kind !== ABILITY_KIND.role) {
                throw new Error('deferred attachments require a Role create')
              }

              return {
                ...candidate,
                body: {
                  ...candidate.body,
                  attachments: await authoredAttachments(ctx, attachments),
                },
              }
            }
          : undefined,
      )

      return {
        noteId: published.ability.packageId,
        versionToken: published.versionToken,
        ...(published.replayed ? { replayed: true } : {}),
      }
    },
  )
  const replayed = dedup.wasHit || (dedup.result as { replayed?: true }).replayed === true
  const locator =
    input.kind === ABILITY_KIND.role
      ? ownedRoleLocator(prepared.location, dedup.result.noteId)
      : ownedSkillLocator(
          prepared.location as Parameters<typeof ownedSkillLocator>[0],
          dedup.result.noteId,
        )
  const structured: CreateAbilityOutput = {
    ref: encodeAbilityLocator(locator),
    versionToken: dedup.result.versionToken,
    name: input.name,
    outcome: replayed ? ABILITY_CREATE_OUTCOME.skipped : ABILITY_CREATE_OUTCOME.created,
  }

  return {
    markdown: `${replayed ? 'Reused' : 'Created'} ${input.kind} \`${sanitizeText(input.name)}\` at ref \`${structured.ref}\`.`,
    structured,
  }
}

export const handleEditAbility: Handler = async (ctx, rawArgs) => {
  const input = rawArgs as EditAbilityInput
  const locator = locatorOf(input.ref)
  const authored =
    input.description !== undefined ||
    input.instructions !== undefined ||
    input.attachments !== undefined

  if (
    !authored &&
    input.availability === undefined &&
    input.enabled === undefined &&
    input.home === undefined
  ) {
    throw new ToolFailure('at least one patch field is required')
  }
  if (authored && !input.versionToken) {
    throw new ToolFailure('versionToken is required for authored fields')
  }

  if (locator.source !== ABILITY_SOURCE.owned) {
    throw new ToolFailure('only an Owned ability can be edited')
  }
  const deferred = deferredAttachments(input.attachments)
  const attachments: DeferredAbilityAttachments | undefined = deferred
    ? {
        kind: 'deferred',
        attachments: deferred.map(({ locator: attachment, label }) => ({
          locator: attachment,
          ...(label ? { label } : {}),
        })),
        resolve: () => authoredAttachments(ctx, deferred),
      }
    : undefined
  const result = await abilityService(ctx).edit(ctx.principal, locator, {
    ...(input.versionToken ? { versionToken: input.versionToken } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(input.availability ? { availability: input.availability } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.home ? { home: input.home } : {}),
  })
  const structured: EditAbilityOutput = {
    ref: encodeAbilityLocator(result.locator),
    ...(result.versionToken ? { versionToken: result.versionToken } : {}),
    steps: result.steps.map((step) =>
      step.outcome === 'failed'
        ? { step: step.step, outcome: step.outcome, error: sanitizeText(step.error) }
        : { step: step.step, outcome: step.outcome },
    ),
  }

  return {
    markdown: `Ability edit completed ${structured.steps.filter(({ outcome }) => outcome !== 'failed').length} of ${structured.steps.length} step(s).`,
    structured,
  }
}

export const handleDeleteAbility: Handler = async (ctx, rawArgs) => {
  const input = rawArgs as DeleteAbilityInput
  const locator = locatorOf(input.ref)

  if (locator.source !== ABILITY_SOURCE.owned) {
    throw new ToolFailure('only an Owned ability can be deleted')
  }
  const attribution = writeAttributionOf(ctx)
  const removed = await abilityService(ctx).remove(ctx.principal, locator, {
    principal: attribution.principal!,
    ...(attribution.agent ? { agent: attribution.agent as AgentWriteAttribution } : {}),
  })
  const structured: DeleteAbilityOutput = {
    ref: encodeAbilityLocator(removed.locator),
    name: removed.name,
  }

  return {
    markdown: `Moved ability \`${sanitizeText(removed.name)}\` to Trash.`,
    structured,
  }
}
