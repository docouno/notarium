// Public image identity for support and backup/restore compatibility checks.
// `--json` is the machine contract: the release entrypoint's smoke reads it to
// assert that a freshly built image really carries the revision it claims, and an
// operator's script can do the same against a running deployment.
// canon: docs/release.md#identity

import { buildInfo } from '../../../../libs/buildInfo'

const json = process.argv.slice(2).includes('--json')

if (json) {
  console.log(JSON.stringify(buildInfo))
} else {
  const details = [
    `notarium ${buildInfo.version}`,
    buildInfo.commit ? `commit ${buildInfo.commit}` : null,
    buildInfo.builtAt ? `built ${buildInfo.builtAt}` : null,
    buildInfo.source ? `source ${buildInfo.source}` : null,
  ].filter((value): value is string => value !== null)

  console.log(details.join(' · '))
}
