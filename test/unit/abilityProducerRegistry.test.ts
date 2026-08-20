/**
 * The register of single producers in the Ability domain, held against the SYNTAX of
 * the source.
 *
 * WHY A REGISTER AT ALL: three review rounds in a row found the same shape of defect —
 * a rule given one producer, swept at the sites the reviewer happened to name, and
 * left spelled out at one more. Every time the fix was correct and the class stayed
 * open, because "is this class closed?" was answered by reading. Once the surviving
 * copy was written by the very commit that introduced the producer. Nothing turned red
 * at any layer, including the browser gate.
 *
 * WHY TWO FORMS, AND WHY THESE. Round 6 broke the previous register with eighteen
 * ordinary rewrites, so the form changed rather than the ingredients:
 *
 *  1. A SPELLING register — "nothing else authors this rule" — matched over parsed
 *     nodes instead of file text. A node does not care whether the call had a space
 *     before its paren, whether prettier wrapped it, in which order the fields were
 *     written, whether they were shorthand, single- or double-quoted, spelled
 *     `ABILITY_SOURCE.owned` or `'owned'`, reached through `a['projectIds']`, or
 *     parked in a local first. Nor does a parser have the text stripper's blind
 *     zones: a string literal containing a comment opener used to swallow the 84
 *     lines that followed it, and three such literals are live in the tree today.
 *  2. A CALL register — "this producer is asked from exactly these places". This is
 *     the half a spelling scan cannot do in principle: it sees a second author, never
 *     a MISSING call. A door that quietly stops asking `contextRoleSummaryOf` leaves
 *     no ingredient behind to find, and reddens here instead.
 *
 * Both are needed because the two defects are two halves of one class: an answer
 * given twice, and an answer not asked for.
 *
 * WHY EVERY RULE CARRIES A FIXTURE. The previous register held a rule whose ingredient
 * was the name of a constant deleted by this same branch: it found nothing, passed
 * identically forever, and said nothing while a fourth definition of that same domain
 * sat in the tree. So each rule here must redden on a second spelling supplied inline
 * (`secondSpelling`) and stay quiet on the honest neighbours that live next to it
 * (`neighbours`). A rule whose matcher has gone stale fails on its own fixture rather
 * than passing on an empty set — vacuity is not reachable.
 *
 * WHAT THIS REGISTER IS — and the wording is deliberate, because two review rounds
 * were spent on the question and the honest answer is smaller than it looks.
 *
 * It is a TOMBSTONE over SPELLINGS, and it claims exactly them: the forms listed in
 * `REWRITES` are closed, each one asserted with the flag saying whether it is caught.
 * It does NOT claim to close a kind of defect, and the word for that is deliberately
 * absent here: a syntactic register can only ever catch up with the rewriting that has
 * already happened. The previous one was rewritten around eighteen ways in one round;
 * this one, in AST form, was rewritten around sixteen more in the next. Where the rule
 * can be held by a TYPE instead — one export, an import boundary, so a second author
 * does not compile — it is held there, and this file is not the guard. Where it cannot,
 * this file records what is closed and what is open, and the `caught: false` rows are
 * as much of the point as the `caught: true` ones.
 *
 * It is also not an inventory of producers. An obligation to register every new
 * function would be enforced by nothing, forgotten once, and quietly false while
 * looking complete. What every entry here does promise is the two things a test can
 * hold: the rule reddens on a second spelling (its fixture), and the producer is asked
 * from exactly the places named (its call register).
 *
 * WHAT IT DOES NOT COVER, and each of these is a limit rather than an omission:
 *
 *  - `can(…)` and the purge fence. Those are not reinvented by being written twice,
 *    they are lost by not being called at a new door, and neither form above can see a
 *    call that was never written anywhere. Coverage for them is a different genre and
 *    lives in `abilityAuthzCoverage.test.ts`.
 *  - A second author INSIDE a door the call register has declared. `askedFrom` answers
 *    "is this producer still asked here", and a hand-built copy next to the call is not
 *    a missing call — it is a second spelling, and the spelling half of that rule does
 *    not exist for every producer listed below. Where it matters most (`me.ts#meRoutes`
 *    holds one of the two context doors) the copy would sit inside a 1 900-line file
 *    whose whole route table is one symbol.
 *  - `what is a package address` currently matches nothing in the tree, and that is
 *    the honest state rather than a healthy one: the domain has exactly one predicate
 *    (`isGeneratedNoteId`) plus its wire mirror, and the mirror is stated by NAME, so
 *    there is nothing for a shape matcher to find. It earns its place through its
 *    fixture — it still reddens on a second spelling supplied inline — and it will find
 *    a live site the moment one appears. Read it as a tripwire, not as evidence.
 *
 * Form follows `pgTransactionRegistry.test.ts` and `enumDrift.test.ts`: a structural
 * invariant nothing at compile time can hold, asserted over the sources themselves.
 */
