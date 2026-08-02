import { describe, expect, it } from 'vitest'

import {
  assertSuffix,
  flags,
  mergeCells,
  renderReview,
  reportOutcome,
} from '../../scripts/visualBaseline.mjs'

/** A Playwright JSON report shrunk to the fields the protocol reads. */
const report = (...tests: unknown[]) => ({
  suites: [
    { title: 'visual.spec.ts', specs: [], suites: [{ title: 'feed — dark', specs: tests }] },
  ],
})
const spec = (title: string, status: string, ...results: unknown[]) => ({
  title,
  tests: [{ status, results }],
})
const attempt = (...paths: string[]) => ({ attachments: paths.map((path) => ({ path })) })

describe('command-line flags', () => {
  it('reads values', () => {
    expect(flags(['--candidate', 'mr-42', '--commit', 'abc123'])).toEqual({
      candidate: 'mr-42',
      commit: 'abc123',
    })
  })

  it('treats a valueless flag as true when another flag follows', () => {
    expect(flags(['--bootstrap', '--candidate', 'boot'])).toEqual({
      bootstrap: true,
      candidate: 'boot',
    })
  })

  it('treats a valueless flag as true when it is LAST', () => {
    // The regression this exists for: reading a missing next argument as the value
    // made `--bootstrap` undefined, so publishing a first baseline set silently
    // became an ordinary comparison — exactly when it is typed the natural way.
    expect(flags(['--candidate', 'boot', '--bootstrap'])).toEqual({
      candidate: 'boot',
      bootstrap: true,
    })
  })

  it('ignores positional noise rather than mistaking it for a flag', () => {
    expect(flags(['publish', '--candidate', 'x', 'stray'])).toEqual({ candidate: 'x' })
  })

  it('returns nothing for no arguments', () => {
    expect(flags([])).toEqual({})
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

  it('does not mutate the baseline it was handed', () => {
    mergeCells(baseline, [['a-chromium-linux.png', 'd-a2']])

    expect(baseline['a-chromium-linux.png']).toBe('d-a')
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
  const page = (rows: unknown[], total = 60) =>
    renderReview({
      candidate: 'ci-1-7257f12b',
      rows,
      total,
      commit: '7257f12b229a8dd28d7f6952ec61ae7c4476a5a2',
      pipeline: '2334',
      day: '2026-07-31',
    })

  it('carries its own identity, because it is opened out of a bucket', () => {
    // By the time anyone looks at this file it has been downloaded and the folder name
    // is no longer on screen. A page that cannot say which commit it belongs to is a
    // page you cannot safely accept from.
    const html = page([{ cell: 'a.png', actual: 'https://x/a', diffUrl: 'https://x/d' }])

    expect(html).toContain('7257f12b229a8dd28d7f6952ec61ae7c4476a5a2')
    expect(html).toContain('2334')
    expect(html).toContain('ci-1-7257f12b')
    expect(html).toContain('2026-07-31')
  })

  it('calls a matrix-wide diff what it usually is', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ cell: `c${i}.png`, actual: 'u' }))

    expect(page(rows)).toMatch(/Most of the matrix moved/)
    expect(page(rows.slice(0, 1))).not.toMatch(/Most of the matrix moved/)
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
  it('takes the artefacts of the LAST attempt', () => {
    // Retries are on in CI, so a failing cell renders twice and leaves an artefact
    // under both directories. Counting both is how a 60-cell matrix once reported
    // "70 of 60 changed" — and digest comparison cannot collapse them, because two
    // independent renders of the same cell genuinely differ.
    const { cells } = reportOutcome(
      report(
        spec(
          'rail open',
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
    expect(flaky).toEqual(['rail open'])
  })

  it('reports a failure with no screenshot as broken, not as zero diffs', () => {
    // A timeout or a broken page produces no image to review. Contributing nothing to
    // the pixel count would leave the gate green on a red suite.
    const { cells, broken } = reportOutcome(report(spec('rail open', 'unexpected', attempt())))

    expect(cells).toEqual([])
    expect(broken).toEqual(['rail open'])
  })

  it('pairs each cell with its own diff image', () => {
    const { cells } = reportOutcome(
      report(
        spec(
          'rail open',
          'unexpected',
          attempt('test-results/feed/feed-dark-actual.png', 'test-results/feed/feed-dark-diff.png'),
        ),
      ),
    )

    expect(cells[0].diff).toBe('test-results/feed/feed-dark-diff.png')
  })

  it('ignores tests that passed or were skipped', () => {
    const { cells } = reportOutcome(
      report(
        spec('a', 'expected', attempt('test-results/a/a-actual.png')),
        spec('b', 'skipped'),
        spec('c', 'unexpected', attempt('test-results/c/c-actual.png')),
      ),
    )

    expect(cells.map((c) => c.stem)).toEqual(['c'])
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

  it('survives an empty report instead of throwing', () => {
    expect(reportOutcome({})).toEqual({ cells: [], flaky: [], broken: [] })
  })
})
