import { AXES, type Axis, AXIS_IDS } from './axes'
import { CORPUS, type Feature, FEATURES } from './corpus'
import { CASES } from './registry'

// The coverage matrix (#175): derive, from the registry + corpus, WHICH cases drive
// each product axis and HOW MANY fragments exercise each markdown feature — so the
// breadth is visible (`make seed-coverage`, docs/seeds.md) and a gap is caught by a
// test, not silently missed. This is what makes the catalog "reflect all our cases":
// you can see, at a glance, what is and isn't seeded.

export type AxisRow = { axis: Axis; title: string; surfaces: readonly string[]; cases: string[] }
export type FeatureRow = { feature: Feature; count: number }

/** Each axis with the cases that tag it. */
export const axisCoverage = (): AxisRow[] =>
  AXES.map((a) => ({
    axis: a.axis,
    title: a.title,
    surfaces: a.surfaces,
    cases: CASES.filter((c) => (c.axes ?? []).includes(a.axis)).map((c) => c.name),
  }))

/** Each markdown feature with its fragment count (the content axis's grain). */
export const featureCoverage = (): FeatureRow[] =>
  FEATURES.map((f) => ({ feature: f, count: CORPUS.filter((x) => x.feature === f).length }))

/** The holes: axes with no case, cases with no axis, features with no fragment. */
export const coverageGaps = (): {
  uncoveredAxes: Axis[]
  untaggedCases: string[]
  emptyFeatures: Feature[]
} => ({
  uncoveredAxes: AXIS_IDS.filter((a) => !CASES.some((c) => (c.axes ?? []).includes(a))),
  untaggedCases: CASES.filter((c) => !(c.axes ?? []).length).map((c) => c.name),
  emptyFeatures: FEATURES.filter((f) => !CORPUS.some((x) => x.feature === f)),
})

/** A human-readable coverage matrix (markdown) for the CLI and the docs. */
export const renderCoverage = (): string => {
  const out: string[] = []
  out.push('# Seed catalog coverage (#175)')
  out.push('')
  out.push(
    `${CASES.length} cases · ${AXES.length} axes · ${CORPUS.length} content fragments across ${FEATURES.length} markdown features.`,
  )
  out.push('')
  out.push('## Axis × cases')
  out.push('')
  out.push('| Axis | Surfaces | Cases |')
  out.push('|---|---|---|')
  for (const r of axisCoverage()) {
    out.push(
      `| \`${r.axis}\` | ${r.surfaces.join(', ')} | ${r.cases.map((c) => `\`${c}\``).join(', ') || '⚠️ none'} |`,
    )
  }
  out.push('')
  out.push('> Axis coverage is by case DECLARATION (a case tags the axes it drives). The `content`')
  out.push(
    '> axis is additionally BEHAVIOURALLY verified — the honesty test renders every fragment',
  )
  out.push(
    '> through the real reader; the other axes are declarative + verified live on the stand.',
  )
  out.push('')
  out.push('## Feature × fragments (content axis)')
  out.push('')
  out.push('| Feature | Fragments |')
  out.push('|---|--:|')
  for (const r of featureCoverage()) {
    out.push(`| \`${r.feature}\` | ${r.count} |`)
  }

  const gaps = coverageGaps()
  const hasGap = gaps.uncoveredAxes.length || gaps.untaggedCases.length || gaps.emptyFeatures.length
  out.push('')
  out.push(hasGap ? '## ⚠️ Gaps' : '## Gaps — none ✓')
  if (gaps.uncoveredAxes.length) {
    out.push(`- Uncovered axes: ${gaps.uncoveredAxes.join(', ')}`)
  }
  if (gaps.untaggedCases.length) {
    out.push(`- Cases with no axis: ${gaps.untaggedCases.join(', ')}`)
  }
  if (gaps.emptyFeatures.length) {
    out.push(`- Features with no fragment: ${gaps.emptyFeatures.join(', ')}`)
  }

  return out.join('\n') + '\n'
}
