// The decidable parts of a release, kept free of git/docker so they are
// unit-testable: what identity a build must carry, how it is spelled into build
// args and OCI labels, and how a built image is checked against it.
// The orchestration that shells out lives in releaseImage.mjs.
// canon: docs/release.md

/** SemVer as the lockstep manifests spell it — no pre-release/build metadata: the
 *  published tag IS the version, and `0.1.0+local` would name an artifact the
 *  Changelog has no section for. */
export const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

export const parseProductVersion = (value) => {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    return null
  }
  const [major, minor, patch] = value.split('.').map(Number)

  return [major, minor, patch].every(Number.isSafeInteger) ? { major, minor, patch } : null
}

export const compareProductVersions = (left, right) => {
  const parsedLeft = parseProductVersion(left)
  const parsedRight = parseProductVersion(right)

  if (!parsedLeft || !parsedRight) {
    throw new TypeError(`product version compare requires canonical safe x.y.z values`)
  }

  for (const field of ['major', 'minor', 'patch']) {
    if (parsedLeft[field] !== parsedRight[field]) {
      return parsedLeft[field] > parsedRight[field] ? 1 : -1
    }
  }

  return 0
}

export const bumpProductVersion = (version, bump) => {
  const current = parseProductVersion(version)

  if (!current || !['major', 'minor', 'patch'].includes(bump)) {
    return null
  }
  const next =
    bump === 'major'
      ? [current.major + 1, 0, 0]
      : bump === 'minor'
        ? [current.major, current.minor + 1, 0]
        : [current.major, current.minor, current.patch + 1]

  return next.every(Number.isSafeInteger) ? next.join('.') : null
}

/** A Changelog entry ready to be released: an exact version heading with a real
 *  ISO date. `[Unreleased]` is not a release and never satisfies this. */
const RELEASED_SECTION = (version) =>
  new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\][^\\n]*?(\\d{4}-\\d{2}-\\d{2})`, 'm')

export const releaseTagFor = (version) => `v${version}`

/** Where the sources of THIS build can be read. Points at a revision, never a
 *  branch: a branch URL drifts away from the artifact the moment it moves. */
export const sourceUrlFor = (repository, revision) =>
  `${repository.replace(/\/+$/, '')}/tree/${revision}`

/** Is this something a person can open in a browser?
 *
 *  The source repository becomes `build.source` inside the image, and the API
 *  contract validates that as a URL — so an SSH remote (`git@host:org/repo.git`),
 *  which is what a `git remote -v` line actually looks like, or a local path used
 *  while rehearsing, survives the entire build and is rejected only by the last
 *  verification step, minutes in and reported as a bare HTTP 400. Checked at the
 *  argument instead, where the mistake is.
 *
 *  Being a URL is necessary but not sufficient, so two more shapes are refused:
 *
 *  - a `.git` suffix. `https://host/org/repo.git` clones perfectly and is what most
 *    remotes are called, but the published link is `<repo>/tree/<sha>` — and
 *    `…/repo.git/tree/abc123` is a 404 on GitHub. The gate would pass, the image
 *    would carry a dead source link, and the version tag is immutable.
 *  - embedded credentials. `https://user:token@host/...` would be baked into the OCI
 *    labels, /api/about and the job log, i.e. published verbatim and forever. */
