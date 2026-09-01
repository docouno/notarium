import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  ACTIVITY_GROUPS_MANIFEST_SHA256,
  type ActivityGroupsBenchReport,
  activityGroupsGateFailures,
  type ActivityGroupsManifest,
} from './activityGroupsBenchGates'

const manifestPath =
  process.env.ACTIVITY_GROUPS_MANIFEST ?? 'test/cases/manifests/activity-groups-v1.json'
const reportPath = process.env.ACTIVITY_GROUPS_REPORT

if (!reportPath) {
  throw new Error('ACTIVITY_GROUPS_REPORT is required')
}
const manifestBytes = readFileSync(manifestPath)
const manifestHash = createHash('sha256').update(manifestBytes).digest('hex')

if (manifestHash !== ACTIVITY_GROUPS_MANIFEST_SHA256) {
  throw new Error(
    `activity groups manifest hash mismatch: expected ${ACTIVITY_GROUPS_MANIFEST_SHA256}, got ${manifestHash}`,
  )
}
const manifest = JSON.parse(manifestBytes.toString('utf8')) as ActivityGroupsManifest
const report = JSON.parse(readFileSync(reportPath, 'utf8')) as ActivityGroupsBenchReport
const failures = activityGroupsGateFailures(report, manifest)

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`activity groups gate passed: ${report.latency.length} latency cells`)
}
