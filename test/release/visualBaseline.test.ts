import { describe, expect, it } from 'vitest'

import playwrightConfig from '../../playwright.config'
import {
  assertCandidatePointer,
  assertCarriedFlakyDigests,
  assertChannelMatchesPulledBase,
  assertInitialCandidate,
  assertProducerIdentity,
  assertPulledBaseEvidence,
  assertSuffix,
  assertVisualHandoff,
  bindCarriedFlakyCells,
  bindManifestToChannel,
  blocksCandidate,
  candidatePointer,
  flags,
  gate,
  manifestDigest,
  mergeCells,
  normalizeReportedCells,
  pulledBaseEvidence,
  renderReview,
  reportOutcome,
  reviewEnvironment,
  VISUAL_SNAPSHOT_PATH_TEMPLATE,
  VISUAL_SNAPSHOT_SUFFIX,
  visualFailureCount,
  visualGateSummary,
  visualHandoff,
} from '../../scripts/visualBaseline.mjs'

/** A Playwright JSON report shrunk to the fields the protocol reads. */
const report = (...tests: unknown[]) => ({
  suites: [
    { title: 'visual.spec.ts', specs: [], suites: [{ title: 'feed — dark', specs: tests }] },
  ],
})
const spec = (title: string, status: string, ...results: unknown[]) => ({
  title,
  tests: [
    {
      status,
      annotations: [{ type: 'visual-cell', description: title }],
      results,
    },
  ],
})
const namedSpec = (title: string, status: string, name: string, ...results: unknown[]) => ({
  title,
  tests: [
    {
      status,
      annotations: [{ type: 'visual-cell', description: name }],
      results,
    },
  ],
})
const attempt = (...paths: string[]) => ({ attachments: paths.map((path) => ({ path })) })
const annotatedSpec = (title: string, projectName: string, name: string) => ({
  title,
  tests: [
    {
      status: 'expected',
      projectName,
      annotations: [{ type: 'visual-cell', description: name }],
      results: [attempt()],
    },
  ],
})

describe('command-line flags', () => {
  it('reads values', () => {
    expect(flags(['--candidate', 'mr-42', '--commit', 'abc123'])).toEqual({
      candidate: 'mr-42',
      commit: 'abc123',
    })
  })

  it('treats a valueless flag as true when it is LAST', () => {
    expect(flags(['--candidate', 'first-run', '--verbose'])).toEqual({
      candidate: 'first-run',
      verbose: true,
    })
  })

  it('ignores positional noise rather than mistaking it for a flag', () => {
    expect(flags(['publish', '--candidate', 'x', 'stray'])).toEqual({ candidate: 'x' })
  })

  it('returns nothing for no arguments', () => {
    expect(flags([])).toEqual({})
  })
})

describe('optional visual gate evidence', () => {
  it('stays neutral only when the producer handoff is absent', async () => {
    await expect(
      gate({ handoff: 'test-results/definitely-absent-visual-handoff.json', ifPresent: true }),
    ).resolves.toBeUndefined()
  })
})

