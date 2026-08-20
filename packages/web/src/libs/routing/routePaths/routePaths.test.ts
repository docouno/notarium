import { describe, expect, it } from 'vitest'
import { NOTE_CLASS } from '@notarium/contract/enums'
import {
  agentAbilityDraftRoute,
  agentAbilityRoute,
  agentContextRoute,
  agentRolesRoute,
  agentSkillsRoute,
  agentsRoute,
  agentsSurfaceOf,
  dashboardRoute,
  folderPageHref,
  folderPageRoute,
  folderRoute,
  memoryNoteRoute,
  noteRouteForClass,
  parseAppPath,
  spaceRoute,
  workspaceSettingsRoute,
} from './routePaths'

describe('agent package routes', () => {
  it('opens Agents on the role-first package library', () => {
    expect(agentsRoute()).toBe('/agents/abilities/roles')
    expect(agentRolesRoute()).toBe('/agents/abilities/roles')
    expect(agentSkillsRoute()).toBe('/agents/abilities/skills')
    expect(agentAbilityDraftRoute('role', 'draft-1')).toBe('/agents/abilities/roles/new/draft-1')
    expect(agentAbilityDraftRoute('skill', 'draft/2')).toBe(
      '/agents/abilities/skills/new/draft%2F2',
    )
    expect(agentContextRoute()).toBe('/agents/context')
    expect(agentContextRoute('project-a')).toBe('/agents/context/project-a')
    expect(parseAppPath('/agents')).toEqual({ kind: 'agents', tab: 'abilities' })
  })

  it('keeps generic skill notes on /n and gives Owned abilities an exact route', () => {
    expect(noteRouteForClass('AbCdefGhij_1', NOTE_CLASS.skill, 'research-evidence')).toBe(
      '/n/AbCdefGhij_1/research-evidence',
    )
    const route = agentAbilityRoute({
      source: 'owned',
      kind: 'skill',
      packageId: 'AbCdefGhij_1',
      location: { scope: 'space', spaceId: 'space_1' },
    })
    expect(route).toMatch(/^\/agents\/abilities\/skills\/owned\//)
    expect(parseAppPath('/skill/AbCdefGhij_1/research-evidence')).toEqual({ kind: 'root' })
  })

  it('keeps an agent-memory note tied to its originating Context scope', () => {
    expect(memoryNoteRoute('memory-1', 'release facts', 'team/docs')).toBe(
      '/m/memory-1/release%20facts?context=team%2Fdocs',
    )
  })
})

describe('workspaceSettingsRoute', () => {
  it('addresses one exact durable job when requested', () => {
    expect(workspaceSettingsRoute('my space', 'import', { job: 'job/a' })).toBe(
      '/s/my%20space/management/import?job=job%2Fa',
    )
    expect(workspaceSettingsRoute('main', 'import')).toBe('/s/main/management/import')
  })
})

// The dashboard surfaces (#216) ride the existing space-scoped URL grammar: the
// default (Activity) IS the space home, only projects/health carry a
// `/dashboard/<view>` tail. These pin the parse ↔ build round-trip and the
// canonicalisation of the default surface back to the bare home.

describe('parseAppPath — dashboard surfaces (#216)', () => {
  it('classifies the deep surfaces', () => {
    expect(parseAppPath('/s/work/dashboard/projects')).toEqual({
      kind: 'dashboard',
      space: 'work',
      view: 'projects',
    })
    expect(parseAppPath('/s/work/dashboard/health')).toEqual({
      kind: 'dashboard',
      space: 'work',
      view: 'health',
    })
  })

  it('collapses the default surface (bare / activity / unknown) to the home scope', () => {
    // The Activity surface IS the space home — never a distinct dashboard kind.
    expect(parseAppPath('/s/work')).toEqual({ kind: 'all', space: 'work' })
    expect(parseAppPath('/s/work/dashboard')).toEqual({ kind: 'all', space: 'work' })
    expect(parseAppPath('/s/work/dashboard/activity')).toEqual({ kind: 'all', space: 'work' })
    expect(parseAppPath('/s/work/dashboard/bogus')).toEqual({ kind: 'all', space: 'work' })
  })

  it('percent-decodes the space slug', () => {
    expect(parseAppPath('/s/my%20space/dashboard/health')).toEqual({
      kind: 'dashboard',
      space: 'my space',
      view: 'health',
    })
  })
})

describe('dashboardRoute — builder (#216)', () => {
  it('the default surface points at the bare space home', () => {
    expect(dashboardRoute('work')).toBe(spaceRoute('work'))
    expect(dashboardRoute('work', 'activity')).toBe('/s/work')
  })

  it('deep surfaces get a /dashboard/<view> tail', () => {
    expect(dashboardRoute('work', 'projects')).toBe('/s/work/dashboard/projects')
    expect(dashboardRoute('work', 'health')).toBe('/s/work/dashboard/health')
  })

  it('round-trips build → parse for a deep surface', () => {
    expect(parseAppPath(dashboardRoute('work', 'projects'))).toEqual({
      kind: 'dashboard',
      space: 'work',
      view: 'projects',
    })
  })
})

// The one rule every folder→page link shares (#214 breadcrumbs + tree go-to-page,
// #213 children summary): an IDENTIFIED folder links by its durable /folder/<id>,
// a plain one by its /files/<path>. No identity is minted here — it only picks the
// address from what the folder already carries.
describe('folderPageHref — folder→page link (#214)', () => {
  it('an identified folder links by its durable /folder/<id>', () => {
    expect(folderPageHref('work', { id: 'F1abc', path: 'Frontend/components' })).toBe(
      folderPageRoute('F1abc'),
    )
  })

  it('a plain never-identified folder links by its /files/<path>', () => {
    expect(folderPageHref('work', { path: 'Frontend/components' })).toBe(
      folderRoute('work', 'Frontend/components'),
    )
  })

  it('prefers the id even when a path is present (durable wins)', () => {
    expect(folderPageHref('work', { id: 'F2', path: 'A/B' })).toBe('/folder/F2')
  })
})

// One classifier for `/agents/…`, because three private ones disagreed: a
// `startsWith`, an `includes` and a regexp answered "which section / which library /
// is this the index" differently for the same URL.
describe('agentsSurfaceOf — what an Agents URL is', () => {
  it('is null outside the Agents surfaces', () => {
    expect(agentsSurfaceOf('/s/work/feed')).toBeNull()
    expect(agentsSurfaceOf('/n/abc/title')).toBeNull()
  })

  it('reads the roles library index', () => {
    expect(agentsSurfaceOf(agentRolesRoute())).toEqual({
      section: 'abilities',
      memoryNote: false,
      abilityKind: 'roles',
      abilityIndex: true,
    })
  })

  it('reads the skills library and keeps its kind on a package page', () => {
    expect(agentsSurfaceOf(agentSkillsRoute())).toMatchObject({
      abilityKind: 'skills',
      abilityIndex: true,
    })
    expect(agentsSurfaceOf(agentAbilityDraftRoute('skill', 'draft-1'))).toMatchObject({
      section: 'abilities',
      abilityKind: 'skills',
      abilityIndex: false,
    })
  })

  it('reads the context and activity sections', () => {
    expect(agentsSurfaceOf(agentContextRoute('apollo'))).toMatchObject({
      section: 'context',
      memoryNote: false,
    })
    expect(agentsSurfaceOf(agentsRoute('activity'))).toMatchObject({ section: 'activity' })
  })

  it('counts a memory note as the Context section on its own route', () => {
    expect(agentsSurfaceOf(memoryNoteRoute('mem-1', 'what-i-know') ?? '')).toMatchObject({
      section: 'context',
      memoryNote: true,
    })
  })
})
