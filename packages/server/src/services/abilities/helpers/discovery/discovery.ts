import { createHash } from 'node:crypto'

import { ABILITY_KIND, ABILITY_LIST_VIEW, ROLE_SCOPE } from '@notarium/contract'
import type { AbilitySummary, RuntimeAbilitySummary } from '@notarium/contract/tools'
import { encodeAbilityLocator } from '@notarium/core'

import type { Principal } from '../../../authz'
import { projectSummaryOf } from '../../../mcp/helpers/projectAddressing'
import type { AbilityResolutionCandidate, EffectiveRoleContext } from '../../../roles'
import { AbilityDiscoveryCursorError } from '../../errors'
import type {
  AbilityBundle,
  AbilityDiscoveryDeps,
  AgentAbilityListQuery,
  AgentAbilityPage,
} from '../../types'
import type { AbilityPlacement } from '../placement'

const normalize = (value: string): string => value.normalize('NFKC').toLowerCase()

const continuationToken = (fingerprint: string, key: readonly string[]): string =>
  createHash('sha256')
    .update('ability-cursor-v1\0')
    .update(fingerprint)
    .update('\0')
    .update(JSON.stringify(key))
    .digest('base64url')
    .slice(0, 16)

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const compareKey = (left: readonly string[], right: readonly string[]): number => {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const compared = compareText(left[index] ?? '', right[index] ?? '')

    if (compared !== 0) {
      return compared
    }
  }

  return 0
}

const bundleResolutionSummary = (ability: AbilityResolutionCandidate): RuntimeAbilitySummary => {
  const summary = {
    name: ability.name,
    title: ability.title,
    description: ability.description,
  }

  if (ability.source === 'system') {
    return { ...summary, source: 'system', kind: ability.kind }
  }

  return ability.kind === 'skill'
    ? { ...summary, source: 'owned', kind: 'skill', scope: ability.location.scope }
    : { ...summary, source: 'owned', kind: 'role', scope: ability.location.scope }
}