import { describe, expect, it } from 'vitest'

import {
  addressedLocatorLiterals,
  callSitesOf,
  childDirectories,
  hasDirectory,
  type Matcher,
  matchesSnippet,
  packageAddressDomains,
  placementBrandForgeries,
  reachSpellings,
  readSurface,
  type ScannedFile,
  sitesOf,
  skillNameDomains,
} from './helpers/abilityProducerScan'

// ---------------------------------------------------------------------------
// The surface. Closed over the tree: every sibling is either scanned or declared
// unscanned with its reason, and a new one reddens until it is classified.
// ---------------------------------------------------------------------------

/** `packages/<name>/src`, with the count below which the scan has been narrowed
 *  rather than the code deleted. Floors matter: the previous register guarded a
 *  1153-file scan with `> 500`, and `web` alone carries 577 — the surface could have
 *  been cut to one package without the guard noticing. */
const SCANNED_PACKAGES: Readonly<Record<string, number>> = {
  cli: 5,
  contract: 55,
  core: 140,
  engine: 25,
  'engine-memory': 3,
  server: 280,
  web: 500,
}

const UNSCANNED_PACKAGES: Readonly<Record<string, string>> = {
  desktop: 'a packaging shell with no source tree in this checkout — asserted below',
  'engine-vector': 'an optional-profile stub with no source tree — asserted below',
}

/** Roots outside `packages`. Both halves of the seed system are here: they run
 *  against a REAL server, so a rule spelled out in them is production code that no
 *  test double reconciles. `scripts/seed.ts` held a hand-minted locator while the fix
 *  phase replaced the same mint in two neighbouring files, in the same commit.
 *
 *  Limit, stated: the walk reads `.ts`/`.tsx` only, so the `.mjs` half of `scripts/`
 *  (release, doctor, licences) is outside it. Those build the artifact rather than
 *  seed a server, and none of them addresses an ability today. */
const SCANNED_ROOTS: Readonly<Record<string, number>> = {
  scripts: 10,
  'test/cases': 60,
}

/** Everything else under `test/`, each with the reason it is not scanned. */
const UNSCANNED_TEST_DIRECTORIES: Readonly<Record<string, string>> = {
  backup: 'backup-format fixtures: archive bytes, no ability domain',
  demo: 'screenshot scripting for the marketing shots, driven through the UI',
  e2e: 'Playwright specs and their page helpers, on a separate runner',
  'e2e-real': 'Playwright against a real seeded stand, same separate runner',
  'fake-server':
    'a deliberate independent twin of the WIRE; a second implementation of the wire is its job, and the conformance suite reconciles it against the real one. That argument does not extend to a domain PREDICATE, and it was stretched that far once: the twin held its own copy of the skill-name grammar, missing the length half, so it and the real library disagreed about a 65-character name while every conformance case passed. Predicates there ask their producer now — closed by the import, which is why this directory can stay out of the scan',
  fixtures: 'static input data',
  integration: 'test bodies against a live Postgres',
  'meta-db-contract':
    'driver contract bodies: a locator is opaque INPUT there, spelled to prove the driver stores and returns it',
  release: 'release-artifact checks',
  'role-library-contract': 'library contract bodies, same reason as the meta-DB ones',
  'store-contract': 'store contract bodies, same reason',
  unit: 'unit test bodies — including this register and the helper that runs it',
  visual: 'Playwright screenshot specs, separate runner',
}

const ROOTS: readonly string[] = [
  ...Object.keys(SCANNED_PACKAGES).map((name) => `packages/${name}/src`),
  ...Object.keys(SCANNED_ROOTS),
]

const FLOORS: Readonly<Record<string, number>> = {
  ...Object.fromEntries(
    Object.entries(SCANNED_PACKAGES).map(([name, floor]) => [`packages/${name}/src`, floor]),
  ),
  ...SCANNED_ROOTS,
}

/** The files that carry the rules today. A scan that lost any of them found nothing
 *  to say about the domain, whatever its total. */
const ANCHORS: readonly string[] = [
  'packages/contract/src/schemas/rest/agent/abilities.ts',
  'packages/core/src/libs/abilityLocator/abilityLocator.ts',
  'packages/server/src/services/roles/roles.ts',
  'packages/server/src/apps/server/routes/wire.ts',
  'packages/web/src/libs/abilityDraftStorage/abilityDraftStorage.ts',
  'packages/web/src/pages/AgentsPage/AbilityEditorSurface.tsx',
  'scripts/seed.ts',
  'test/cases/applyAbilityPreferences.ts',
]

// ---------------------------------------------------------------------------
// The spelling register
// ---------------------------------------------------------------------------

