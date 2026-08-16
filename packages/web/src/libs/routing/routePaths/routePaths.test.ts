import { describe, expect, it } from 'vitest'
import {
  dashboardRoute,
  folderPageHref,
  folderPageRoute,
  folderRoute,
  parseAppPath,
  spaceRoute,
  workspaceSettingsRoute,
} from './routePaths'

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
