// One spec, every implementation: the no-replace publication contract of
// RoleLibrary — `putIfAbsent` AND `movePackage`, which are the port's two writes and
// answer the same question about an occupied destination. It asserts only what ALL of
// them can express: an occupant that is not a valid package (a bare file, a symlink, a
// directory without SKILL.md) has no in-memory representation at all, so those live in
// the filesystem leg, and so does every refusal that is about the HOST rather than the
// port (an unsupported atomic-publication medium).
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

export const packageDirectoryOf = (name: string): string =>
  Buffer.from(name).toString('base64url').padEnd(12, 'A').slice(0, 12)

export const packageOf = (name: string, body: string): SkillPackage => ({
  directoryName: packageDirectoryOf(name),
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
  /** The other side of every move. Production performs exactly one — a project
   *  version lifted to the placement that owns the library root — and both sides are
   *  always in ONE space, because two spaces are two note stores and the engine has no
   *  operation that moves a note between them. */
  const version: RoleLocation = { scope: 'project', space: 'personal', projectId: 'project-a' }

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
      await expect(library.get(location, 'wanted')).resolves.toMatchObject({
        directoryName: packageDirectoryOf('wanted'),
      })
    })

    it('refuses a target already holding a valid package and leaves its bytes alone', async () => {
      await library.putIfAbsent(location, packageOf('wanted', 'Occupant.'))
      const before = await bytesOf(library, location, 'wanted')

      await expect(
        library.putIfAbsent(location, packageOf('wanted', 'Replacement.')),
      ).resolves.toBe(false)
      await expect(bytesOf(library, location, 'wanted')).resolves.toEqual(before)
    })

    it('carries package resources that are not Markdown, byte for byte', async () => {
      const script = Buffer.from('#!/bin/sh\necho evidence\n')
      const binary = Uint8Array.from([0, 1, 2, 255, 0])
      const pkg = packageOf('wanted', 'Owned.')

      pkg.files.set('scripts/collect.sh', script)
      pkg.files.set('assets/logo.bin', binary)

      await expect(library.putIfAbsent(location, pkg)).resolves.toBe(true)
      const published = await library.get(location, 'wanted')

      // Every member is still there — an implementation that drops what it cannot
      // model quietly narrows what a package IS, and `packagesEqual` (the Add
      // dependency check in `RolesService`) compares exactly this map.
      expect([...(published?.files.keys() ?? [])].sort()).toEqual([
        'SKILL.md',
        'assets/logo.bin',
        'references/guide.md',
        'scripts/collect.sh',
      ])
      // Verbatim, not round-tripped: a resource is not a document, so nothing may
      // reformat it. (The two Markdown members are deliberately not compared here —
      // an implementation whose store claims an identity into the manifest rewrites
      // those, which the concurrency case below states in full.)
      expect(Buffer.from(published!.files.get('scripts/collect.sh')!)).toEqual(script)
      expect(Uint8Array.from(published!.files.get('assets/logo.bin')!)).toEqual(binary)
    })

    it('answers `exists` about manifest NAMES, never about package addresses', async () => {
      const pkg = packageOf('wanted', 'Owned.')

      await expect(library.putIfAbsent(location, pkg)).resolves.toBe(true)
      await expect(library.exists(location, 'wanted')).resolves.toBe(true)
      // The owned package address is not a name any manifest may carry, so nothing
      // occupies it AS A NAME. An implementation that answers `true` here reports a
      // free name as taken: Add and promotion both refuse on this one question
      // (`RolesService.addFromCatalog`, `moveRolePlacement`), so the caller is told
      // "already exists" about a name no package owns and has no way to free.
      await expect(library.exists(location, pkg.directoryName)).resolves.toBe(false)
      await expect(library.exists(location, 'Wanted')).resolves.toBe(false)
      await expect(library.exists(location, 'wan--ted')).resolves.toBe(false)
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
      const first = packageOf('wanted', 'First.')
      const second = packageOf('wanted', 'Second.')
      const candidates = [
        { ...first, directoryName: 'Ab3xK9_qZ12R' },
        { ...second, directoryName: 'Zy9xW8_vU76Q' },
      ]
      const results = await Promise.all(
        candidates.map(async (candidate) => await library.putIfAbsent(location, candidate)),
      )

      expect(results.filter(Boolean)).toHaveLength(1)
      const published = await library.get(location, 'wanted')
      const winner = results.findIndex(Boolean)

      expect(winner).toBeGreaterThanOrEqual(0)
      // The winner's package is whole — the loser neither replaced it nor left a
      // half-written member behind. Stated as "identical to the same publication made
      // alone", not "identical to the bytes handed in": an implementation whose store
      // claims an identity into the manifest (the note projection writes `notarium-id`
      // into the frontmatter it publishes, canon: docs/architecture.md#p7) round-trips
      // every package, contested or not. Comparing against the uncontested round trip
      // keeps the whole difference attributable to the race and nothing else.
      const alone = await factory()

      try {
        expect(await alone.library.putIfAbsent(location, candidates[winner]!)).toBe(true)
        expect(packageBytes(published)).toEqual(
          packageBytes(await alone.library.get(location, 'wanted')),
        )
      } finally {
        await alone.teardown?.()
      }
    })

    // ── movePackage ─────────────────────────────────────────────────────────
    // The port's second write, and the one every leg used to answer for itself: three
    // implementations existed, the production one was executed by no test at all, and
    // they had already drifted apart. It belongs here for the same reason `putIfAbsent`
    // does — a promotion is a publication that also has to leave the source empty.

    it('moves a package to another placement of the same space', async () => {
      const pkg = packageOf('wanted', 'Owned.')

      await expect(library.putIfAbsent(version, pkg)).resolves.toBe(true)
      const before = await bytesOf(library, version, 'wanted')

      await expect(library.movePackage(version, location, pkg.directoryName)).resolves.toBe(true)

      // The package ADDRESS survives the move, and so does every member byte for byte
      // — that is the whole reason a promotion moves the directory instead of
      // republishing its bytes (canon: docs/architecture.md#p7).
      await expect(bytesOf(library, location, 'wanted')).resolves.toEqual(before)
      await expect(library.getByDirectory(location, pkg.directoryName)).resolves.toMatchObject({
        directoryName: pkg.directoryName,
      })
      await expect(library.exists(location, 'wanted')).resolves.toBe(true)
      // …and nothing is left behind. A move that COPIED would leave the version
      // answering at its old placement, which resolution still prefers over the base.
      await expect(library.get(version, 'wanted')).resolves.toBeNull()
      await expect(library.getByDirectory(version, pkg.directoryName)).resolves.toBeNull()
      await expect(library.exists(version, 'wanted')).resolves.toBe(false)
    })

    it('refuses a move onto a manifest name the destination already holds', async () => {
      const moving = packageOf('wanted', 'Version.')
      const occupant = { ...packageOf('wanted', 'Base.'), directoryName: 'Zy9xW8_vU76Q' }

      await library.putIfAbsent(version, moving)
      await library.putIfAbsent(location, occupant)
      const source = await bytesOf(library, version, 'wanted')
      const target = await bytesOf(library, location, 'wanted')

      // A base and its project version legally share a NAME — that is what makes them
      // the same role — so a move into an occupied name is the ordinary case rather
      // than an edge, and neither merging nor overwriting is an answer the caller
      // could have meant. `false`, and both packages untouched.
      await expect(library.movePackage(version, location, moving.directoryName)).resolves.toBe(
        false,
      )
      await expect(bytesOf(library, version, 'wanted')).resolves.toEqual(source)
      await expect(bytesOf(library, location, 'wanted')).resolves.toEqual(target)
    })

    it('answers false when the source placement holds no such package', async () => {
      await expect(
        library.movePackage(version, location, packageDirectoryOf('wanted')),
      ).resolves.toBe(false)
      await expect(library.get(location, 'wanted')).resolves.toBeNull()
      await expect(
        library.getByDirectory(location, packageDirectoryOf('wanted')),
      ).resolves.toBeNull()
    })

    it('refuses a move across two spaces outright', async () => {
      const pkg = packageOf('wanted', 'Owned.')

      await library.putIfAbsent(version, pkg)

      // Not `false`: `false` means "the destination was taken", which a caller answers
      // by picking another name. Two spaces are two note stores and there is no
      // operation that moves a note between them, so there is nothing to retry.
      await expect(
        library.movePackage(version, { scope: 'personal', space: 'elsewhere' }, pkg.directoryName),
      ).rejects.toThrow(/cross spaces/)
      await expect(library.getByDirectory(version, pkg.directoryName)).resolves.not.toBeNull()
    })

    it('never reports a move it did not make, for an address that is not one', async () => {
      const pkg = packageOf('wanted', 'Owned.')

      await library.putIfAbsent(version, pkg)

      // `movePackage` is the one entry of the port that takes the owned package
      // address as a bare string, so a caller who hands it a manifest NAME reaches it
      // — and must not be told something moved.
      //
      // The SHAPE of the refusal is where the implementations still disagree, and the
      // disagreement is declared rather than hidden: the filesystem library throws
      // `InvalidSkillPackageError` (asserted in its own leg, beside the identical
      // refusal `putIfAbsent` makes), while both doubles answer `false`. What all
      // three owe — never `true`, and nothing moved — is asserted here for all three.
      await expect(
        library.movePackage(version, location, 'wanted').then(
          (moved) => moved,
          () => false,
        ),
      ).resolves.toBe(false)
      await expect(library.getByDirectory(version, pkg.directoryName)).resolves.not.toBeNull()
      await expect(library.get(location, 'wanted')).resolves.toBeNull()
    })

    it('never reports a move it did not make, for two placements that are one', async () => {
      const pkg = packageOf('wanted', 'Owned.')

      await library.putIfAbsent(version, pkg)
      const before = await bytesOf(library, version, 'wanted')

      // Degenerate and reachable: both placements are derived from one locator, so a
      // caller that derived them from the same one arrives here. Answering `true`
      // would tell a promotion the role changed placement when it did not — and on
      // the filesystem it means publishing a directory onto itself. Same declared
      // divergence as above: the filesystem library throws, both doubles answer
      // `false`, and the floor every implementation owes is asserted here.
      await expect(
        library.movePackage(version, version, pkg.directoryName).then(
          (moved) => moved,
          () => false,
        ),
      ).resolves.toBe(false)
      await expect(bytesOf(library, version, 'wanted')).resolves.toEqual(before)
    })
  })
}