type SpellingRule = {
  /** What the rule answers, in the words the docblocks use. */
  readonly rule: string
  /** Who owns the answer. */
  readonly producer: string
  readonly find: Matcher
  /** A real second spelling. The rule MUST match it — this is what makes the rule
   *  impossible to leave vacuous. */
  readonly secondSpelling: string
  /** Shapes that live next to the rule and are not it. A gate that flags an honest
   *  neighbour teaches the next reader to widen the allow-list. */
  readonly neighbours: readonly string[]
  /** `<file>#<enclosing symbol>` → why this one is not a copy. Granularity is the
   *  SYMBOL, not the file: the copy that got through the previous register was inside
   *  the producer's own file. */
  readonly allowed: Readonly<Record<string, string>>
  /** How many times a declared place states the rule, where that is legitimately more
   *  than once. Absent means exactly one — an allowance is for A spelling, never for a
   *  symbol's whole body. */
  readonly repeats?: Readonly<Record<string, number>>
}

const RULES: readonly SpellingRule[] = [
  {
    rule: 'does an ability’s reach cover this project',
    producer: 'abilityReachesProject → availabilityCovers (server/services/roles/roles.ts)',
    find: reachSpellings,
    secondSpelling: `
      const covers = (availability: A, projectId: string): boolean =>
        availability.mode === 'all-projects' || availability.projectIds.includes(projectId)
    `,
    neighbours: [
      // Validating that every declared project belongs to the home space: a search
      // over the list, not a question about one project.
      `const missing = projectIds.find((id) => !found.has(id))`,
      // Dropping rows whose project moved to another space.
      `const kept = record.projectIds.filter((_, index) => homes[index] === record.homeSpace)`,
      // Comparing two reaches for equality, as the editor does before saving.
      `
        const covered = new Set(left.projectIds)
        const next = new Set(right.projectIds)
        const same = covered.size === next.size && [...next].every((id) => covered.has(id))
      `,
    ],
    allowed: {
      'packages/server/src/services/roles/roles.ts#availabilityCovers':
        'the producer: the membership half of the rule, under abilityReachesProject, which adds the per-kind default an absent row carries',
      'packages/web/src/pages/AgentsPage/AbilityEditorSurface.tsx#eligibleSkills':
        'DEBT: a second author of the rule, and the browser has no way to stop being one — `abilityReachesProject` lives in `packages/server`, which `web` cannot import. It restates both halves: the all-projects mode test and the membership. The kind-asymmetric default agrees with the service here only because this door asks about SKILLS; the same shape asked about a role would answer the opposite of the server. Fix is a move of the rule into `core`, not an edit here.',
    },
  },
  {
    rule: 'which address does this placement answer to',
    producer: 'ownedRoleLocator / ownedSkillLocator (server/services/roles/roles.ts)',
    find: addressedLocatorLiterals,
    secondSpelling: `
      const target = {
        source: 'owned',
        kind: 'role',
        packageId: published.packageId,
        location: { scope: 'project', spaceId: placement.space, projectId: placement.projectId },
      }
    `,
    neighbours: [
      // An ability IDENTITY carries no placement — a different rule, with its own
      // producers, and flagging it here would put four honest sites in the register.
      `const locator = { source: 'system', kind: 'skill', packageId: link.packageId }`,
      // A view assembled from a locator the producer already minted.
      `const facts = { ...status.role.role, locator, ...own }`,
      // The placement itself, without the address around it.
      `const home = { scope: ROLE_SCOPE.space, spaceId: location.space }`,
    ],
    allowed: {
      'packages/contract/src/schemas/rest/agent/abilities.ts#OwnedRoleAbilityLocatorSchema':
        'the wire’s own declaration of the shape — the thing the producer is checked against, not a second author of it',
      'packages/contract/src/schemas/rest/agent/abilities.ts#OwnedSkillAbilityLocatorSchema':
        'the same, for the skill arm',
      'packages/core/src/libs/abilityLocator/abilityLocator.ts#serializeAbilityLocator':
        'the canonical serializer: every field is read off the locator it was handed, in a fixed order for cache keys — it re-states an address, it cannot invent one',
      'packages/server/src/services/roles/roles.ts#ownedRoleLocator': 'the producer, role arm',
      'packages/server/src/services/roles/roles.ts#ownedSkillLocator': 'the producer, skill arm',
    },
  },
  {
    rule: 'what is a package address',
    producer: 'isGeneratedNoteId (core/libs/id), mirrored by AbilityPackageIdSchema',
    find: packageAddressDomains,
    secondSpelling: `const ok = (locator: L) => scalar(locator.packageId, 128)`,
    neighbours: [
      // Carrying the address, not defining it.
      `const key = { packageId: locator.packageId, source: locator.source, kind: locator.kind }`,
      // A capture index is not a length bound.
      `const parsed = { packageId: match[2]!, source: 'system', kind: 'skill' }`,
      // The wire states the domain by NAMING the schema.
      `const Schema = z.object({ packageId: AbilityPackageIdSchema, kind: KindSchema })`,
      // The domain predicate itself.
      `const valid = (packageId: string) => isGeneratedNoteId(packageId)`,
    ],
    allowed: {},
  },
  {
    rule: 'what a skill may be called',
    producer: 'isSkillName (core/libs/markdown/documentState/skillLinks.ts)',
    find: skillNameDomains,
    secondSpelling: `const ok = (name: string) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)`,
    neighbours: [
      // A package ADDRESS, not a name: different alphabet, different owner.
      `const generated = /^[A-Za-z0-9_-]{12}$/.test(packageId)`,
      // The attachment token's own syntax, which contains a skill name but is not one.
      `const token = /\\[\\[([^\\]\\r\\n]{1,1020})\\]\\]/gu`,
      // A length with no alphabet is not this rule, by construction.
      `const short = label.length <= 64`,
    ],
    allowed: {
      'packages/core/src/libs/markdown/documentState/skillLinks.ts#SKILL_NAME':
        'the producer: the pattern half of `isSkillName`, stated next to the length half it owns',
      'packages/contract/src/schemas/rest/_fields.ts#SkillNameSchema':
        'the wire mirror. P8 keeps core and contract decoupled, so the rule is stated twice on purpose — and the two copies are held together by the drift arc in `test/enumDrift.test.ts`, not by being one file',
      'packages/contract/src/schemas/rest/auth.ts#UsernameSchema':
        'a USERNAME. The same slug alphabet, a different domain and a different owner: nothing about a skill follows from it, and folding the two would make one rule answer for both',
    },
  },
  {
    rule: 'which placements did the service DERIVE',
    producer: 'addressed (server/services/roles/roles.ts) — the only mint of the brand',
    find: placementBrandForgeries,
    secondSpelling: `const home = { scope: 'project', space, projectId } as AddressedProjectPlacement`,
    neighbours: [
      `const location = value as RoleLocation`,
      `const parsed = JSON.parse(text) as OwnedAbilityLocator`,
    ],
    allowed: {
      'packages/server/src/services/roles/roles.ts#addressed':
        'the mint itself: the one place the brand is produced, guarded by the call register below',
      'packages/server/src/services/roles/roles.ts#homeOf':
        'narrows an ALREADY addressed placement to its home, so it re-states the brand it was given rather than forging one',
      'packages/server/src/services/roles/roles.ts#projectIn':
        'a project OF an addressed home, derived through `addressed`; the cast only adds `projectId` to a brand already there',
      'packages/server/src/services/roles/roles.ts#projectPlacement':
        'a type narrowing of an addressed placement that already carries `projectId` — no new brand',
    },
  },
]