describe('candidate cell merge', () => {
  const baseline = { 'a-chromium-linux.png': 'd-a', 'b-chromium-linux.png': 'd-b' }

  it('keeps an untouched cell byte-for-byte', () => {
    // The invariant the whole protocol turns on: "passed" means within tolerance, not
    // identical, so adopting a fresh render for a passing cell would let sub-threshold
    // noise accumulate approval by approval until it crosses on its own.
    const { cells, changed } = mergeCells(baseline, [['a-chromium-linux.png', 'd-a2']])

    expect(cells['b-chromium-linux.png']).toBe('d-b')
    expect(changed.map((c) => c.cell)).toEqual(['a-chromium-linux.png'])
  })

  it('replaces the digest of a cell that really moved', () => {
    const { cells } = mergeCells(baseline, [['a-chromium-linux.png', 'd-a2']])

    expect(cells['a-chromium-linux.png']).toBe('d-a2')
  })

  it('reports a re-render that is identical as no change at all', () => {
    // A rerun can re-emit an artefact whose bytes match. Publishing that as a change
    // would produce a candidate identical to the channel and ask for an approval that
    // decides nothing.
    const { cells, changed } = mergeCells(baseline, [['a-chromium-linux.png', 'd-a']])

    expect(changed).toEqual([])
    expect(cells).toEqual(baseline)
  })

  it('marks a cell the baseline has never seen as added', () => {
    const { cells, changed } = mergeCells(baseline, [['c-chromium-linux.png', 'd-c']])

    expect(changed).toEqual([{ cell: 'c-chromium-linux.png', digest: 'd-c', added: true }])
    expect(Object.keys(cells)).toHaveLength(3)
  })

  it('treats a missing channel as an empty baseline of added cells', () => {
    const { cells, changed } = mergeCells({}, [['first-chromium-linux.png', 'd-first']])

    expect(cells).toEqual({ 'first-chromium-linux.png': 'd-first' })
    expect(changed).toEqual([{ cell: 'first-chromium-linux.png', digest: 'd-first', added: true }])
  })

  it('does not mutate the baseline it was handed', () => {
    mergeCells(baseline, [['a-chromium-linux.png', 'd-a2']])

    expect(baseline['a-chromium-linux.png']).toBe('d-a')
  })
})

describe('canonical screenshot identity', () => {
  const configuredTemplate = (
    playwrightConfig as { expect?: { toHaveScreenshot?: { pathTemplate?: string } } }
  ).expect?.toHaveScreenshot?.pathTemplate
  const resolvePath = (arg: string) =>
    VISUAL_SNAPSHOT_PATH_TEMPLATE.replace('{testDir}', 'test')
      .replace('{arg}', arg)
      .replace('{ext}', '.png')

  it('routes base and provider project cells into the same fixed manifest namespace', () => {
    expect(configuredTemplate).toBe(VISUAL_SNAPSHOT_PATH_TEMPLATE)
    expect(VISUAL_SNAPSHOT_SUFFIX).toBe('-chromium-linux.png')
    expect(VISUAL_SNAPSHOT_PATH_TEMPLATE).not.toMatch(/projectName|testFile/u)
    expect(resolvePath('home-open-dark')).toBe(
      'test/visual/visual.spec.ts-snapshots/home-open-dark-chromium-linux.png',
    )
    expect(resolvePath('provider-resource-form-dark')).toBe(
      'test/visual/visual.spec.ts-snapshots/provider-resource-form-dark-chromium-linux.png',
    )
  })

  it('rejects a duplicate global cell before either render can win', () => {
    expect(() =>
      normalizeReportedCells([
        { stem: 'same', actual: 'test-results/a/same-actual.png' },
        { stem: 'same', actual: 'test-results/b/same-actual.png' },
      ]),
    ).toThrow(/duplicate rendered cell "same-chromium-linux[.]png"/u)
  })
})

describe('first candidate completeness', () => {
  it('accepts an all-added screenshot outcome', () => {
    expect(() =>
      assertInitialCandidate({ cells: [{ stem: 'first' }], broken: [], flaky: [] }),
    ).not.toThrow()
  })

  it('rejects an empty outcome instead of emitting a zero-diff verdict', () => {
    expect(() => assertInitialCandidate({ cells: [], broken: [], flaky: [] })).toThrow(
      /produced no screenshots/u,
    )
  })

  it.each([
    { broken: ['timed out'], flaky: [] },
    { broken: [], flaky: ['retry-pass'] },
  ])('rejects a partial first candidate: $broken $flaky', ({ broken, flaky }) => {
    expect(() => assertInitialCandidate({ cells: [{ stem: 'first' }], broken, flaky })).toThrow(
      /first candidate is incomplete/u,
    )
  })
})

