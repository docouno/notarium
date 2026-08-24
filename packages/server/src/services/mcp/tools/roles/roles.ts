import type { EffectiveRoleSummary } from '@notarium/contract'
import type {
  UseRoleInput,
  UseRoleOutput,
  UseSkillInput,
  UseSkillOutput,
} from '@notarium/contract/tools'

import { can } from '../../../authz'
import type { AgentSessionRecord, ProjectRecord } from '../../../metaDb'
import {
  type AbilityLoadOutcome,
  type AbilityRemediation,
  type EffectiveRoleContext,
  type LoadedEffectiveRole,
  type LoadedEffectiveSkill,
} from '../../../roles'
import { type Ctx, type Handler, ToolFailure } from '../../gateway'
import { handleOf } from '../../helpers/projectAddressing'
import { renderRole, renderSkill } from '../../helpers/render'
import { sanitizeText } from '../../sanitize'
import { curateAgentContext, useRoleContextFrom } from '../session/agentContext'

const selectorOf = (
  input: { role?: string; skill?: string; name?: string },
  canonical: 'role' | 'skill',
  tool: string,
): string => {
  const count = Number(input[canonical] !== undefined) + Number(input.name !== undefined)

  if (count !== 1) {
    throw new ToolFailure(`provide exactly one of ${canonical} or name`)
  }
  const field = input[canonical] !== undefined ? canonical : 'name'
  console.info(`[mcp] ${tool} selector=${field}`)
  return input[canonical] ?? input.name!
}

export type McpAbilityContext = EffectiveRoleContext & { sessionProjectHandle?: string }

export const roleContext = async (
  ctx: Ctx,
  project?: ProjectRecord,
  session: Pick<AgentSessionRecord, 'projectId'> | undefined = ctx.session?.record,
): Promise<McpAbilityContext> => {
  let resolved = project
  let sessionProjectHandle: string | undefined

  if (!resolved && session?.projectId && ctx.projects) {
    const candidate = await ctx.projects.getById(session.projectId)

    if (candidate && can(ctx.principal, 'space:read', { space: candidate.space })) {
      resolved = candidate
      sessionProjectHandle = handleOf(
        candidate,
        ctx.spaces.slugOf(candidate.space) ?? candidate.space,
      )
    }
  }

  return {
    personalSpace: ctx.abilities
      ? await ctx.abilities.personalSpaceFor(ctx.principal)
      : await ctx.personalSpace(),
    ...(resolved ? { project: resolved } : {}),
    ...(sessionProjectHandle ? { sessionProjectHandle } : {}),
  }
}

export const sessionProjectHintText = (context: McpAbilityContext): string | undefined =>
  context.sessionProjectHandle
    ? `Resolved in project "${context.sessionProjectHandle}" from this session's sticky start_session hint.`
    : undefined

const safeSummary = <T extends { name: string; description: string }>(summary: T): T => ({
  ...summary,
  name: sanitizeText(summary.name),
  description: sanitizeText(summary.description),
  ...('title' in summary && typeof summary.title === 'string'
    ? { title: sanitizeText(summary.title) }
    : {}),
  ...('origin' in summary && typeof summary.origin === 'string'
    ? { origin: sanitizeText(summary.origin) }
    : {}),
  ...('originRevision' in summary && typeof summary.originRevision === 'string'
    ? { originRevision: sanitizeText(summary.originRevision) }
    : {}),
})

const remediationText = (remediation: AbilityRemediation): string => {
  switch (remediation.kind) {
    case 'edit-ability':
      return `call edit_ability with ref "${remediation.ref}" and update ${remediation.patch}`
    case 'open-agents-ui':
      return `open the Agents UI for ref "${remediation.ref}"`
    case 'retry-project':
      return `retry in ${remediation.projects.map((project) => `project "${project}"`).join(' or ')}`
    case 'contact-space-writer':
      return 'contact a writer of the owning Space'
    case 'call-other-kind':
      return `call ${remediation.actual === 'role' ? 'use_role' : 'use_skill'} instead`
    case 'list-abilities':
      return `call list_abilities with view "${remediation.view}"`
    case 'reactivate-role':
      return `call use_role for "${remediation.role}"${remediation.project ? ` in project "${remediation.project}"` : ''}`
  }
}

const attachmentFailureText = (
  health: Extract<AbilityLoadOutcome, { reason: 'unhealthy' }>['health'],
): string =>
  health.attachments
    .filter(({ health: state }) => state !== 'healthy')
    .map(({ attachment, health: state }, index) => {
      const label =
        attachment.kind === 'exact' && attachment.label ? `"${attachment.label}"` : `#${index + 1}`
      const repair =
        state === 'missing'
          ? 'restore it from trash or detach it'
          : state === 'disabled'
            ? 'enable it'
            : state === 'unavailable'
              ? 'expand its project availability or detach it'
              : state === 'wrong-kind'
                ? 'replace the binding with a skill'
                : 'repair the malformed binding'
      return `${label}: ${state} (${repair})`
    })
    .join('; ')