export const createAbilityDiscovery = (
  { roles, spaces, projects }: AbilityDiscoveryDeps,
  placement: AbilityPlacement,
) => {
  const versionsFor = async (
    context: EffectiveRoleContext,
    principal: Principal,
    candidate: Extract<AbilityResolutionCandidate, { source: 'owned'; kind: 'role' }>,
  ): Promise<Array<{ project: string; ref: string }> | undefined> => {
    if (!projects) {
      return undefined
    }
    const projectRows = await placement.contextProjectsFor([candidate.location.space])
    const projectById = new Map(projectRows.map((project) => [project.id, project] as const))
    const base =
      candidate.location.scope === ROLE_SCOPE.project
        ? await roles.findRoleBase(
            principal,
            candidate.locator as Extract<
              AbilityResolutionCandidate,
              { source: 'owned'; kind: 'role' }
            >['locator'],
            context.personalSpace,
          )
        : (candidate.locator as Extract<
            AbilityResolutionCandidate,
            { source: 'owned'; kind: 'role' }
          >['locator'])

    if (!base) {
      return undefined
    }
    const versions = await roles.listRoleVersions(
      principal,
      base,
      context.personalSpace,
      projectRows.map(({ id }) => id),
    )

    return versions.flatMap(({ projectId, locator }) => {
      const project = projectById.get(projectId)

      return project
        ? [
            {
              project: projectSummaryOf(project, spaces.slugOf(project.space) ?? project.space)
                .handle,
              ref: encodeAbilityLocator(locator),
            },
          ]
        : []
    })
  }

  const summaries = async (
    context: EffectiveRoleContext,
    principal: Principal,
  ): Promise<{ abilities: AbilitySummary[]; truncated: boolean }> => {
    const resolution = await roles.listAbilityResolution(context, principal)
    const abilities = await Promise.all(
      resolution.candidates.map(async (candidate): Promise<AbilitySummary> => {
        const facts = {
          ref: encodeAbilityLocator(candidate.locator),
          name: candidate.name,
          title: candidate.title,
          description: candidate.description,
          source: candidate.source,
          kind: candidate.kind,
        }
        const unhealthy =
          candidate.kind === ABILITY_KIND.role && candidate.health?.healthy === false

        if (candidate.source === 'system') {
          return candidate.kind === ABILITY_KIND.role
            ? {
                ...facts,
                source: 'system',
                kind: 'role',
                effective: candidate.effective,
                ...(unhealthy ? { healthy: false } : {}),
              }
            : { ...facts, source: 'system', kind: 'skill', effective: candidate.effective }
        }
        if (candidate.kind === ABILITY_KIND.skill) {
          return {
            ...facts,
            source: 'owned',
            kind: 'skill',
            scope: candidate.location.scope,
            enabled: candidate.enabled,
            effective: candidate.effective,
          }
        }
        const versions = await versionsFor(context, principal, candidate)

        return {
          ...facts,
          source: 'owned',
          kind: 'role',
          scope: candidate.location.scope,
          enabled: candidate.enabled,
          effective: candidate.effective,
          ...(unhealthy ? { healthy: false } : {}),
          ...(versions?.length ? { versions } : {}),
        }
      }),
    )

    return { abilities, truncated: resolution.truncated }
  }

  const list = async (
    view: 'runtime' | 'authoring',
    context: EffectiveRoleContext,
    principal: Principal,
    query: AgentAbilityListQuery,
  ): Promise<AgentAbilityPage> => {
    const resolution = await summaries(context, principal)
    const needle = query.q ? normalize(query.q) : undefined
    const filtered = resolution.abilities
      .filter((ability) => view === ABILITY_LIST_VIEW.authoring || ability.effective === true)
      .filter((ability) => !query.kind || ability.kind === query.kind)
      .filter((ability) => !query.source || ability.source === query.source)
      .filter(
        (ability) =>
          !needle ||
          normalize(ability.name).includes(needle) ||
          normalize(ability.description).includes(needle),
      )
    const keyOf = (ability: AbilitySummary): string[] =>
      view === ABILITY_LIST_VIEW.runtime
        ? [ability.kind, normalize(ability.name)]
        : [ability.kind, normalize(ability.name), ability.ref]
    const sorted = filtered.sort((left, right) => compareKey(keyOf(left), keyOf(right)))
    const fingerprint = JSON.stringify({
      principal: principal.id,
      view,
      kind: query.kind ?? null,
      source: query.source ?? null,
      q: needle ?? null,
      // Bind to the resolved identity, not to the optional spelling on this call.
      // A continuation may inherit the project from its episode, and two aliases may
      // spell the same project; only the stable id captures both cases correctly.
      project: context.project?.id ?? null,
    })
    let start = 0

    if (query.cursor) {
      const matches = sorted.flatMap((ability, index) =>
        continuationToken(fingerprint, keyOf(ability)) === query.cursor ? [index] : [],
      )

      if (matches.length !== 1) {
        throw new AbilityDiscoveryCursorError('bad cursor')
      }
      start = matches[0]! + 1
    }
    const page = sorted.slice(start, start + query.limit)
    const hasMore = start + page.length < sorted.length
    const last = hasMore ? page.at(-1) : undefined

    return {
      abilities: page.map((ability) => {
        if (view === ABILITY_LIST_VIEW.runtime && ability.source === 'system') {
          const runtime = { ...ability }

          delete runtime.effective
          return runtime
        }

        return ability
      }),
      total: sorted.length,
      ...(last ? { nextCursor: continuationToken(fingerprint, keyOf(last)) } : {}),
      truncated: resolution.truncated,
    }
  }

  const bundle = async (
    context: EffectiveRoleContext,
    principal: Principal,
  ): Promise<AbilityBundle> => {
    const resolution = await roles.listAbilityResolution(context, principal)
    const abilities = resolution.candidates
      .filter(
        (ability) =>
          ability.effective === true &&
          !(ability.kind === ABILITY_KIND.role && ability.health?.healthy === false),
      )
      .sort(
        (left, right) => compareText(left.kind, right.kind) || compareText(left.name, right.name),
      )
      .map(bundleResolutionSummary)

    return { abilities, truncated: resolution.truncated }
  }

  return { list, bundle }
}