export const publicSourceUrl = (repository) => {
  // Parsed, not pattern-matched: `.GIT`, a trailing `//`, `?x=1` and `#a` all slipped past
  // a suffix regex while producing exactly the dead link it was meant to stop, and a
  // pasted `HTTPS://` or trailing newline was refused although both are perfectly valid.
  //
  // Returns the NORMALISED url rather than a verdict, and the caller publishes that. Being
  // tolerant about how a value was pasted while publishing the raw string would be tolerance
  // in one direction only: `  https://…  ` would pass the gate and then ship inside the OCI
  // label and `<repo>/tree/<sha>` with the padding still in it.
  let url

  try {
    url = new URL((repository ?? '').trim())
  } catch {
    return null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null
  }
  // `new URL` rejects a missing authority outright, but `https:///x` parses with the path
  // read as the host — so this is about that shape, not about an empty string.
  if (!url.hostname || url.username || url.password) {
    return null
  }
  // A query or fragment cannot survive `<repo>/tree/<sha>` being appended.
  if (url.search || url.hash) {
    return null
  }
  if (/\.git\/*$/i.test(url.pathname)) {
    return null
  }

  return url.href.replace(/\/+$/, '')
}

/** The same rule as a verdict, for callers that only need to ask. */
export const isPublicSourceUrl = (repository) => publicSourceUrl(repository) !== null

export const imageRefFor = ({ registry, name, tag }) =>
  `${registry ? `${registry.replace(/\/+$/, '')}/` : ''}${name}:${tag}`

/** The COMMIT a published tag names, out of `git ls-remote` output.
 *
 *  An annotated tag is an object of its own, so the plain `refs/tags/<tag>` line
 *  carries the TAG object's sha — comparing that to a local commit sha always
 *  differs. The commit is on the peeled `refs/tags/<tag>^{}` line, and git only
 *  emits it when the ref pattern matches it too: querying both exact patterns is
 *  what makes it appear. (A glob would also work, but `refs/tags/v0.1.0*` drags in
 *  `v0.1.0-rc.1` and friends.) A lightweight tag has no peeled line and its single
 *  line already points at the commit. */
export const publishedTagCommitFrom = (stdout, tag) => {
  const wanted = new Map()

  for (const line of stdout.split('\n')) {
    const [sha, ref] = line.split(/\s+/)

    if (sha && ref) {
      wanted.set(ref, sha)
    }
  }

  return wanted.get(`refs/tags/${tag}^{}`) ?? wanted.get(`refs/tags/${tag}`) ?? null
}

/** Paths out of `git status --porcelain`. The status field is a fixed two columns
 *  plus a space, and the FIRST column is blank for a not-yet-staged change — so the
 *  raw output must reach here untrimmed, or ` M path` becomes `M path` and every
 *  path in the report silently loses its first character. */
export const dirtyPathsFrom = (porcelain) =>
  porcelain
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))

/** Reads the Changelog the way a reader does: is there a dated section for this
 *  version, and is anything still parked under [Unreleased]. */
export const changelogEntryFor = (changelog, version) => {
  const released = RELEASED_SECTION(version).exec(changelog)
  const unreleased = /^## \[Unreleased\]\s*$([\s\S]*?)(?=^## \[|$(?![\s\S]))/m.exec(changelog)

  return {
    released: Boolean(released),
    date: released?.[1] ?? null,
    unreleasedFilled: Boolean(unreleased && unreleased[1].trim().length > 0),
  }
}

/** Reasons this tree may not be released, in the order a human would want them.
 *  Everything here is fail-closed by construction: an empty array is the ONLY
 *  way to proceed, so a check that could not run counts as a blocker, not a pass. */
export const releaseBlockers = ({
  version,
  dirtyPaths,
  tagExists,
  tagCommit,
  headCommit,
  changelog,
  publishedTagCommit,
  prerelease,
}) => {
  const blockers = []

  if (!parseProductVersion(version)) {
    blockers.push(`version "${version}" is not a clean x.y.z`)
  }

  // The build context is exported from the tag, so uncommitted work could never
  // reach the image anyway — the refusal is about the operator's mental model:
  // releasing while the tree says something else is how you ship what you did not
  // review.
  if (dirtyPaths.length) {
    blockers.push(
      `working tree is not clean (${dirtyPaths.length} path(s)): ${dirtyPaths.slice(0, 5).join(', ')}`,
    )
  }

  // The Changelog demands belong to a RELEASE only. A pre-release is cut from a
  // tree with work in flight — that is what makes it a pre-release — so holding it
  // to "nothing pending under [Unreleased]" would make it publishable only in the
  // instant after a release was cut, i.e. never when you actually want one.
  if (!prerelease) {
    const changelogEntry = changelogEntryFor(changelog, version)

    if (!changelogEntry.released) {
      blockers.push(
        `CHANGELOG has no dated "## [${version}] — YYYY-MM-DD" section (an [Unreleased] heap is not a release)`,
      )
    }
    if (changelogEntry.unreleasedFilled) {
      blockers.push(
        'CHANGELOG still carries a non-empty [Unreleased] section — fold it into the release being cut',
      )
    }

    // A pre-release deliberately has no tag and no published source.
    //
    // The tag's SHAPE is not checked, only where it points. An annotated tag would
    // carry a tagger and a message, and neither is load-bearing here: nothing in this
    // repository reads them (no `git describe`, no `--follow-tags`, no signature
    // verification), the tagger is the same person as the commit author, and the date
    // a release was declared is already recorded by the image's `builtAt` and the
    // Changelog section. What actually makes a release traceable is below and in the
    // registry gate — the tag names HEAD, the same commit is readable in the public
    // repository, and the version tag is still free. Demanding an annotation on top
    // bought nothing and failed late: a tag cut through a web UI with an empty message
    // is lightweight, so the refusal landed after the whole gate had run and someone
    // had already pressed publish.
    if (!tagExists) {
      blockers.push(`tag ${releaseTagFor(version)} does not exist — cut it before building`)
    } else if (tagCommit !== headCommit) {
      blockers.push(
        `HEAD (${headCommit?.slice(0, 12)}) is not ${releaseTagFor(version)} (${tagCommit?.slice(0, 12)})`,
      )
    }

    if (publishedTagCommit === null) {
      blockers.push(
        `tag ${releaseTagFor(version)} is not published on the source repository — the image must point at source people can actually read`,
      )
    } else if (publishedTagCommit !== undefined && publishedTagCommit !== tagCommit) {
      blockers.push(
        `published ${releaseTagFor(version)} (${publishedTagCommit.slice(0, 12)}) differs from the local tag (${tagCommit?.slice(0, 12)})`,
      )
    }
  }

  return blockers
}