/** The brand is the compiler's ONLY statement that a placement was derived by the
 *  service rather than handed in by a client, and any file in the package can forge it
 *  with one cast without reddening a single layer. The count is asserted next to the
 *  addresses because "four casts, all in the locator seam" is the claim. */
const BRAND_FORGERY_COUNT = 4

// ---------------------------------------------------------------------------
// The call register
// ---------------------------------------------------------------------------

type CallRegister = {
  readonly producer: string
  /** Why a missing call is a defect rather than a refactor. */
  readonly why: string
  /** `<file>#<enclosing symbol>` → what that place is. */
  readonly askedFrom: Readonly<Record<string, string>>
}

const CALL_REGISTERS: readonly CallRegister[] = [
  {
    producer: 'addressed',
    why: 'the mint of the addressed-placement brand. Its own docblock claims it is called from exactly three kinds of place and nowhere else; that claim was prose until here. A new caller is a new way for a client-named placement to acquire the brand that says the service derived it.',
    askedFrom: {
      'packages/server/src/services/roles/roles.ts#locationsFor':
        'the effective chain: the placements a CONTEXT reaches',
      'packages/server/src/services/roles/roles.ts#ownedPlacementOf':
        'the locator seam: the one answer for a client address',
      'packages/server/src/services/roles/roles.ts#spaceRootOf': 'a Space’s own package root',
      'packages/server/src/services/roles/roles.ts#homeOf': 'derives a home from an addressed one',
      'packages/server/src/services/roles/roles.ts#projectIn':
        'derives a project of an addressed home',
      'packages/server/src/services/roles/roles.ts#addFromCatalog':
        'an entry reached by ENUMERATING a home the caller was already granted',
      'packages/server/src/services/roles/roles.ts#createCustomRole': 'the same boundary, stated',
    },
  },
  {
    producer: 'abilityReachesProject',
    why: 'the reach rule, including the per-kind default an absent row carries. A door that stops asking answers reach itself, and the transport already did that once — kind-blind, reading an absent row as "everywhere" for a skill.',
    askedFrom: {
      'packages/server/src/apps/server/routes/wire.ts#abilityReaches':
        'the transport, labelling a library card',
      'packages/server/src/apps/server/routes/auth/me.ts#ownedRoleCandidate':
        'the skill arm of the candidate list',
      'packages/server/src/services/roles/roles.ts#coversProject':
        'the role arm, inside the service',
      'packages/server/src/services/roles/roles.ts#skillReaches':
        'the skill arm, inside the service',
    },
  },
  {
    producer: 'contextRoleSummaryOf',
    why: 'an Owned, enabled Role as the Context constructor sees it. Two routes built the same literal by hand and neither carried `source`, so the moment the wire type became a union on it both answers failed their own response validation. Written by the fix phase of round 5 and guarded by nothing until now.',
    askedFrom: {
      'packages/server/src/apps/server/routes/auth/me.ts#meRoutes':
        'the agent-context door, asked without a project',
      'packages/server/src/apps/server/routes/projects/projects.ts#projectsRoutes':
        'the project door, asked with one — the arm that narrows by reach',
    },
  },
  {
    producer: 'homeOf',
    why: 'where a role’s dependencies live, and which package a project version OVERRIDES — one question, two names for it. Asking `spaceRootOf` instead is how the same server said "this is a version of that role" in its listing and "this has no base" in its detail.',
    askedFrom: {
      'packages/server/src/services/roles/roles.ts#serializedAttachmentAt':
        'the home an attachment is serialized against',
      'packages/server/src/services/roles/roles.ts#linkedAt':
        'the home a linked skill is loaded from',
      'packages/server/src/services/roles/roles.ts#healthForRole':
        'the home a dependency’s health is read in',
      'packages/server/src/services/roles/roles.ts#describeAbility': 'the detail door',
      'packages/server/src/services/roles/roles.ts#findRoleBase': 'the base of a project version',
      'packages/server/src/services/roles/roles.ts#loadSavedRole': 'the saved-role loader',
      'packages/server/src/services/roles/roles.ts#addFromCatalog':
        'the home a catalog fork lands in',
    },
  },
  {
    producer: 'entryHealth',
    why: 'the SOUNDNESS half of "may this role be used" — the half that reads the packages it depends on. Resume applies both halves; a door that applies only the other one activates a role whose dependencies are missing, disabled or the wrong kind.',
    askedFrom: {
      'packages/server/src/services/roles/roles.ts#addressedRoleStatus':
        'the addressed status door',
      'packages/server/src/services/roles/roles.ts#loadEffectiveEntry': 'the effective loader',
      'packages/server/src/services/roles/roles.ts#resolveSavedRole': 'the saved-role resolver',
    },
  },
  {
    producer: 'isSkillName',
    why: 'what a skill may be called, LENGTH included. The package projection, both arms of the attachment parser and the serializer all ask the same question, and three of the four used to answer it without the bound — which is how a hand-edited package produced an attachment the wire refused and the detail door answered 500.',
    askedFrom: {
      'packages/core/src/libs/markdown/documentState/documentState.ts#skillProjection':
        'the package projection: may this package be called that',
      'packages/core/src/libs/markdown/documentState/skillLinks.ts#parseSkillLinks':
        'both arms of the parser: the bare name, and the label inside an exact locator',
      'packages/core/src/libs/markdown/documentState/skillLinks.ts#serializeSkillLocator':
        'the write side, refusing to mint a token nothing may read back',
      'packages/server/src/services/roles/library.ts#validateSkillPackage':
        'the package write chokepoint: a directory is a generated id or a name',
      'packages/server/src/services/roles/library.ts#readPackagesFromDirectory':
        'the on-disk scan, deciding which directories are packages at all',
      'packages/server/src/services/roles/library.ts#getSkill': 'a lookup by name',
      'packages/server/src/services/roles/library.ts#exists': 'the same, asked as a predicate',
      'packages/server/src/services/roles/library.ts#get': 'the same, on the role arm',
      'packages/server/src/services/roles/library.ts#nameableManifest':
        'the in-memory twin, which must accept exactly what the real library accepts',
      'packages/web/src/composers/EditingProvider/useNoteDraft.ts#useNoteDraft':
        'the editor: whether the machine name a draft carries is one a package may have',
      'packages/web/src/libs/abilityDraftStorage/abilityDraftStorage.ts#skillName':
        'the persisted draft, validating a name it read back out of session storage',
    },
  },
  {
    producer: 'abilityDraftSessionOf',
    why: 'the draft and the key it was stored under, resolved as ONE value. Reading them apart is how an edit landed under a key from the previous session. Written by the fix phase of round 5, guarded by nothing until now.',
    askedFrom: {
      'packages/web/src/pages/AgentsPage/AbilityDraftPage.tsx#AbilityDraftPage':
        'the draft page: the resume decision and the render guard, which must agree',
    },
  },
]