/** The one `movePackage` refusal that is NOT in the shared suite above, and the reason
 *  is stated rather than skipped: it needs two placements of one space to hold the same
 *  package ADDRESS at once, and the fake server's store-backed library cannot get into
 *  that state. Publishing the same address at two placements there succeeds twice and
 *  then reads back as one corrupt package — the two publications collide inside the
 *  store's own note identities. That is a defect of that double, written up rather than
 *  papered over; when it is fixed, this arm folds back into the suite above and the
 *  store leg claims it like the others.
 *
 *  The state is ordinary on a real filesystem — a package address is a DIRECTORY NAME
 *  there, unique per placement, so a promotion undone by hand and redone lands exactly
 *  here — which is why the refusal is a port question and not a filesystem detail. */
export const describeRoleLibraryAddressCollisionContract = (
  name: string,
  factory: RoleLibraryFactory,
  { gate }: { gate?: string } = {},
): void => {
  const suite = gate ? describe.skip : describe
  const location: RoleLocation = { scope: 'personal', space: 'personal' }
  const version: RoleLocation = { scope: 'project', space: 'personal', projectId: 'project-a' }

  suite(
    `${ROLE_LIBRARY_CONTRACT_PREFIX}${name}${gate ? ` ${gate}` : ''} — address collision`,
    () => {
      it('refuses a move onto the package address the destination already holds', async () => {
        const { library, teardown } = await factory()

        try {
          const moving = packageOf('wanted', 'Version.')
          const twin = { ...packageOf('other', 'Squatter.'), directoryName: moving.directoryName }

          await expect(library.putIfAbsent(version, moving)).resolves.toBe(true)
          await expect(library.putIfAbsent(location, twin)).resolves.toBe(true)

          // The NAME is free at the destination and the ADDRESS is not. Asked apart from
          // the name because they are two different keys: an implementation that only
          // consults its manifest index publishes straight onto the occupant's directory
          // and loses it.
          await expect(library.movePackage(version, location, moving.directoryName)).resolves.toBe(
            false,
          )
          await expect(
            library.getByDirectory(version, moving.directoryName),
          ).resolves.not.toBeNull()
          await expect(library.get(location, 'other')).resolves.toMatchObject({
            directoryName: twin.directoryName,
          })
        } finally {
          await teardown?.()
        }
      })
    },
  )
}