/** Which release a pre-release precedes.
 *
 *  The manifests hold the LAST cut version, so between releases `X.Y.Z` names
 *  something already published — and `X.Y.Z-rc.N` would then SemVer-order below
 *  a release whose code it actually supersedes, telling every version-sorting tool
 *  that upgrading to `X.Y.Z` is a step forward when it is a downgrade. So a
 *  pre-release attaches to the next unreleased patch instead.
 *
 *  `releasePublished` is deliberately three-valued: `true`/`false` from the
 *  registry, and `null` when the registry could not answer — which resolves the
 *  same way as `true`, because naming an unreleased version is a mild
 *  inconvenience while naming a published one is a lie about ordering. */
export const prereleaseBaseVersion = ({ version, releasePublished }) => {
  if (releasePublished === false) {
    return version
  }
  const next = bumpProductVersion(version, 'patch')

  if (!next) {
    throw new Error(
      `cannot derive a pre-release base from product version ${JSON.stringify(version)}`,
    )
  }

  return next
}

/** Turn the pending `[Unreleased]` section into a dated release section, leaving a
 *  fresh empty `[Unreleased]` above it. Returns null when there is nothing to
 *  release — an empty section is not a release, and neither is a version that
 *  already has one.
 *
 *  The heading match is `[ \t]*$` and NOT `\s*$`: the latter also swallows the
 *  blank line below the heading, gluing the new version heading onto the first
 *  `### Added`. */
export const foldUnreleased = (changelog, version, date) => {
  const section = /^## \[Unreleased\][ \t]*$([\s\S]*?)(?=^## \[|$(?![\s\S]))/m.exec(changelog)

  if (!section) {
    return { changelog: null, reason: 'CHANGELOG.md has no "## [Unreleased]" section to fold' }
  }
  if (!section[1].trim()) {
    return {
      changelog: null,
      reason:
        'CHANGELOG.md has nothing under [Unreleased] — write the entry before cutting a release',
    }
  }
  if (new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(changelog)) {
    return { changelog: null, reason: `CHANGELOG.md already has a [${version}] section` }
  }

  return {
    changelog: changelog.replace(
      /^## \[Unreleased\][ \t]*$/m,
      `## [Unreleased]\n\n## [${version}] — ${date}`,
    ),
    reason: null,
  }
}

/** The identity a released image must carry, in one place: the build args that
 *  bake it into the bundle, the labels that expose it to `docker inspect`, and
 *  the values the smoke then demands back. */