describe('candidate publication and acceptance identity', () => {
  const identity = {
    candidate: 'main-abc123-2584-9531',
    commit: 'abc123def456',
    pipeline: '2584',
    job: '9531',
    snapshot: 'snapshot-digest',
    baseSnapshot: 'base-digest',
    review: 'visual-review/reviews/2026-08-31-main-abc123-2584-9531/index.html',
    carriedFlakyCells: [],
  }

  it.each([
    { broken: ['timeout'], flaky: [], integrity: [] },
    { broken: [], flaky: [], integrity: ['duplicate cell'] },
  ])('blocks every broken or integrity outcome before publication', (outcome) => {
    expect(blocksCandidate({ cells: [], ...outcome })).toBe(true)
  })

  it('allows flakes to reach established-base classification without accepting bytes', () => {
    expect(
      blocksCandidate({ cells: [{ stem: 'changed' }], broken: [], flaky: [{}], integrity: [] }),
    ).toBe(false)
  })

  it('binds flaky cells to exact accepted digests and refuses a new cell', () => {
    const flaky = [{ cell: 'old-chromium-linux.png', title: 'old cell' }]

    expect(bindCarriedFlakyCells(flaky, { 'old-chromium-linux.png': 'accepted-digest' })).toEqual([
      { ...flaky[0], digest: 'accepted-digest' },
    ])
    expect(() => bindCarriedFlakyCells(flaky, {})).toThrow(/no accepted baseline to carry/u)
  })

  it('exposes an accept target only for a completed candidate', () => {
    const pointer = candidatePointer(identity)
    const rejected = reviewEnvironment(null, 0, 1, 0, null)
    const published = reviewEnvironment(identity.review, 1, 0, 0, pointer)

    expect(rejected).not.toMatch(/^VISUAL_CANDIDATE=/mu)
    expect(published).toContain(`VISUAL_CANDIDATE=${identity.candidate}`)
    expect(published).toContain(`VISUAL_CANDIDATE_COMMIT=${identity.commit}`)
    expect(published).toContain(`VISUAL_CANDIDATE_PIPELINE=${identity.pipeline}`)
    expect(published).toContain(`VISUAL_CANDIDATE_JOB=${identity.job}`)
    expect(published).toContain(`VISUAL_CANDIDATE_SNAPSHOT=${identity.snapshot}`)
    expect(published).toContain(`VISUAL_CANDIDATE_BASE_SNAPSHOT=${identity.baseSnapshot}`)
    expect(assertVisualHandoff(visualHandoff(identity.review, 1, 0, 0, pointer, []))).toEqual({
      schema: 2,
      review: identity.review,
      counts: { diffs: 1, failures: 0, flakes: 0 },
      flakyCells: [],
      accept: pointer,
    })
    expect(assertVisualHandoff(visualHandoff(null, 0, 1, 0, null, []))).toMatchObject({
      accept: null,
    })
    expect(() => assertVisualHandoff(visualHandoff(identity.review, 1, 1, 0, pointer, []))).toThrow(
      /accept target without clean stable diffs/u,
    )
  })

  it('allows stable diffs with cryptographically carried flaky cells', () => {
    const carriedFlakyCells = [
      { cell: 'old-chromium-linux.png', title: 'old cell', digest: 'accepted-digest' },
    ]
    const pointer = candidatePointer({ ...identity, carriedFlakyCells })
    const handoff = assertVisualHandoff(
      visualHandoff(identity.review, 2, 0, 1, pointer, carriedFlakyCells),
    )

    expect(handoff.accept).toEqual(pointer)
    expect(handoff.flakyCells).toEqual(carriedFlakyCells)
    expect(visualGateSummary(handoff)).toMatchObject({
      red: true,
      lines: [
        expect.stringContaining('1 test(s) passed only on retry'),
        expect.stringContaining('old-chromium-linux.png'),
        expect.stringContaining('2 cells differ'),
        expect.stringContaining(identity.review),
        expect.any(String),
      ],
    })
    expect(() =>
      assertCarriedFlakyDigests(
        carriedFlakyCells,
        { 'old-chromium-linux.png': 'accepted-digest' },
        { 'old-chromium-linux.png': 'accepted-digest' },
      ),
    ).not.toThrow()
    expect(() =>
      assertCarriedFlakyDigests(
        carriedFlakyCells,
        { 'old-chromium-linux.png': 'forged' },
        { 'old-chromium-linux.png': 'accepted-digest' },
      ),
    ).toThrow(/candidate changed carried flaky cell/u)
    expect(() =>
      assertCarriedFlakyDigests(
        carriedFlakyCells,
        { 'old-chromium-linux.png': 'accepted-digest' },
        { 'old-chromium-linux.png': 'forged' },
      ),
    ).toThrow(/no longer matches its accepted base digest/u)
  })

  it('does not expose carried flakes without an accepted base', () => {
    const carriedFlakyCells = [
      { cell: 'new-chromium-linux.png', title: 'new cell', digest: 'new-digest' },
    ]
    const pointer = candidatePointer({ ...identity, baseSnapshot: null, carriedFlakyCells })

    expect(() =>
      assertVisualHandoff(visualHandoff(identity.review, 1, 0, 1, pointer, carriedFlakyCells)),
    ).toThrow(/without an accepted base/u)
  })

  it('keeps a flakes-only handoff red without an accept target', () => {
    const flakyCells = [{ cell: 'old-chromium-linux.png', title: 'old cell' }]
    const handoff = assertVisualHandoff(visualHandoff(null, 0, 0, 1, null, flakyCells))

    expect(handoff.accept).toBeNull()
    expect(visualGateSummary(handoff)).toMatchObject({ red: true })
  })

  it('requires the candidate slug to carry the exact pipeline and producer job', () => {
    expect(() => assertProducerIdentity(identity)).not.toThrow()
    expect(() => assertProducerIdentity({ ...identity, candidate: 'main-abc123' })).toThrow(
      /exact pipeline and producer job ids/u,
    )
  })

  it('binds a legacy manifest to its channel address and rejects a conflicting identity', () => {
    expect(bindManifestToChannel('base-digest', { schema: 1, cells: {} })).toMatchObject({
      snapshot: 'base-digest',
    })
    expect(() =>
      bindManifestToChannel('base-digest', {
        schema: 1,
        cells: {},
        snapshot: 'other-digest',
      }),
    ).toThrow(/manifest identifies itself as other-digest/u)
  })

  it('binds publication to the exact successfully pulled channel, including null', () => {
    const baseA = assertPulledBaseEvidence(pulledBaseEvidence('snapshot-a'))
    const noBase = assertPulledBaseEvidence(pulledBaseEvidence(null))

    expect(() => assertChannelMatchesPulledBase(baseA, 'snapshot-a')).not.toThrow()
    expect(() => assertChannelMatchesPulledBase(noBase, null)).not.toThrow()
    for (const [pulled, current] of [
      [baseA, 'snapshot-b'],
      [baseA, null],
      [noBase, 'snapshot-a'],
    ] as const) {
      expect(() => assertChannelMatchesPulledBase(pulled, current)).toThrow(
        /visual channel moved after pull/u,
      )
    }
  })

  it('content-addresses the complete schema-2 manifest identity', () => {
    const manifest = {
      schema: 2,
      cells: { 'one-chromium-linux.png': 'image-digest' },
      identity: {
        commit: identity.commit,
        pipeline: identity.pipeline,
        job: identity.job,
        carriedFlakyCells: [
          { cell: 'old-chromium-linux.png', title: 'old', digest: 'accepted-digest' },
        ],
      },
    }

    expect(manifestDigest(manifest)).not.toBe(
      manifestDigest({ ...manifest, identity: { ...manifest.identity, job: 'other-job' } }),
    )
    expect(manifestDigest(manifest)).not.toBe(
      manifestDigest({
        ...manifest,
        identity: {
          ...manifest.identity,
          carriedFlakyCells: [{ cell: 'old-chromium-linux.png', title: 'old', digest: 'forged' }],
        },
      }),
    )
  })

  it.each(['commit', 'pipeline', 'job', 'snapshot', 'baseSnapshot', 'review'] as const)(
    'rejects an accept pointer whose %s was overwritten',
    (field) => {
      const pointer = candidatePointer(identity)

      expect(() => assertCandidatePointer({ ...pointer, [field]: 'other' }, identity)).toThrow(
        new RegExp(`candidate ${field} mismatch`, 'u'),
      )
    },
  )

  it('rejects a pointer or handoff that changes carried flaky digests', () => {
    const pointer = candidatePointer(identity)

    expect(() =>
      assertCandidatePointer(
        {
          ...pointer,
          carriedFlakyCells: [{ cell: 'old-chromium-linux.png', title: 'old', digest: 'forged' }],
        },
        identity,
      ),
    ).toThrow(/carriedFlakyCells mismatch/u)
  })
})