export const abilityFailureText = (
  kind: 'role' | 'skill',
  name: string,
  outcome: Extract<AbilityLoadOutcome, { ok: false }>,
  listing?: { names: string[]; truncated: boolean },
): string => {
  const recovery = outcome.remediation.map(remediationText).join('; ')

  switch (outcome.reason) {
    case 'unhealthy':
      return `${kind} "${name}" is unhealthy — ${attachmentFailureText(outcome.health)}; ${recovery}`
    case 'disabled':
      return `${kind} "${name}" is disabled (${outcome.source}, ${outcome.access}, ref "${outcome.ref}") — ${recovery}`
    case 'out-of-reach':
      return `${kind} "${name}" is out-of-reach${outcome.project ? ` in project "${outcome.project}"` : ''} (${outcome.source}, ${outcome.access}, ref "${outcome.ref}") — ${recovery}`
    case 'wrong-kind':
      return `"${name}" is a ${outcome.actual}, not a ${kind} — ${recovery}`
    case 'context-mismatch':
      return `saved role "${outcome.role}" belongs to a different project context${outcome.savedProject ? ` (saved: "${outcome.savedProject}"` : ' (saved: Personal'}${outcome.currentProject ? `, current: "${outcome.currentProject}")` : ', current: Personal)'} — ${recovery}`
    case 'gone':
      return `${kind} "${name}" was previously bound but its package is gone — ${recovery}`
    case 'not-found': {
      const visible = listing?.names.slice(0, 20) ?? []
      const tail = visible.length ? ` — available ${kind}s: ${visible.join(', ')}` : ''
      const bounded = listing?.truncated ? ' (bounded inventory)' : ''
      return `no such ${kind}: "${name}"${tail}${bounded} — ${recovery}`
    }
  }
}

export const activateRole = async (
  ctx: Ctx,
  context: EffectiveRoleContext,
  name: string,
  budgetTokens: number,
  preloaded?: LoadedEffectiveRole,
  knownListing?: { roles: EffectiveRoleSummary[]; truncated: boolean },
  precuratedContext?: UseRoleOutput['context'],
): Promise<UseRoleOutput> => {
  if (!ctx.roles) {
    throw new ToolFailure('roles are unavailable on this host')
  }
  const outcome: AbilityLoadOutcome<LoadedEffectiveRole> = preloaded
    ? { ok: true, loaded: preloaded }
    : await ctx.roles.loadEffective(context, ctx.principal, name, budgetTokens)

  if (!outcome.ok) {
    const listing = knownListing ?? (await ctx.roles.listEffective(context, ctx.principal))
    throw new ToolFailure(
      abilityFailureText('role', name, outcome, {
        names: listing.roles.map((role) => role.name),
        truncated: listing.truncated,
      }),
    )
  }
  const loaded = outcome.loaded
  const contextBundle =
    precuratedContext ?? useRoleContextFrom(await curateAgentContext(ctx, context.project, loaded))
  let status: UseRoleOutput['status'] = 'activated'

  // Resolve every fallible package/context dependency before changing durable episode
  // state. A failed activation must never reappear as active on the next resume.
  if (ctx.agentSessions && ctx.session) {
    // The address the resolver landed on, not one rebuilt from its placement: a System
    // role has no placement to rebuild from, and every rebuild was a second producer.
    const set = await ctx.agentSessions.setRole(ctx.session, {
      name: loaded.role.name,
      locator: loaded.locator,
      contextProjectId: context.project?.id ?? null,
    })
    status = set.changed ? 'activated' : 'already_active'
  }

  // The loaded role carries its body; the body travels as its OWN field. Spreading the
  // whole thing put `instructions` inside the summary too, which the wire shape simply
  // stripped until its arms became strict.
  const { instructions, ...summary } = loaded.role

  return {
    status,
    role: safeSummary(summary),
    instructions: sanitizeText(instructions),
    skills: loaded.skills.map((skill) => {
      const facts = {
        name: sanitizeText(skill.name),
        title: sanitizeText(skill.title),
        description: sanitizeText(skill.description),
      }

      return skill.state === 'loaded'
        ? {
            ...facts,
            state: skill.state,
            instructions: sanitizeText(skill.instructions),
          }
        : { ...facts, state: skill.state }
    }),
    context: contextBundle,
    ...(loaded.truncated ? { truncated: true } : {}),
  }
}

export const handleUseRole: Handler = async (ctx, rawArgs) => {
  const input = rawArgs as UseRoleInput
  const name = selectorOf(input, 'role', 'use_role')
  const project = input.project ? await ctx.resolveProject(input.project) : undefined
  const context = await roleContext(ctx, project)
  const structured = await activateRole(ctx, context, name, input.budgetTokens)
  const hint = sessionProjectHintText(context)
  return { markdown: [hint, renderRole(structured)].filter(Boolean).join('\n\n'), structured }
}

export const activateSkill = async (
  ctx: Ctx,
  context: EffectiveRoleContext,
  name: string,
  budgetTokens: number,
): Promise<UseSkillOutput> => {
  if (!ctx.roles) {
    throw new ToolFailure('abilities are unavailable on this host')
  }
  const loaded = await ctx.roles.loadEffectiveSkill(context, ctx.principal, name, budgetTokens)

  if (!loaded.ok) {
    throw new ToolFailure(abilityFailureText('skill', name, loaded))
  }
  const activated: LoadedEffectiveSkill = loaded.loaded
  const { instructions, ...summary } = activated.skill

  return {
    status: 'activated',
    skill: safeSummary(summary),
    instructions: sanitizeText(instructions),
  }
}

export const handleUseSkill: Handler = async (ctx, rawArgs) => {
  const input = rawArgs as UseSkillInput
  const name = selectorOf(input, 'skill', 'use_skill')
  const project = input.project ? await ctx.resolveProject(input.project) : undefined
  const context = await roleContext(ctx, project)
  const structured = await activateSkill(ctx, context, name, input.budgetTokens)
  const hint = sessionProjectHintText(context)

  return { markdown: [hint, renderSkill(structured)].filter(Boolean).join('\n\n'), structured }
}

export const startSessionRoleSelector = (input: { role?: string }): string | null =>
  input.role ?? null