export const releaseIdentity = ({ version, revision, builtAt, sourceRepository }) => {
  const shortCommit = revision.slice(0, 7)
  const source = sourceUrlFor(sourceRepository, revision)

  return {
    version,
    revision,
    shortCommit,
    builtAt,
    source,
    sourceRepository,
    buildArgs: {
      GIT_SHA: shortCommit,
      BUILD_TIME: builtAt,
      SOURCE_URL: source,
      VERSION: version,
      GIT_REVISION: revision,
      SOURCE_REPO: sourceRepository,
    },
    labels: {
      'org.opencontainers.image.version': version,
      'org.opencontainers.image.revision': revision,
      'org.opencontainers.image.created': builtAt,
      'org.opencontainers.image.source': sourceRepository,
      'org.opencontainers.image.licenses': 'AGPL-3.0-only',
    },
    // What `notarium version --json` must answer from inside the built image.
    build: { version, commit: shortCommit, builtAt, source },
  }
}

/** Differences between what the image claims and what the release intended.
 *  Non-empty ⇒ the artifact does not match its own release record, and no amount
 *  of "it boots fine" makes that publishable. */
export const identityMismatches = ({ expected, reportedBuild, actualLabels, reporter }) => {
  const mismatches = []

  for (const [key, want] of Object.entries(expected.build)) {
    const got = reportedBuild?.[key] ?? null

    if (got !== want) {
      mismatches.push(
        `${reporter ?? 'notarium version --json'}: ${key} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
      )
    }
  }

  for (const [label, want] of Object.entries(expected.labels)) {
    const got = actualLabels?.[label] ?? null

    if (got !== want) {
      mismatches.push(`label ${label} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
    }
  }

  return mismatches
}

/** SemVer ordering, enough of it for release decisions.
 *
 *  The release side is always `x.y.z`, but the OTHER side is whatever is published
 *  under `:latest` — which can be a `x.y.z-rc.N` pre-release if one was ever
 *  pointed there. Feeding that to a bare `Number()` compare yields NaN on both
 *  sides, and NaN !== NaN made the comparison return -1 for ANY pair: a decision
 *  that looked like the forward-only rule but was noise. So: compare the numeric
 *  core, then rank a pre-release below the release it precedes (SemVer §11).
 *
 *  Pre-release identifiers are compared the way §11 says and NOT lexically, because
 *  the whole point of `-rc.N` is that candidates are ordered: `rc.10` sorts BELOW
 *  `rc.9` as a string, so a lexical fallback would report the newest candidate as
 *  the older one from the tenth onwards — silently, in the rule that decides whether
 *  `:latest` may move. */
export const compareVersions = (a, b) => {
  const parse = (version) => {
    const [core, ...pre] = version.split('-')
    return { core: core.split('.').map(Number), pre: pre.join('-') }
  }
  const left = parse(a)
  const right = parse(b)

  for (let i = 0; i < 3; i += 1) {
    const l = Number.isFinite(left.core[i]) ? left.core[i] : 0
    const r = Number.isFinite(right.core[i]) ? right.core[i] : 0

    if (l !== r) {
      return l > r ? 1 : -1
    }
  }

  if (left.pre === right.pre) {
    return 0
  }
  // A pre-release is lower than its release.
  if (!left.pre) {
    return 1
  }
  if (!right.pre) {
    return -1
  }

  return comparePrerelease(left.pre, right.pre)
}

/** SemVer §11.4: dot-separated identifiers, compared one by one. Numeric ones
 *  compare numerically, non-numeric ones lexically, and a numeric identifier always
 *  ranks below a non-numeric one. A longer identifier list wins when everything
 *  before it is equal. */
const comparePrerelease = (a, b) => {
  const left = a.split('.')
  const right = b.split('.')

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] === undefined) {
      return -1
    }
    if (right[i] === undefined) {
      return 1
    }
    if (left[i] === right[i]) {
      continue
    }
    const numeric = /^\d+$/

    if (numeric.test(left[i]) && numeric.test(right[i])) {
      return Number(left[i]) > Number(right[i]) ? 1 : -1
    }
    if (numeric.test(left[i])) {
      return -1
    }
    if (numeric.test(right[i])) {
      return 1
    }

    return left[i] > right[i] ? 1 : -1
  }

  return 0
}

/** The number of the candidate being cut: the first one this registry does not
 *  already hold.
 *
 *  A counter has to live somewhere, and the registry is the only party that knows
 *  what was actually published — which is exactly what a candidate number must not
 *  collide with. (The `-rc.<sha>` form it replaces needed no counter, but bought
 *  that with candidates that SemVer orders alphabetically, i.e. at random.)
 *
 *  `probe` answers 'present' | 'absent' | 'unknown' for a full version string.
 *  'unknown' is fatal rather than "assume free": a registry that will not say what
 *  it holds cannot be counted against, and guessing means republishing a candidate
 *  someone already pulled. `blind` is the caller's explicit statement that the
 *  repository does not exist yet (`--first-publication`), where there is nothing to
 *  count and 1 is the only answer. */