describe('baseline suffix', () => {
  it('accepts a set that all carries the suffix', () => {
    expect(() => assertSuffix(['a-chromium-linux.png'], '-chromium-linux.png')).not.toThrow()
  })

  it('names the offending cell rather than failing vaguely', () => {
    expect(() =>
      assertSuffix(['a-chromium-linux.png', 'b-webkit.png'], '-chromium-linux.png'),
    ).toThrow(/b-webkit\.png/)
  })
})

describe('review page', () => {
  const page = (rows: unknown[], total = 60, carriedFlakyCells: unknown[] = []) =>
    renderReview({
      candidate: 'ci-1-7257f12b',
      rows,
      total,
      commit: '7257f12b229a8dd28d7f6952ec61ae7c4476a5a2',
      pipeline: '2334',
      job: '9512',
      carriedFlakyCells,
      day: '2026-07-31',
    })

  it('carries its own identity, because it is opened out of a bucket', () => {
    // By the time anyone looks at this file it has been downloaded and the folder name
    // is no longer on screen. A page that cannot say which commit it belongs to is a
    // page you cannot safely accept from.
    const html = page([{ cell: 'a.png', actual: 'https://x/a', diffUrl: 'https://x/d' }])

    expect(html).toContain('7257f12b229a8dd28d7f6952ec61ae7c4476a5a2')
    expect(html).toContain('2334')
    expect(html).toContain('9512')
    expect(html).toContain('ci-1-7257f12b')
    expect(html).toContain('2026-07-31')
  })

  it('calls a matrix-wide diff what it usually is', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ cell: `c${i}.png`, actual: 'u' }))

    expect(page(rows)).toMatch(/Most of the matrix moved/)
    expect(page(rows.slice(0, 1))).not.toMatch(/Most of the matrix moved/)
  })

  it('calls a first-run matrix new rather than render drift', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      cell: `c${i}.png`,
      actual: 'u',
      added: true,
    }))
    const html = page(rows)

    expect(html).toContain('60 new cells.')
    expect(html).not.toContain('Most of the matrix moved')
  })

  it('states which flaky cells were excluded and carried from the base', () => {
    const html = page([{ cell: 'changed.png', actual: 'u' }], 2, [
      { cell: 'flaky-chromium-linux.png', title: 'flaky', digest: 'accepted' },
    ])

    expect(html).toContain('1 flaky cell(s) were excluded')
    expect(html).toContain('flaky-chromium-linux.png')
    expect(html).toContain('does not make this run green')
  })

  it('escapes what it interpolates', () => {
    const html = page([{ cell: '<img onerror=x>.png', actual: 'https://x/a"' }])

    expect(html).not.toContain('<img onerror=x>')
    expect(html).toContain('&lt;img onerror=x&gt;')
  })

  it('leaves the diff column empty rather than a broken image', () => {
    // A cell Playwright reported without a diff (a new cell) has nothing to compare
    // against; an <img> with no src would render as a broken-image icon and read as
    // "the review is broken".
    expect(page([{ cell: 'a.png', actual: 'https://x/a', diffUrl: null }])).not.toMatch(
      /<img[^>]*src=""/,
    )
  })
})

