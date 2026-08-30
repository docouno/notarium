import { expect, it } from 'vitest'

import { runProviderScaleBench } from '../../scripts/providerScaleBench'

it(
  'prices startup, bounded MCP resolution, maintenance and retention on 10k provider records',
  { timeout: 60_000 },
  async () => {
    const report = await runProviderScaleBench(10_000)

    console.info(`provider-scale ${JSON.stringify(report)}`)
    expect(report).toMatchObject({
      records: 10_000,
      carriers: 20_000,
      unreadableImpacts: 20_000,
      whoamiHasModel: true,
      whoamiPortCalls: 8,
      whoamiMaxHydrated: 100,
      whoamiHydratedRows: 100,
      whoamiAllUnusableHasModel: false,
      whoamiAllUnusablePortCalls: 800,
      whoamiAllUnusableMaxHydrated: 100,
      whoamiAllUnusableHydratedRows: 10_000,
      effectiveRows: 101,
      effectiveTotal: 10_000,
      effectiveLaterRows: 101,
      effectivePortCalls: 8,
      effectiveLaterPortCalls: 8,
      effectiveMaxHydrated: 101,
      consentRows: 101,
      consentTotal: 10_000,
      consentLaterRows: 101,
      consentPortCalls: 3,
      consentLaterPortCalls: 3,
      consentMaxHydrated: 101,
      retargetReferences: 10_000,
      retargetAdmissions: 1,
      rotationBatches: 20,
      rotatedCarriers: 20_000,
      journalPruneBatches: 10,
      journalPruned: 10_000,
      journalRemaining: 3,
    })
    for (const milliseconds of [
      report.startupProbeMs,
      report.unreadablePlanMs,
      report.whoamiResolutionMs,
      report.whoamiAllUnusableMs,
      report.effectiveResolutionMs,
      report.effectiveLaterMs,
      report.consentProjectionMs,
      report.consentLaterMs,
      report.retargetMs,
      report.rotationMs,
      report.journalPruneMs,
    ]) {
      expect(milliseconds).toBeGreaterThanOrEqual(0)
    }
  },
)