export const firstFreePrerelease = ({ base, probe, blind = false, limit = 100 }) => {
  if (blind) {
    return `${base}-rc.1`
  }

  for (let n = 1; n <= limit; n += 1) {
    const version = `${base}-rc.${n}`
    const presence = probe(version)

    if (presence === 'absent') {
      return version
    }
    if (presence === 'unknown') {
      throw new Error(
        `cannot determine whether ${version} already exists — log in to the registry, or fix connectivity. Refusing to guess a candidate number.`,
      )
    }
  }

  throw new Error(`${base} already has ${limit} published candidates — cut the release instead`)
}

/** The version an already-published image declares, read out of the labels that
 *  `docker buildx imagetools inspect --format '{{json .Image}}'` prints. A
 *  multi-platform tag yields a map keyed by platform; a single manifest yields the
 *  config object directly — accept both rather than assuming today's build shape.
 *  Returns null when the image carries no version label (anything published before
 *  this flow, or by a bare `docker build`). */
export const imageVersionFromInspect = (raw, platform) => {
  let parsed

  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const configs = parsed?.config
    ? [parsed]
    : Object.entries(parsed ?? {})
        .filter(([key]) => !platform || key === platform || !key.includes('/'))
        .map(([, value]) => value)

  for (const entry of configs) {
    const version = entry?.config?.Labels?.['org.opencontainers.image.version']

    if (version) {
      return version
    }
  }

  return null
}

/** May `latest` be moved onto this release?
 *
 *  `latest` means "the newest good build", so moving it BACKWARDS — a backport
 *  published after a bigger version — quietly downgrades everyone who pulls it.
 *  That is a real ordering decision, not an accident, so it needs `--force-latest`
 *  rather than a silent overwrite. The flag belongs on the release run itself: the
 *  reasons below deliberately do NOT suggest it, because by the time one is printed
 *  the version tag is published and a re-run dies on the immutability gate. Same for an unreadable answer: if we cannot see
 *  what `latest` currently points at, we do not overwrite it blind. */
// `firstPublication` is deliberately NOT a parameter: callers may pass it, and it
// must change nothing here (see the unknown-presence branch below).
export const latestMoveDecision = ({ presence, publishedVersion, version, force }) => {
  if (force) {
    return { move: true, reason: null }
  }
  if (presence === 'absent') {
    return { move: true, reason: null }
  }
  // NOT widened by --first-publication: that flag says "the repository may not
  // exist yet", and by the time `latest` is considered the version tag has just
  // been pushed — so the repository demonstrably exists and an unreadable answer
  // means something else. Overriding this one is what --force-latest is for.
  if (presence === 'unknown') {
    return {
      move: false,
      reason: 'cannot read what :latest currently points at — refusing to move it blind',
    }
  }
  if (!publishedVersion) {
    return {
      move: false,
      reason:
        'no readable version label on the published :latest (either it predates this release flow or the registry read failed), so it cannot be compared with this release',
    }
  }

  const ordering = compareVersions(version, publishedVersion)

  if (ordering > 0) {
    return { move: true, reason: null }
  }

  return {
    move: false,
    reason: `:latest already points at ${publishedVersion}, which is ${ordering === 0 ? 'the same version' : 'newer than'} ${version} — moving it would downgrade every plain \`docker pull\``,
  }
}

/** What a registry's answer to "does this tag exist" actually told us. An error
 *  we cannot read is `unknown`, NOT absence: pushing over a tag we merely failed
 *  to look up is exactly the immutability break this gate exists to prevent. */
export const tagPresence = ({ ok, stderr }) => {
  if (ok) {
    return 'present'
  }

  const text = (stderr || '').toLowerCase()
  const absent = [
    'manifest unknown',
    'no such manifest',
    'not found',
    'manifest_unknown',
    'repository name not known',
    'name unknown',
    'no tags available',
  ]

  return absent.some((needle) => text.includes(needle)) ? 'absent' : 'unknown'
}
