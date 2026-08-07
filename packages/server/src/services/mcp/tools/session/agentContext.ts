import { CONTEXT_KIND } from '@notarium/contract'
import type { UseRoleOutput } from '@notarium/contract/tools'
import { buildMemoryIndex } from '@notarium/core'

import type { ProjectRecord } from '../../../metaDb'
import { type LoadedEffectiveRole, weighRoleContext } from '../../../roles'
import {
  type CuratedPin,
  type CuratedSet,
  curatePersonalScope,
  curateProjectScope,
  loadedContextNotes,
  PERSONAL_TOKEN_BUDGET,
  personalProfilePin,
  PROJECT_TOKEN_BUDGET,
  weighAlwaysLoad,
} from '../../../spaces'
import { weighScopeContextSets, weighScopeOrder, weighScopePins } from '../../../storeAccess'
import type { Ctx } from '../../gateway'
import { sanitizeText } from '../../sanitize'

/** The eager always-load profile: loaded agent-memory summaries + always-load pins. */
export type ProfileBundle = {
  memory: Array<{ noteId: string; category: string; summary: string }>
  alwaysLoad: Array<{ noteId: string; title: string }>
}

export type CuratedAgentContext = {
  profile: ProfileBundle
  projectAlwaysLoad?: Array<{ noteId: string; title: string }>
  roleContext?: NonNullable<UseRoleOutput['context']>
  truncated: boolean
}

/** Assemble the agent's `profile` payload; the reserved profile note leads the
 * always-load, off-budget. */
const profileFrom = (
  pins: CuratedPin[],
  sets: CuratedSet[],
  memory: Array<{ noteId: string; category: string; summary: string; loaded: boolean }>,
  profilePin: { noteId: string; title: string } | null,
): ProfileBundle => {
  const always = loadedContextNotes(pins, sets).map((note) => ({
    ...note,
    title: sanitizeText(note.title),
  }))

  return {
    memory: memory
      .filter((item) => item.loaded)
      .map((item) => ({
        noteId: item.noteId,
        category: sanitizeText(item.category),
        summary: sanitizeText(item.summary),
      })),
    alwaysLoad: profilePin
      ? [{ noteId: profilePin.noteId, title: sanitizeText(profilePin.title) }, ...always]
      : always,
  }
}

/** Curate the complete eager slice under one P/Q envelope. The same result feeds
 * `start_session` and the authoritative base replacement returned by late `use_role`. */
export const curateAgentContext = async (
  ctx: Ctx,
  hinted?: ProjectRecord,
  activeRole?: LoadedEffectiveRole | null,
): Promise<CuratedAgentContext> => {
  const personal = await ctx.personalSpace()
  const personalStore = personal ? await ctx.spaces.store(personal) : null
  const personalMemory = personalStore ? await buildMemoryIndex(personalStore) : []
  const profilePin = personalStore ? await personalProfilePin(personalStore) : null
  const dependencies = {
    store: ctx.store,
    spaces: ctx.spaces,
    contextSets: ctx.contextSets,
    scopePins: ctx.scopePins,
    contextOrder: ctx.contextOrder,
  }
  const personalPins = [
    ...(personalStore ? await weighAlwaysLoad(personalStore) : []),
    ...(personal
      ? await weighScopePins(dependencies, ctx.principal, {
          kind: CONTEXT_KIND.personal,
          id: personal,
        })
      : []),
  ]
  const personalSets = personal
    ? await weighScopeContextSets(dependencies, ctx.principal, {
        kind: CONTEXT_KIND.personal,
        id: personal,
      })
    : []
  const personalOrder = personal
    ? await weighScopeOrder(dependencies, { kind: CONTEXT_KIND.personal, id: personal })
    : []
  const setsTrimmed = (sets: CuratedSet[]) =>
    sets.some((set) => set.items.some((item) => !item.loaded))
  const roleScope = activeRole
    ? await weighRoleContext(dependencies, ctx.principal, activeRole)
    : undefined
  const roleContextFrom = (
    role: NonNullable<ReturnType<typeof curatePersonalScope>['role']>,
  ): NonNullable<UseRoleOutput['context']> => ({
    alwaysLoad: loadedContextNotes(role.pins, role.sets).map((note) => ({
      ...note,
      title: sanitizeText(note.title),
    })),
    ...(role.pins.some((pin) => !pin.loaded) || setsTrimmed(role.sets) ? { truncated: true } : {}),
  })

  if (!hinted) {
    const curated = curatePersonalScope(
      personalPins,
      personalSets,
      personalMemory,
      PERSONAL_TOKEN_BUDGET,
      personalOrder,
      roleScope,
    )

    return {
      profile: profileFrom(curated.pins, curated.sets, curated.memory, profilePin),
      ...(curated.role ? { roleContext: roleContextFrom(curated.role) } : {}),
      truncated:
        Boolean(curated.role?.pins.some((pin) => !pin.loaded)) ||
        Boolean(curated.role && setsTrimmed(curated.role.sets)) ||
        curated.pins.some((pin) => !pin.loaded) ||
        setsTrimmed(curated.sets) ||
        curated.memory.some((item) => !item.muted && !item.loaded),
    }
  }

  const projectStore = await ctx.spaces.store(hinted.space)
  const projectPins = [
    ...(await weighAlwaysLoad(projectStore, { pathPrefix: hinted.path })),
    ...(await weighScopePins(dependencies, ctx.principal, {
      kind: CONTEXT_KIND.project,
      id: hinted.id,
    })),
  ]
  const projectSets = await weighScopeContextSets(dependencies, ctx.principal, {
    kind: CONTEXT_KIND.project,
    id: hinted.id,
  })
  const projectOrder = await weighScopeOrder(dependencies, {
    kind: CONTEXT_KIND.project,
    id: hinted.id,
  })
  const curated = curateProjectScope(
    projectPins,
    projectSets,
    personalPins,
    personalSets,
    personalMemory,
    PROJECT_TOKEN_BUDGET,
    projectOrder,
    personalOrder,
    roleScope,
  )

  return {
    profile: profileFrom(
      curated.personal.pins,
      curated.personal.sets,
      curated.personal.memory,
      profilePin,
    ),
    projectAlwaysLoad: loadedContextNotes(curated.pins, curated.sets).map((note) => ({
      ...note,
      title: sanitizeText(note.title),
    })),
    ...(curated.role ? { roleContext: roleContextFrom(curated.role) } : {}),
    truncated:
      Boolean(curated.role?.pins.some((pin) => !pin.loaded)) ||
      Boolean(curated.role && setsTrimmed(curated.role.sets)) ||
      curated.pins.some((pin) => !pin.loaded) ||
      setsTrimmed(curated.sets) ||
      curated.personal.pins.some((pin) => !pin.loaded) ||
      setsTrimmed(curated.personal.sets) ||
      curated.personal.memory.some((item) => !item.muted && !item.loaded),
  }
}

/** Late activation replaces the base slice previously advertised by `start_session`.
 * Omissions are deliberate evictions caused by the role-first shared-budget scan. */
export const useRoleContextFrom = (
  curated: CuratedAgentContext,
): NonNullable<UseRoleOutput['context']> => ({
  ...(curated.roleContext ?? { alwaysLoad: [] }),
  replacement: {
    profile: curated.profile,
    ...(curated.projectAlwaysLoad ? { project: { alwaysLoad: curated.projectAlwaysLoad } } : {}),
  },
  ...(curated.truncated ? { truncated: true } : {}),
})