// ---------------------------------------------------------------------------
// The rewrites round 6 walked out of the previous register with, and what this one
// answers to each. `caught: false` entries are the honest limits of this form — they
// are asserted too, so the disclosure cannot quietly stop being true.
// ---------------------------------------------------------------------------

type Rewrite = {
  readonly rule: string
  readonly name: string
  readonly find: Matcher
  readonly code: string
  readonly caught: boolean
}

const REWRITES: readonly Rewrite[] = [
  {
    rule: 'skill name',
    name: 'a flag on the literal — the one that was live in the tree',
    find: skillNameDomains,
    code: `const ok = (value: string) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value)`,
    caught: true,
  },
  {
    rule: 'skill name',
    name: 'a widening flag, which reads as the same rule and is not',
    find: skillNameDomains,
    code: `const ok = (value: string) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i.test(value)`,
    caught: true,
  },
  {
    rule: 'skill name',
    name: 'the class members reordered',
    find: skillNameDomains,
    code: `const ok = (value: string) => /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value)`,
    caught: false,
  },
  {
    rule: 'skill name',
    name: 'stated without a pattern at all — a loop over char codes',
    find: skillNameDomains,
    code: `
      const ok = (value: string) =>
        [...value].every((ch) => (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-')
    `,
    caught: false,
  },
  {
    rule: 'brand',
    name: 'the cast, spelled',
    find: placementBrandForgeries,
    code: `const home = { scope: 'space', space } as AddressedPlacement`,
    caught: true,
  },
  {
    rule: 'brand',
    name: 'through `any`, which needs no cast to the branded type',
    find: placementBrandForgeries,
    code: `const home: AddressedPlacement = { scope: 'space', space } as any`,
    caught: false,
  },
  {
    rule: 'brand',
    name: 'through a local alias of the branded type',
    find: placementBrandForgeries,
    code: `type P = AddressedPlacement\nconst home = { scope: 'space', space } as P`,
    caught: false,
  },
  {
    rule: 'reach',
    name: 'a space before the paren',
    find: reachSpellings,
    code: `const covers = (a: A, projectId: string) => a.projectIds.includes (projectId)`,
    caught: true,
  },
  {
    rule: 'reach',
    name: 'prettier wraps the call once the name grows',
    find: reachSpellings,
    code: `
      const covers = (availabilityForThisAbility: A, projectId: string) =>
        availabilityForThisAbility.projectIds
          .includes(projectId)
    `,
    caught: true,
  },
  {
    rule: 'reach',
    name: 'a predicate instead of membership',
    find: reachSpellings,
    code: `const covers = (a: A, projectId: string) => a.projectIds.some((id) => id === projectId)`,
    caught: true,
  },
  {
    rule: 'reach',
    name: 'a predicate whose parameter is the one named projectId',
    find: reachSpellings,
    code: `const covers = (a: A, wanted: string) => a.projectIds.some((projectId) => projectId === wanted)`,
    caught: true,
  },
  {
    rule: 'reach',
    name: 'through a Set',
    find: reachSpellings,
    code: `const covers = (a: A, projectId: string) => new Set(a.projectIds).has(projectId)`,
    caught: true,
  },
  {
    rule: 'reach',
    name: 'optional chaining',
    find: reachSpellings,
    code: `const covers = (a: A, projectId: string) => a.availability?.projectIds?.includes(projectId)`,
    caught: true,
  },
  {
    rule: 'reach',
    name: 'indexOf',
    find: reachSpellings,
    code: `const covers = (a: A, projectId: string) => a.projectIds.indexOf(projectId) !== -1`,
    caught: true,
  },
  {
    rule: 'reach',
    name: 'parked in a local first',
    find: reachSpellings,
    code: `
      const covers = (a: A, projectId: string) => {
        const reach = a.availability?.projectIds ?? []
        return reach.includes(projectId)
      }
    `,
    caught: true,
  },
  {
    rule: 'reach',
    name: 'destructured, and renamed while destructuring',
    find: reachSpellings,
    code: `
      const covers = (a: A, projectId: string) => {
        const { projectIds: reach } = a
        return reach.includes(projectId)
      }
    `,
    caught: true,
  },
  {
    rule: 'reach',
    name: 'bracket access',
    find: reachSpellings,
    code: `const covers = (a: A, projectId: string) => a['projectIds'].includes(projectId)`,
    caught: true,
  },
  {
    rule: 'locator',
    name: 'a different field order',
    find: addressedLocatorLiterals,
    code: `const l = { location: { scope, spaceId }, packageId, kind: 'role', source: 'owned' }`,
    caught: true,
  },
  {
    rule: 'locator',
    name: 'property shorthand',
    find: addressedLocatorLiterals,
    code: `const l = { source, kind, packageId, location }`,
    caught: true,
  },
  {
    rule: 'locator',
    name: 'a template string in a value',
    find: addressedLocatorLiterals,
    code: 'const l = { source: `owned`, kind: `role`, packageId, location: { scope: `${scope}`, spaceId } }',
    caught: true,
  },
  {
    rule: 'locator',
    name: 'split in two and spread back together',
    find: addressedLocatorLiterals,
    code: `
      const base = { source: 'owned', kind: 'role', packageId }
      const l = { ...base, location }
    `,
    caught: true,
  },
  {
    rule: 'locator',
    name: 'Object.assign',
    find: addressedLocatorLiterals,
    code: `const l = Object.assign({ source: 'owned', kind: 'role', packageId }, { location })`,
    caught: true,
  },
  {
    rule: 'locator',
    name: 'the placement moved into a factory',
    find: addressedLocatorLiterals,
    code: `const l = { source: 'owned', kind: 'role', packageId, location: placeFor(scope, space) }`,
    caught: true,
  },
  {
    rule: 'locator',
    name: 'double quotes',
    find: addressedLocatorLiterals,
    code: `const l = { source: "owned", kind: "role", packageId, location: { scope, spaceId } }`,
    caught: true,
  },
  {
    rule: 'locator',
    name: 'the enum idiom the whole web is written in',
    find: addressedLocatorLiterals,
    code: `const l = { source: ABILITY_SOURCE.owned, kind: ABILITY_KIND.role, packageId, location }`,
    caught: true,
  },
  {
    rule: 'locator',
    name: 'a comment opener inside a string literal, which used to swallow the code after it',
    find: addressedLocatorLiterals,
    code: `
      const doc = "the client's view layer over the /api/* wire"
      const l = { source: 'owned', kind: 'role', packageId, location: { scope, spaceId } }
    `,
    caught: true,
  },
  // ---- the limits, stated ----
  {
    rule: 'reach',
    name: 'NOT CAUGHT: a hand-rolled loop with no membership call at all',
    find: reachSpellings,
    code: `
      const covers = (a: A, projectId: string) => {
        for (const id of a.projectIds) {
          if (id === projectId) return true
        }
        return false
      }
    `,
    caught: false,
  },
  {
    rule: 'reach',
    name: 'NOT CAUGHT: the reach list renamed to something with no projectIds in it',
    find: reachSpellings,
    code: `const covers = (a: A, projectId: string) => a.allowedProjects.includes(projectId)`,
    caught: false,
  },
  {
    rule: 'locator',
    name: 'NOT CAUGHT: a locator assembled by mutation',
    find: addressedLocatorLiterals,
    code: `
      const l: Partial<OwnedAbilityLocator> = {}
      l.source = 'owned'
      l.kind = 'role'
      l.packageId = packageId
      l.location = location
    `,
    caught: false,
  },
  {
    rule: 'locator',
    name: 'NOT CAUGHT: half of it spread in from another module',
    find: addressedLocatorLiterals,
    code: `
      import { ownedBase } from './elsewhere'
      const l = { ...ownedBase, location }
    `,
    caught: false,
  },
  {
    rule: 'address',
    name: 'NOT CAUGHT: a domain stated over a value not named packageId',
    find: packageAddressDomains,
    code: `const validId = (value: string) => value.length === 12`,
    caught: false,
  },
]

