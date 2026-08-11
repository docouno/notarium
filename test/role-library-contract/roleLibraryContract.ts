// One spec, both implementations: the no-replace publication contract of
// RoleLibrary. It asserts only what BOTH can express — an occupant that is not a
// valid package (a bare file, a symlink, a directory without SKILL.md) has no
// in-memory representation at all, so those live in the filesystem leg.
//
// The factory runs PER CASE: a library carries per-root state, and one shared
// instance would make the cases order-dependent.

import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  RoleLibrary,
  RoleLocation,
  SkillPackage,
} from '../../packages/server/src/services/roles'

export type RoleLibraryFactory = () => Promise<{
  library: RoleLibrary
  teardown?: () => Promise<void>
}>

export const ROLE_LIBRARY_CONTRACT_PREFIX = 'RoleLibrary publication contract — '

export const packageOf = (name: string, body: string): SkillPackage => ({
  name,
  files: new Map([
    ['SKILL.md', Buffer.from(`---\nname: ${name}\ndescription: ${name}.\n---\n\n${body}`)],
    ['references/guide.md', Buffer.from(`# ${name}\n\n${body}\n`)],
  ]),
})

const bytesOf = async (library: RoleLibrary, location: RoleLocation, name: string) => {
  const pkg = await library.get(location, name)

  return packageBytes(pkg)
}

const packageBytes = (pkg: SkillPackage | null): string[] =>
  [...(pkg?.files ?? [])]
    .map(([member, content]) => `${member}\0${Buffer.from(content).toString('base64')}`)
    .sort()

export const describeRoleLibraryContract = (
  name: string,
  factory: RoleLibraryFactory,
  { gate }: { gate?: string } = {},
): void => {
  const suite = gate ? describe.skip : describe
  const location: RoleLocation = { scope: 'personal', space: 'personal' }

  suite(`${ROLE_LIBRARY_CONTRACT_PREFIX}${name}${gate ? ` ${gate}` : ''}`, () => {
    let library: RoleLibrary
    let teardown: (() => Promise<void>) | undefined

    beforeEach(async () => {
      ;({ library, teardown } = await factory())
    })

    afterEach(async () => {
      await teardown?.()
      teardown = undefined
    })

    it('publishes onto a free package name', async () => {
      await expect(library.putIfAbsent(location, packageOf('wanted', 'Owned.'))).resolves.toBe(true)
      await expect(library.get(location, 'wanted')).resolves.toMatchObject({ name: 'wanted' })
    })

    it('refuses a target already holding a valid package and leaves its bytes alone', async () => {
      await library.putIfAbsent(location, packageOf('wanted', 'Occupant.'))
      const before = await bytesOf(library, location, 'wanted')

      await expect(
        library.putIfAbsent(location, packageOf('wanted', 'Replacement.')),
      ).resolves.toBe(false)
      await expect(bytesOf(library, location, 'wanted')).resolves.toEqual(before)
    })

    it('answers a repeat of the same publication the same way', async () => {
      const pkg = packageOf('wanted', 'Occupant.')

      await expect(library.putIfAbsent(location, pkg)).resolves.toBe(true)
      const before = await bytesOf(library, location, 'wanted')

      await expect(library.putIfAbsent(location, pkg)).resolves.toBe(false)
      await expect(library.putIfAbsent(location, pkg)).resolves.toBe(false)
      await expect(bytesOf(library, location, 'wanted')).resolves.toEqual(before)
    })

    it('lets exactly one of two concurrent installers claim a free name', async () => {
      const candidates = [packageOf('wanted', 'First.'), packageOf('wanted', 'Second.')]
      const results = await Promise.all(
        candidates.map(async (candidate) => await library.putIfAbsent(location, candidate)),
      )

      expect(results.filter(Boolean)).toHaveLength(1)
      const published = await library.get(location, 'wanted')
      const winner = results.findIndex(Boolean)

      // The winner's package is whole — the loser neither replaced it nor left a
      // half-written member behind.
      expect(winner).toBeGreaterThanOrEqual(0)
      expect(packageBytes(published)).toEqual(packageBytes(candidates[winner]!))
    })
  })
}