describe('what a run decided', () => {
  it('materializes flaky separately so visual:gate can stay red after a retry-pass', () => {
    expect(reviewEnvironment(null, 0, 0, 2, null)).toContain('VISUAL_FLAKES=2')
  })

  it('takes the artefacts of the LAST attempt', () => {
    // Retries are on in CI, so a failing cell renders twice and leaves an artefact
    // under both directories. Counting both is how a 60-cell matrix once reported
    // "70 of 60 changed" — and digest comparison cannot collapse them, because two
    // independent renders of the same cell genuinely differ.
    const { cells } = reportOutcome(
      report(
        spec(
          'feed-dark',
          'unexpected',
          attempt('test-results/feed/feed-dark-actual.png'),
          attempt('test-results/feed-retry1/feed-dark-actual.png'),
        ),
      ),
    )

    expect(cells).toEqual([
      {
        stem: 'feed-dark',
        actual: 'test-results/feed-retry1/feed-dark-actual.png',
        diff: undefined,
      },
    ])
  })

  it('DROPS a cell that failed once and passed on retry', () => {
    // The flake guard, and the reason the verdict is read from the report rather than
    // from the directory: the passing attempt writes nothing, so a file walk sees only
    // the failed one and publishes a flake as a change — reddening the gate over pixels
    // Playwright itself ruled acceptable, and laundering them into the baseline through
    // an approval.
    const { cells, flaky } = reportOutcome(
      report(spec('rail open', 'flaky', attempt('test-results/feed/feed-dark-actual.png'))),
    )

    expect(cells).toEqual([])
    expect(flaky).toEqual([{ title: 'rail open', cell: 'rail open-chromium-linux.png' }])
  })

  it('reports a failure with no screenshot as broken, not as zero diffs', () => {
    // A timeout or a broken page produces no image to review. Contributing nothing to
    // the pixel count would leave the gate green on a red suite.
    const { cells, broken } = reportOutcome(report(spec('rail open', 'unexpected', attempt())))

    expect(cells).toEqual([])
    expect(broken).toEqual(['rail open'])
  })

  it('finds a passing cross-project cell collision from runtime annotations', () => {
    const outcome = reportOutcome(
      report(
        annotatedSpec('base cell', 'chromium', 'shared-name'),
        annotatedSpec('provider cell', 'chromium-providers', 'shared-name'),
      ),
    )

    expect(outcome.cells).toEqual([])
    expect(outcome.integrity).toEqual([
      expect.stringMatching(/duplicate declared visual cell "shared-name-chromium-linux[.]png"/u),
    ])
    expect(reviewEnvironment(null, 0, visualFailureCount(outcome), 0, null)).toContain(
      'VISUAL_FAILURES=1',
    )
  })

  it.each([
    { annotations: [], count: 0 },
    {
      annotations: [
        { type: 'visual-cell', description: 'one' },
        { type: 'visual-cell', description: 'two' },
      ],
      count: 2,
    },
  ])('requires exactly one declared cell per visual test: $count', ({ annotations, count }) => {
    const outcome = reportOutcome({
      suites: [
        {
          specs: [
            {
              title: 'annotation contract',
              tests: [{ status: 'expected', annotations, results: [attempt()] }],
            },
          ],
        },
      ],
    })

    expect(outcome.integrity).toContain(
      `annotation contract declared ${count} visual cells; expected exactly one`,
    )
  })

  it('materializes a top-level runner error as a visual failure', () => {
    const outcome = reportOutcome({
      ...report(annotatedSpec('base cell', 'chromium', 'base')),
      errors: [{ message: 'worker process exited' }],
    })

    expect(outcome.integrity).toContain('Playwright global error: worker process exited')
    expect(visualFailureCount(outcome)).toBe(1)
  })

  it('pairs each cell with its own diff image', () => {
    const { cells } = reportOutcome(
      report(
        spec(
          'feed-dark',
          'unexpected',
          attempt('test-results/feed/feed-dark-actual.png', 'test-results/feed/feed-dark-diff.png'),
        ),
      ),
    )

    expect(cells[0].diff).toBe('test-results/feed/feed-dark-diff.png')
  })

  it('binds an unexpected actual attachment to its declared canonical cell', () => {
    const outcome = reportOutcome(
      report(
        namedSpec(
          'display title',
          'unexpected',
          'canonical',
          attempt('test-results/canonical/canonical-actual.png'),
        ),
      ),
    )

    expect(outcome.cells.map(({ stem }) => stem)).toEqual(['canonical'])
    expect(outcome.integrity).toEqual([])
  })

  it('rejects a declared-cell/actual-stem mismatch', () => {
    const outcome = reportOutcome(
      report(
        namedSpec(
          'display title',
          'unexpected',
          'declared',
          attempt('test-results/other/other-actual.png'),
        ),
      ),
    )

    expect(outcome.cells).toEqual([])
    expect(outcome.integrity).toContain(
      'display title declared visual cell "declared-chromium-linux.png" but attached "other-chromium-linux.png"',
    )
  })

  it('rejects multiple actual screenshots for one declared cell', () => {
    const outcome = reportOutcome(
      report(
        namedSpec(
          'display title',
          'unexpected',
          'declared',
          attempt(
            'test-results/declared/declared-actual.png',
            'test-results/other/other-actual.png',
          ),
        ),
      ),
    )

    expect(outcome.cells).toEqual([])
    expect(outcome.integrity).toContain(
      'display title attached 2 actual screenshots; expected exactly one',
    )
  })

  it('cannot relabel an unexpected actual as a carried flaky cell', () => {
    const outcome = reportOutcome(
      report(
        namedSpec('flaky cell', 'flaky', 'carried', attempt()),
        namedSpec(
          'changed cell',
          'unexpected',
          'changed',
          attempt('test-results/carried/carried-actual.png'),
        ),
      ),
    )

    expect(outcome.cells).toEqual([])
    expect(outcome.flaky.map(({ cell }) => cell)).toEqual(['carried-chromium-linux.png'])
    expect(outcome.integrity).toContain(
      'changed cell declared visual cell "changed-chromium-linux.png" but attached "carried-chromium-linux.png"',
    )
  })

  it('ignores passed attachments but materializes a skipped test as a failure', () => {
    const { cells, integrity } = reportOutcome(
      report(
        spec('a', 'expected', attempt('test-results/a/a-actual.png')),
        spec('b', 'skipped'),
        spec('c', 'unexpected', attempt('test-results/c/c-actual.png')),
      ),
    )

    expect(cells.map((c) => c.stem)).toEqual(['c'])
    expect(integrity).toContain('skipped visual test: b')
  })

  it('materializes skipped stats even when the serialized test status is incomplete', () => {
    const outcome = reportOutcome({
      ...report(spec('a', 'expected', attempt())),
      stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 1 },
    })

    expect(outcome.integrity).toContain('Playwright stats report skipped visual test 1 of 1')
    expect(visualFailureCount(outcome)).toBe(1)
  })

  it('rejects a stats/test-count mismatch as a truncated report', () => {
    const outcome = reportOutcome({
      ...report(spec('a', 'expected', attempt())),
      stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 0 },
    })

    expect(outcome.integrity).toContain(
      'Playwright stats count 2 does not match 1 serialized visual tests',
    )
  })

  it('walks nested describes rather than only the top level', () => {
    const nested = {
      suites: [
        {
          specs: [spec('top', 'unexpected', attempt('test-results/t/top-actual.png'))],
          suites: [
            { specs: [spec('deep', 'unexpected', attempt('test-results/d/deep-actual.png'))] },
          ],
        },
      ],
    }

    expect(reportOutcome(nested).cells.map((c) => c.stem)).toEqual(['top', 'deep'])
  })

  it('turns a zero-test report red instead of treating it as zero diffs', () => {
    const outcome = reportOutcome({})

    expect(outcome).toEqual({
      cells: [],
      flaky: [],
      broken: [],
      integrity: ['Playwright report contains zero visual tests'],
    })
    expect(visualFailureCount(outcome)).toBe(1)
  })
})