// ---------------------------------------------------------------------------
// Debt: rules this register can SEE but not fix, because the code is not its zone.
// Listed once, so an entry cannot be added to an allow-list without landing here too,
// and cannot be fixed without being struck from here.
// ---------------------------------------------------------------------------

const DECLARED_DEBT: readonly string[] = [
  'packages/web/src/pages/AgentsPage/AbilityEditorSurface.tsx#eligibleSkills',
]

describe('ability domain: one producer per rule', () => {
  const surface: readonly ScannedFile[] = readSurface(ROOTS)

  describe('the surface', () => {
    it('is closed over the tree — every sibling is scanned or declared', () => {
      expect(
        childDirectories('packages').sort(),
        'a package is neither scanned nor declared unscanned',
      ).toEqual([...Object.keys(SCANNED_PACKAGES), ...Object.keys(UNSCANNED_PACKAGES)].sort())
      expect(
        childDirectories('test').sort(),
        'a directory under test/ is neither scanned nor declared unscanned',
      ).toEqual(
        [
          ...Object.keys(SCANNED_ROOTS)
            .filter((root) => root.startsWith('test/'))
            .map((root) => root.slice('test/'.length)),
          ...Object.keys(UNSCANNED_TEST_DIRECTORIES),
        ].sort(),
      )
    })

    it('leaves out only what it says it leaves out', () => {
      // The two unscanned packages are excluded for having no source tree. Growing
      // one is a decision, and it reddens here until it is taken.
      const grown = Object.keys(UNSCANNED_PACKAGES).filter((name) =>
        hasDirectory(`packages/${name}/src`),
      )

      expect(grown, 'an unscanned package grew a source tree').toEqual([])
    })

    it('reddens when a root is narrowed, not only when the scan is emptied', () => {
      // A root with no floor is the narrowing move itself: point a declared root at a
      // subdirectory of itself and its floor stops applying, silently. Both halves are
      // derived from one declaration today, and this is what keeps them derived.
      const unfloored = ROOTS.filter((root) => FLOORS[root] === undefined)

      expect(unfloored, 'a scanned root with no floor under it').toEqual([])

      const thin = ROOTS.filter((root) => readSurface([root]).length < (FLOORS[root] ?? 0)).map(
        (root) => `${root}: ${readSurface([root]).length} < ${FLOORS[root]}`,
      )

      expect(thin, 'the scanned surface has been narrowed').toEqual([])
    })

    it('still contains the files that carry the rules', () => {
      const scanned = new Set(surface.map((file) => file.file))
      const missing = ANCHORS.filter((anchor) => !scanned.has(anchor))

      expect(missing, 'the scan lost a file that carries a rule').toEqual([])
    })
  })

  describe.each(RULES)('$rule', (rule) => {
    it('reddens on a second spelling, and stays quiet on its honest neighbours', () => {
      // Anti-vacuity: a rule that stopped matching anything would otherwise pass in
      // silence forever. That is the defect this whole file was rewritten for.
      expect(
        matchesSnippet(rule.find, rule.secondSpelling),
        `this rule no longer matches a second spelling of it: ${rule.rule}`,
      ).toBe(true)

      const misread = rule.neighbours.filter((neighbour) => matchesSnippet(rule.find, neighbour))

      expect(misread, `honest neighbours misread as: ${rule.rule}`).toEqual([])
    })

    it('has one author across the scanned surface', () => {
      const sites = sitesOf(rule.find, surface)
      const declared = Object.keys(rule.allowed)
      // A second spelling of the rule. Either route the caller through the producer,
      // or add an entry saying why this one is not a copy.
      const undeclared = sites
        .filter((site) => !declared.includes(site.at))
        .map((site) => `${site.at} :${site.line} — ${site.source}`)
      // An entry that matches nothing: the producer moved and the register did not, so
      // the next copy would land unnoticed in the symbol it vacated.
      const stale = declared.filter((entry) => !sites.some((site) => site.at === entry))

      // A declared entry waves past its whole SYMBOL, and a producer can be 2 600 lines
      // long — so "this one is not a copy" has to mean one occurrence, not any number
      // of them. Without the count, a hand-written locator dropped inside
      // `serializeAbilityLocator` is silent, which is the shape that got through the
      // register before this one.
      const multiplied = declared
        .map((entry) => ({ entry, count: sites.filter((site) => site.at === entry).length }))
        .filter(({ entry, count }) => count > (rule.repeats?.[entry] ?? 1))
        .map(({ entry, count }) => `${entry}: ${count}`)

      expect(undeclared, `a second author of: ${rule.rule}`).toEqual([])
      expect(stale, `a register entry that matches nothing, for: ${rule.rule}`).toEqual([])
      expect(
        multiplied,
        `a declared place that now states it more than once: ${rule.rule}`,
      ).toEqual([])
    })
  })

  it('mints the addressed-placement brand in exactly four casts', () => {
    const forgeries = sitesOf(placementBrandForgeries, surface)

    expect(
      forgeries.map((site) => `${site.at} :${site.line}`),
      'the addressed-placement brand is forged somewhere new',
    ).toHaveLength(BRAND_FORGERY_COUNT)
  })

  describe.each(CALL_REGISTERS)(
    '$producer is asked from exactly the declared places',
    (register) => {
      it('has no undeclared caller and no declared place that stopped asking', () => {
        const sites = sitesOf(callSitesOf(register.producer), surface)
        const declared = Object.keys(register.askedFrom)
        const undeclared = sites
          .filter((site) => !declared.includes(site.at))
          .map((site) => `${site.at} :${site.line} — ${site.source}`)
        // The half a spelling scan cannot do: a door that stopped asking leaves no
        // ingredient behind, only a missing call.
        const silent = declared.filter((entry) => !sites.some((site) => site.at === entry))

        expect(undeclared, `an undeclared caller of ${register.producer}`).toEqual([])
        expect(silent, `a declared place that stopped asking ${register.producer}`).toEqual([])
      })
    },
  )

  it.each(REWRITES)('$rule · $name', (rewrite) => {
    expect(matchesSnippet(rewrite.find, rewrite.code), `rewrite: ${rewrite.name}`).toBe(
      rewrite.caught,
    )
  })

  it('states the debt it can see but not fix', () => {
    const carried = RULES.flatMap((rule) =>
      Object.entries(rule.allowed)
        .filter(([, reason]) => reason.startsWith('DEBT'))
        .map(([at]) => at),
    ).sort()

    expect(carried, 'the debt inventory moved without being restated').toEqual(
      [...DECLARED_DEBT].sort(),
    )
  })
})
