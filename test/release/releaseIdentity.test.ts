// The release gate decides whether an artifact may become public, so its
// predicates are pinned here rather than discovered during a release. The bias
// under test is deliberate: anything unproven blocks. A check that could not run
// is a blocker, an unreadable registry answer is not "absent", and a pre-release
// relaxes exactly three things — a release tag, a published source, and the folded
// Changelog — while staying bound to everything else.

import { describe, expect, it } from 'vitest'

import {
  bumpProductVersion,
  changelogEntryFor,
  compareProductVersions,
  compareVersions,
  dirtyPathsFrom,
  firstFreePrerelease,
  foldUnreleased,
  identityMismatches,
  imageRefFor,
  imageVersionFromInspect,
  isPublicSourceUrl,
  latestMoveDecision,
  parseProductVersion,
  prereleaseBaseVersion,
  publicSourceUrl,
  publishedTagCommitFrom,
  releaseBlockers,
  releaseIdentity,
  releaseTagFor,
  sourceUrlFor,
  tagPresence,
  VERSION_PATTERN,
} from '../../scripts/releaseIdentity.mjs'

const REVISION = 'a83069798e70dd55e2201c3f4fb2f82c1413e211'
const REPOSITORY = 'https://github.com/docouno/notarium'

const changelog = (body: string) => `# Changelog\n\nintro\n\n${body}\n`

const releasable = (overrides: Record<string, unknown> = {}) => ({
  version: '0.1.0',
  dirtyPaths: [],
  tagExists: true,
  tagCommit: REVISION,
  headCommit: REVISION,
  changelog: changelog('## [Unreleased]\n\n## [0.1.0] — 2026-07-23\n\n- something'),
  publishedTagCommit: REVISION,
  prerelease: false,
  ...overrides,
})

describe('release gate', () => {
  describe('product versions', () => {
    it('parses canonical safe x.y.z values', () => {
      expect(parseProductVersion('0.1.0')).toEqual({ major: 0, minor: 1, patch: 0 })
      expect(parseProductVersion('12.34.56')).toEqual({ major: 12, minor: 34, patch: 56 })
    })

    it.each([
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '-1.2.3',
      '1.2.3-rc.1',
      '1.2.3+build',
      '9007199254740992.0.0',
      '0.9007199254740992.0',
      '0.0.9007199254740992',
    ])('rejects %s', (version) => {
      expect(parseProductVersion(version)).toBeNull()
    })

    it('compares and bumps through the same parsed representation', () => {
      expect(compareProductVersions('0.2.0', '0.1.9')).toBe(1)
      expect(compareProductVersions('0.2.0', '0.2.0')).toBe(0)
      expect(bumpProductVersion('0.1.9', 'patch')).toBe('0.1.10')
      expect(bumpProductVersion('0.1.9', 'minor')).toBe('0.2.0')
      expect(bumpProductVersion('0.1.9', 'major')).toBe('1.0.0')
      expect(bumpProductVersion('9007199254740991.0.0', 'major')).toBeNull()
    })
  })

  describe('a releasable tree', () => {
    it('passes when every fact lines up', () => {
      expect(releaseBlockers(releasable())).toEqual([])
    })

    it('accepts a pre-release with no tag and no published source', () => {
      expect(
        releaseBlockers(
          releasable({
            prerelease: true,
            tagExists: false,
            tagCommit: null,
            publishedTagCommit: undefined,
          }),
        ),
      ).toEqual([])
    })

    it('still holds a pre-release to a clean tree', () => {
      const blockers = releaseBlockers(
        releasable({ prerelease: true, dirtyPaths: ['packages/server/src/x.ts'] }),
      )
      expect(blockers).toHaveLength(1)
      expect(blockers[0]).toMatch(/working tree is not clean/)
    })

    it('lets a pre-release out of a tree with work pending under [Unreleased]', () => {
      // The normal state of the repository between releases. Demanding a folded
      // Changelog here would make a pre-release possible only in the instant after
      // a release was cut — i.e. never when one is actually wanted.
      expect(
        releaseBlockers(
          releasable({
            prerelease: true,
            tagExists: false,
            tagCommit: null,
            publishedTagCommit: undefined,
            changelog: changelog(
              '## [Unreleased]\n\n### Added\n\n- work in flight\n\n## [0.0.9] — 2026-07-01\n\n- old',
            ),
          }),
        ),
      ).toEqual([])
    })
  })

  describe('refusals', () => {
    it('refuses a version that is not a clean x.y.z', () => {
      expect(releaseBlockers(releasable({ version: '0.1.0-rc.1' })).join()).toMatch(
        /not a clean x\.y\.z/,
      )
    })

    it('refuses non-canonical and unsafe product components', () => {
      expect(releaseBlockers(releasable({ version: '00.1.0' })).join()).toMatch(
        /not a clean x\.y\.z/,
      )
      expect(releaseBlockers(releasable({ version: '9007199254740992.0.0' })).join()).toMatch(
        /not a clean x\.y\.z/,
      )
    })

    it('refuses an unclean working tree', () => {
      expect(releaseBlockers(releasable({ dirtyPaths: ['CHANGELOG.md'] })).join()).toMatch(
        /working tree is not clean/,
      )
    })

    it('refuses a missing tag', () => {
      expect(releaseBlockers(releasable({ tagExists: false, tagCommit: null })).join()).toMatch(
        /tag v0\.1\.0 does not exist/,
      )
    })

    // Guards the removal of the annotated-tag requirement: the shape of the tag is
    // deliberately not part of the contract, so a caller still passing the old flag
    // must not resurrect a blocker. What makes the tag trustworthy is where it points.
    it('does not care whether the tag is annotated or lightweight', () => {
      expect(releaseBlockers(releasable({ tagAnnotated: false }))).toEqual([])
      expect(releaseBlockers(releasable({ tagAnnotated: true }))).toEqual([])
    })

    it('refuses a tag that is not what HEAD points at', () => {
      expect(releaseBlockers(releasable({ headCommit: 'b'.repeat(40) })).join()).toMatch(
        /HEAD \(bbbbbbbbbbbb\) is not v0\.1\.0/,
      )
    })

    it('refuses a tag that was never published', () => {
      expect(releaseBlockers(releasable({ publishedTagCommit: null })).join()).toMatch(
        /not published on the source repository/,
      )
    })

    it('refuses a published tag that names a different commit', () => {
      expect(releaseBlockers(releasable({ publishedTagCommit: 'c'.repeat(40) })).join()).toMatch(
        /differs from the local tag/,
      )
    })

    it('refuses a version with no dated Changelog section', () => {
      expect(
        releaseBlockers(
          releasable({ changelog: changelog('## [Unreleased]\n\n## [0.1.0]\n\n- undated') }),
        ).join(),
      ).toMatch(/no dated/)
    })

    it('refuses a Changelog that still has an unreleased heap', () => {
      expect(
        releaseBlockers(
          releasable({
            changelog: changelog(
              '## [Unreleased]\n\n### Added\n\n- a thing\n\n## [0.1.0] — 2026-07-23\n\n- released',
            ),
          }),
        ).join(),
      ).toMatch(/non-empty \[Unreleased\]/)
    })

    it('reports every reason at once rather than stopping at the first', () => {
      expect(
        releaseBlockers(
          releasable({
            dirtyPaths: ['a.ts'],
            tagExists: false,
            tagCommit: null,
            publishedTagCommit: null,
          }),
        ),
      ).toHaveLength(3)
    })
  })

  describe('isPublicSourceUrl', () => {
    // The source repository ends up as `build.source` in the image, where the API contract
    // validates it as a URL. Without this check the mistake surfaces only after a full
    // build, as a bare HTTP 400 from the verification probe.
    it('accepts the http(s) forms a reader can open', () => {
      expect(isPublicSourceUrl('https://github.com/docouno/notarium')).toBe(true)
      expect(isPublicSourceUrl('http://forge.example/org/repo')).toBe(true)
      expect(isPublicSourceUrl('https://forge.example:8443/org/repo')).toBe(true)
      // a dot in the repository name is not a `.git` suffix
      expect(isPublicSourceUrl('https://github.com/org/repo.js')).toBe(true)
    })

    // Refusing these would block a release over how the value was pasted. What matters is
    // that the NORMALISED form is what ships: tolerating padding and then publishing the
    // raw string would put it inside the image label and the `<repo>/tree/<sha>` link.
    it('normalises whitespace, a trailing slash and an uppercase scheme', () => {
      const canonical = 'https://github.com/docouno/notarium'

      expect(publicSourceUrl('  https://github.com/docouno/notarium  ')).toBe(canonical)
      expect(publicSourceUrl('https://github.com/docouno/notarium\n')).toBe(canonical)
      expect(publicSourceUrl('HTTPS://github.com/docouno/notarium')).toBe(canonical)
      expect(publicSourceUrl('https://github.com/docouno/notarium/')).toBe(canonical)
    })

    it('returns null rather than a mangled url for anything it refuses', () => {
      expect(publicSourceUrl('git@github.com:docouno/notarium.git')).toBeNull()
      expect(publicSourceUrl('https://github.com/o/r.git')).toBeNull()
    })

    it('rejects an SSH remote — the form `git remote -v` actually prints', () => {
      expect(isPublicSourceUrl('git@github.com:docouno/notarium.git')).toBe(false)
      expect(isPublicSourceUrl('ssh://git@github.com/docouno/notarium')).toBe(false)
      expect(isPublicSourceUrl('git://github.com/docouno/notarium')).toBe(false)
    })

    it('rejects a local path used while rehearsing, and empty input', () => {
      expect(isPublicSourceUrl('/tmp/source-repo.git')).toBe(false)
      expect(isPublicSourceUrl('')).toBe(false)
      expect(isPublicSourceUrl(undefined)).toBe(false)
    })

    // Clones fine, but the published `<repo>/tree/<sha>` link is a 404 — and the version
    // tag carrying it is immutable. Every spelling of the suffix, because a suffix regex
    // over the raw string let `.GIT`, `//`, `?` and `#` through.
    it('rejects a .git suffix however it is spelled', () => {
      expect(isPublicSourceUrl('https://github.com/o/r.git')).toBe(false)
      expect(isPublicSourceUrl('https://github.com/o/r.GIT')).toBe(false)
      expect(isPublicSourceUrl('https://github.com/o/r.git/')).toBe(false)
      expect(isPublicSourceUrl('https://github.com/o/r.git//')).toBe(false)
    })

    // Neither survives `<repo>/tree/<sha>` being appended.
    it('rejects a query or a fragment', () => {
      expect(isPublicSourceUrl('https://github.com/o/r?x=1')).toBe(false)
      expect(isPublicSourceUrl('https://github.com/o/r#a')).toBe(false)
    })

    // Would be baked verbatim into the OCI labels, /api/about and the job log.
    it('rejects embedded credentials', () => {
      expect(isPublicSourceUrl('https://user:token@github.com/docouno/notarium')).toBe(false)
      expect(isPublicSourceUrl('https://token@github.com/docouno/notarium')).toBe(false)
    })

    // `new URL` rejects a bare scheme outright; `https:///x` is the shape that parses
    // while reading the path as the host, which is what the hostname check is for.
    it('requires a host', () => {
      expect(isPublicSourceUrl('https://')).toBe(false)
      expect(isPublicSourceUrl('https:// ')).toBe(false)
      expect(isPublicSourceUrl('https://@github.com/o/r')).toBe(true)
    })
  })

  describe('prereleaseBaseVersion', () => {
    it('attaches to the manifests version while that version is unreleased', () => {
      expect(prereleaseBaseVersion({ version: '0.1.0', releasePublished: false })).toBe('0.1.0')
    })

    it('attaches to the next patch once that version is published', () => {
      // Otherwise `0.1.0-rc.<sha>` cut after 0.1.0 shipped would SemVer-order below
      // the release whose code it supersedes, and a version-sorting tool would call
      // downgrading to 0.1.0 an upgrade.
      expect(prereleaseBaseVersion({ version: '0.1.0', releasePublished: true })).toBe('0.1.1')
      expect(compareVersions('0.1.1-rc.abc1234', '0.1.0')).toBe(1)
    })

    it('treats an unanswerable registry the same as published', () => {
      // Naming an unreleased version is a mild inconvenience; naming a published one
      // is a lie about ordering.
      expect(prereleaseBaseVersion({ version: '2.3.9', releasePublished: null })).toBe('2.3.10')
    })
  })

  describe('firstFreePrerelease', () => {
    const registry = (...taken: string[]) => {
      const held = new Set(taken)

      return (version: string) => (held.has(version) ? 'present' : 'absent')
    }

    it('starts at 1 when nothing is published', () => {
      expect(firstFreePrerelease({ base: '0.1.0', probe: registry() })).toBe('0.1.0-rc.1')
    })

    it('skips every candidate the registry already holds', () => {
      expect(
        firstFreePrerelease({ base: '0.1.0', probe: registry('0.1.0-rc.1', '0.1.0-rc.2') }),
      ).toBe('0.1.0-rc.3')
    })

    it('counts per base version, not globally', () => {
      // 0.1.0's candidates say nothing about 0.2.0's — numbering restarts, exactly as
      // it does for a fresh release line.
      expect(firstFreePrerelease({ base: '0.2.0', probe: registry('0.1.0-rc.1') })).toBe(
        '0.2.0-rc.1',
      )
    })

    it('refuses rather than guessing when the registry will not answer', () => {
      // "Unreadable" is not "free": guessing means republishing a candidate someone
      // may already have pulled, which is the one thing an immutable tag must not do.
      expect(() => firstFreePrerelease({ base: '0.1.0', probe: () => 'unknown' })).toThrow(
        /cannot determine/,
      )
    })

    it('takes 1 without asking when the caller says the repository is new', () => {
      // --first-publication: there is nothing published to count against, and the
      // registry answers "denied" and "no such repository" identically.
      expect(firstFreePrerelease({ base: '0.1.0', probe: () => 'unknown', blind: true })).toBe(
        '0.1.0-rc.1',
      )
    })

    it('refuses instead of counting forever', () => {
      expect(() =>
        firstFreePrerelease({ base: '0.1.0', probe: () => 'present', limit: 3 }),
      ).toThrow(/3 published candidates/)
    })
  })

  describe('publishedTagCommitFrom', () => {
    const COMMIT = 'a81308c453db6a254e06f384073a947acb6bcc70'
    const TAG_OBJECT = '08c4202fcc2d55b5a6f63fc9307cf6ec1831c5fd'

    it('takes the COMMIT of an annotated tag, not the tag object', () => {
      // Regression: comparing the tag object's sha to a local commit sha made every
      // annotated release tag read as "differs from the local tag", so no release
      // could ever pass the published-source gate.
      const stdout = [`${TAG_OBJECT}\trefs/tags/v1.0.0`, `${COMMIT}\trefs/tags/v1.0.0^{}`].join(
        '\n',
      )
      expect(publishedTagCommitFrom(stdout, 'v1.0.0')).toBe(COMMIT)
    })

    it('takes the single line of a lightweight tag', () => {
      expect(publishedTagCommitFrom(`${COMMIT}\trefs/tags/v1.0.0`, 'v1.0.0')).toBe(COMMIT)
    })

    it('ignores a neighbouring tag that shares the prefix', () => {
      const stdout = [
        `${TAG_OBJECT}\trefs/tags/v1.0.0-rc.1`,
        `${COMMIT}\trefs/tags/v1.0.0-rc.1^{}`,
      ].join('\n')
      expect(publishedTagCommitFrom(stdout, 'v1.0.0')).toBeNull()
    })

    it('reports an absent tag as null rather than guessing', () => {
      expect(publishedTagCommitFrom('', 'v1.0.0')).toBeNull()
    })
  })

  describe('dirtyPathsFrom', () => {
    it('keeps the first character of an unstaged path (the leading status column is a space)', () => {
      expect(dirtyPathsFrom(' M scripts/releaseImage.mjs\n')).toEqual(['scripts/releaseImage.mjs'])
    })

    it('reads staged, untracked and mixed states alike', () => {
      expect(dirtyPathsFrom('M  a.ts\n?? b.ts\nMM c.ts\n')).toEqual(['a.ts', 'b.ts', 'c.ts'])
    })

    it('keeps a path that itself contains spaces', () => {
      expect(dirtyPathsFrom(' M docs/some file.md')).toEqual(['docs/some file.md'])
    })

    it('is empty for a clean tree', () => {
      expect(dirtyPathsFrom('')).toEqual([])
    })
  })

  describe('changelogEntryFor', () => {
    it('reads the date of a released section', () => {
      expect(changelogEntryFor(changelog('## [0.2.0] — 2026-08-01\n\n- x'), '0.2.0')).toMatchObject(
        { released: true, date: '2026-08-01' },
      )
    })

    it('treats an empty [Unreleased] as nothing pending', () => {
      expect(
        changelogEntryFor(changelog('## [Unreleased]\n\n## [0.1.0] — 2026-07-23\n\n- x'), '0.1.0')
          .unreleasedFilled,
      ).toBe(false)
    })

    it('does not confuse a similarly numbered version', () => {
      expect(changelogEntryFor(changelog('## [0.1.10] — 2026-08-01'), '0.1.1').released).toBe(false)
    })

    it('sees a trailing [Unreleased] at the very end of the file', () => {
      expect(
        changelogEntryFor('# Changelog\n\n## [Unreleased]\n\n### Added\n\n- late\n', '0.1.0')
          .unreleasedFilled,
      ).toBe(true)
    })
  })

  describe('foldUnreleased', () => {
    const pending = '# Changelog\n\nintro\n\n## [Unreleased]\n\n### Added\n\n- a thing\n'

    it('turns the pending section into a dated release and leaves a fresh [Unreleased]', () => {
      const { changelog: folded } = foldUnreleased(pending, '0.2.0', '2026-08-01')
      expect(folded).toBe(
        '# Changelog\n\nintro\n\n## [Unreleased]\n\n## [0.2.0] — 2026-08-01\n\n### Added\n\n- a thing\n',
      )
      // The folded output must itself satisfy the release gate.
      expect(changelogEntryFor(folded, '0.2.0')).toMatchObject({
        released: true,
        date: '2026-08-01',
        unreleasedFilled: false,
      })
    })

    it('keeps the blank line under the new heading (a glued ### breaks the section)', () => {
      expect(foldUnreleased(pending, '0.2.0', '2026-08-01').changelog).toContain(
        '## [0.2.0] — 2026-08-01\n\n### Added',
      )
    })

    it('refuses an empty [Unreleased] — a release with nothing to say', () => {
      const { changelog: folded, reason } = foldUnreleased(
        '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] — 2026-07-23\n\n- old\n',
        '0.2.0',
        '2026-08-01',
      )
      expect(folded).toBeNull()
      expect(reason).toMatch(/nothing under \[Unreleased\]/)
    })

    it('refuses when the version already has a section', () => {
      const { changelog: folded, reason } = foldUnreleased(
        `${pending}\n## [0.2.0] — 2026-07-23\n\n- already out\n`,
        '0.2.0',
        '2026-08-01',
      )
      expect(folded).toBeNull()
      expect(reason).toMatch(/already has a \[0\.2\.0\] section/)
    })

    it('refuses a Changelog with no [Unreleased] at all', () => {
      expect(
        foldUnreleased('# Changelog\n\n## [0.1.0] — 2026-07-23\n', '0.2.0', '2026-08-01').reason,
      ).toMatch(/no "## \[Unreleased\]" section/)
    })
  })

  describe('identity', () => {
    it('derives build args, labels and the expected build report from one input', () => {
      const identity = releaseIdentity({
        version: '0.1.0',
        revision: REVISION,
        builtAt: '2026-07-23T10:00:00Z',
        sourceRepository: REPOSITORY,
      })

      expect(identity.shortCommit).toBe('a830697')
      expect(identity.source).toBe(`${REPOSITORY}/tree/${REVISION}`)
      expect(identity.buildArgs).toMatchObject({
        GIT_SHA: 'a830697',
        BUILD_TIME: '2026-07-23T10:00:00Z',
        SOURCE_URL: `${REPOSITORY}/tree/${REVISION}`,
        GIT_REVISION: REVISION,
        SOURCE_REPO: REPOSITORY,
        VERSION: '0.1.0',
      })
      expect(identity.labels['org.opencontainers.image.revision']).toBe(REVISION)
      expect(identity.labels['org.opencontainers.image.licenses']).toBe('AGPL-3.0-only')
      expect(identity.build).toEqual({
        version: '0.1.0',
        commit: 'a830697',
        builtAt: '2026-07-23T10:00:00Z',
        source: `${REPOSITORY}/tree/${REVISION}`,
      })
    })

    it('carries a pre-release version through the tag, the label and what the image reports', () => {
      // A pre-release is built off the same sources as the release it precedes, so
      // nothing but this version string distinguishes the two artifacts. It has to
      // reach every place identity is read from, or the image claims to be 0.1.0.
      const identity = releaseIdentity({
        version: '0.1.0-rc.a830697',
        revision: REVISION,
        builtAt: '2026-07-23T10:00:00Z',
        sourceRepository: REPOSITORY,
      })

      expect(identity.buildArgs.VERSION).toBe('0.1.0-rc.a830697')
      expect(identity.labels['org.opencontainers.image.version']).toBe('0.1.0-rc.a830697')
      expect(identity.build.version).toBe('0.1.0-rc.a830697')
    })

    it('points at a revision, never at a branch, and tolerates a trailing slash', () => {
      expect(sourceUrlFor(`${REPOSITORY}/`, REVISION)).toBe(`${REPOSITORY}/tree/${REVISION}`)
    })

    it('spells an image ref with and without a registry', () => {
      expect(imageRefFor({ registry: '', name: 'docouno/notarium', tag: '0.1.0' })).toBe(
        'docouno/notarium:0.1.0',
      )
      expect(
        imageRefFor({ registry: 'localhost:5000', name: 'notarium/x', tag: '0.1.0-rc.a830697' }),
      ).toBe('localhost:5000/notarium/x:0.1.0-rc.a830697')
    })

    it('names the release tag', () => {
      expect(releaseTagFor('1.2.3')).toBe('v1.2.3')
      expect(VERSION_PATTERN.test('1.2.3')).toBe(true)
      expect(VERSION_PATTERN.test('1.2')).toBe(false)
    })
  })

  describe('identityMismatches', () => {
    const expected = releaseIdentity({
      version: '0.1.0',
      revision: REVISION,
      builtAt: '2026-07-23T10:00:00Z',
      sourceRepository: REPOSITORY,
    })

    it('passes an image that reports exactly what was intended', () => {
      expect(
        identityMismatches({
          expected,
          reportedBuild: expected.build,
          actualLabels: expected.labels,
          reporter: undefined,
        }),
      ).toEqual([])
    })

    it('catches an image built without the identity build args', () => {
      const mismatches = identityMismatches({
        expected,
        reportedBuild: { version: '0.1.0', commit: null, builtAt: null, source: null },
        actualLabels: expected.labels,
        reporter: undefined,
      })
      expect(mismatches).toHaveLength(3)
      expect(mismatches.join()).toMatch(/commit is null/)
    })

    it('names the reporter that disagreed, so /api/about is not blamed on the CLI', () => {
      expect(
        identityMismatches({
          expected,
          reportedBuild: { ...expected.build, commit: 'ffffff0' },
          actualLabels: expected.labels,
          reporter: '/api/about',
        })[0],
      ).toMatch(/^\/api\/about: commit/)
    })

    it('catches a label that names a different revision', () => {
      expect(
        identityMismatches({
          expected,
          reportedBuild: expected.build,
          actualLabels: {
            ...expected.labels,
            'org.opencontainers.image.revision': 'd'.repeat(40),
          },
          reporter: undefined,
        }).join(),
      ).toMatch(/label org\.opencontainers\.image\.revision/)
    })

    it('treats missing labels as a mismatch, not as "not applicable"', () => {
      expect(
        identityMismatches({
          expected,
          reportedBuild: expected.build,
          actualLabels: null,
          reporter: undefined,
        }),
      ).toHaveLength(Object.keys(expected.labels).length)
    })
  })

  describe('moving :latest', () => {
    // Built as a value, not inline: some cases deliberately pass `firstPublication`,
    // which the decision must IGNORE — and an inline literal would be rejected by
    // excess-property checking before the assertion could prove that.
    const decide = (overrides: Record<string, unknown> = {}) => {
      const args = {
        presence: 'present',
        publishedVersion: '0.1.0',
        version: '0.2.0',
        force: false,
        ...overrides,
      }
      return latestMoveDecision(args)
    }

    it('moves forward onto a newer version', () => {
      expect(decide()).toEqual({ move: true, reason: null })
    })

    it('moves when there is no :latest yet', () => {
      expect(decide({ presence: 'absent', publishedVersion: null }).move).toBe(true)
    })

    it('refuses to move backwards — a plain `docker pull` would downgrade', () => {
      const { move, reason } = decide({ publishedVersion: '0.2.0', version: '0.1.4' })
      expect(move).toBe(false)
      expect(reason).toMatch(/newer than 0\.1\.4/)
    })

    it('refuses to re-point :latest at the same version', () => {
      const { move, reason } = decide({ publishedVersion: '0.2.0', version: '0.2.0' })
      expect(move).toBe(false)
      expect(reason).toMatch(/the same version/)
    })

    it('refuses when the published :latest carries no version label', () => {
      expect(decide({ publishedVersion: null }).move).toBe(false)
    })

    it('refuses when the registry answer is unreadable', () => {
      const { move, reason } = decide({ presence: 'unknown', publishedVersion: null })
      expect(move).toBe(false)
      expect(reason).toMatch(/blind/)
    })

    it('is NOT widened by --first-publication', () => {
      // By the time :latest is considered, the version tag has just been pushed, so
      // the repository demonstrably exists: an unreadable answer means something
      // else, and only --force-latest may override it.
      expect(
        decide({ presence: 'unknown', publishedVersion: null, firstPublication: true }).move,
      ).toBe(false)
    })

    it('--force-latest overrides every refusal', () => {
      expect(decide({ publishedVersion: '9.9.9', force: true })).toEqual({
        move: true,
        reason: null,
      })
    })

    it('orders versions field-wise, not lexically', () => {
      expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
      expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
      expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    })

    it('ranks a pre-release below the release it precedes', () => {
      // :latest can legitimately hold a pre-release, and a bare Number() compare
      // turned every such pair into NaN — which compared as "-1" and looked like a
      // decision while being noise.
      expect(compareVersions('0.1.0', '0.1.0-rc.1')).toBe(1)
      expect(compareVersions('0.1.0-rc.1', '0.1.0')).toBe(-1)
      expect(compareVersions('0.2.0-rc.1', '0.1.0')).toBe(1)
      expect(compareVersions('0.1.0-rc.2', '0.1.0-rc.1')).toBe(1)
      expect(compareVersions('0.1.0-rc.1', '0.1.0-rc.1')).toBe(0)
    })

    it('orders candidates NUMERICALLY, which is the whole point of -rc.N', () => {
      // Lexically "rc.10" < "rc.9", so a string compare reports the tenth candidate as
      // older than the ninth — silently, inside the rule that decides whether :latest
      // may move. SemVer §11.4 compares dot-separated identifiers, numeric ones as
      // numbers.
      expect(compareVersions('0.1.0-rc.10', '0.1.0-rc.9')).toBe(1)
      expect(compareVersions('0.1.0-rc.2', '0.1.0-rc.11')).toBe(-1)
    })

    it('ranks a numeric identifier below an alphanumeric one (§11.4.3)', () => {
      // The historical `-rc.<sha>` form is alphanumeric, so a legacy candidate still
      // sorts predictably against a numbered one instead of by accident.
      expect(compareVersions('0.1.0-rc.1', '0.1.0-rc.abc1234')).toBe(-1)
      expect(compareVersions('0.1.0-rc.abc1234', '0.1.0-rc.1')).toBe(1)
    })

    it('ranks a longer identifier list above its prefix (§11.4.4)', () => {
      expect(compareVersions('0.1.0-rc.1.1', '0.1.0-rc.1')).toBe(1)
    })

    it('refuses to move :latest from a release down onto a pre-release', () => {
      expect(
        latestMoveDecision({
          presence: 'present',
          publishedVersion: '0.2.0',
          version: '0.2.0-rc.abc1234',
          force: false,
        }).move,
      ).toBe(false)
    })
  })

  describe('imageVersionFromInspect', () => {
    const config = (version?: string) => ({
      config: {
        Labels: version ? { 'org.opencontainers.image.version': version } : {},
      },
    })

    it('reads the version from a multi-platform inspect keyed by platform', () => {
      const raw = JSON.stringify({ 'linux/amd64': config('0.2.0'), 'linux/arm64': config('0.2.0') })
      expect(imageVersionFromInspect(raw, 'linux/amd64')).toBe('0.2.0')
    })

    it('reads the version from a single-manifest inspect', () => {
      expect(imageVersionFromInspect(JSON.stringify(config('0.3.1')))).toBe('0.3.1')
    })

    it('returns null for an image published before the labels existed', () => {
      expect(imageVersionFromInspect(JSON.stringify(config()))).toBeNull()
    })

    it('returns null on unparseable output rather than throwing mid-release', () => {
      expect(imageVersionFromInspect('not json at all')).toBeNull()
    })
  })

  describe('tagPresence', () => {
    it('reads a successful lookup as present', () => {
      expect(tagPresence({ ok: true, stderr: '' })).toBe('present')
    })

    it.each([
      'manifest unknown',
      'errors:\n denied: requested access to the resource is denied\nmanifest unknown: manifest unknown',
      'no such manifest: docouno/notarium:9.9.9',
      'GET https://registry-1.docker.io/v2/...: NAME_UNKNOWN: repository name not known to registry',
    ])('reads %s as absent', (stderr) => {
      expect(tagPresence({ ok: false, stderr })).toBe('absent')
    })

    it.each([
      'unauthorized: authentication required',
      'Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io: no such host',
      '',
    ])('refuses to guess when the registry answer is unreadable (%s)', (stderr) => {
      expect(tagPresence({ ok: false, stderr })).toBe('unknown')
    })
  })
})
