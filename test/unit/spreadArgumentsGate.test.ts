/**
 * The spread-into-arguments fence (task 392), checked as a RULE through the repo's own
 * flat config — options are NOT restated here on purpose: with restored options,
 * deleting the config block would leave `npm run lint` green (the rule only forbids)
 * AND this file green, and the gate would be gone silently. That is the exact failure
 * `test/meta-db-contract/pgLockLayer0.test.ts` was written against; same shape here.
 */
import { ESLint } from 'eslint'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = path.resolve(import.meta.dirname, '../..')

const SPREAD_RULE = 'no-restricted-syntax'
const SPREAD_MESSAGE = /RangeError past ~125k/

/** Lint one snippet AS IF it were the given file, through the repo's flat config. */
const lintAs = async (relativePath: string, code: string): Promise<string[]> => {
  const eslint = new ESLint({ cwd: REPO })
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO, relativePath) })

  return result.messages
    .filter(
      (message) => message.ruleId === SPREAD_RULE && SPREAD_MESSAGE.test(message.message ?? ''),
    )
    .map((message) => message.message)
}

const PUSH_SPREAD = `export const probe = (out: number[], chunks: Uint8Array): void => {
  out.push(...chunks)
}
`

const MATH_SPREAD = `export const probe = (values: number[]): number => Math.max(...values)
`

const PUSH_LOOP = `export const probe = (out: number[], chunks: Uint8Array): void => {
  for (const byte of chunks) {
    out.push(byte)
  }
}
`

describe('spread-into-arguments fence', () => {
  it('refuses an argument spread of .push in a server-side package', async () => {
    expect(await lintAs('packages/core/src/libs/probe.ts', PUSH_SPREAD)).toHaveLength(1)
  })

  it('refuses a Math.min/max argument spread too — the second form that fired', async () => {
    expect(await lintAs('packages/engine/src/services/probe.ts', MATH_SPREAD)).toHaveLength(1)
  })

  it('passes the loop form the fence points to', async () => {
    expect(await lintAs('packages/core/src/libs/probe.ts', PUSH_LOOP)).toHaveLength(0)
  })

  // `web` is out on the boundary criterion (array lengths there are a function of
  // layout, not user data) — and that boundary must hold in config, not in a comment.
  it('does not apply to packages/web', async () => {
    expect(await lintAs('packages/web/src/probe.ts', PUSH_SPREAD)).toHaveLength(0)
  })

  // The silent hole: lockOrder.ts / revisionLocks.ts are ignored by BOTH narrow
  // no-restricted-syntax blocks (the pg lock block skips them by design, the spread
  // block skips the whole pg subtree to keep the lock selectors alive). With no
  // violation in them today, nothing else would ever notice them losing the fence —
  // and they are exactly where the next batch-shaped lock helper will be written.
  it('still covers the lock-order modules both narrow blocks ignore', async () => {
    expect(
      await lintAs('packages/server/src/services/metaDb/drivers/pg/lockOrder.ts', PUSH_SPREAD),
    ).toHaveLength(1)
    expect(
      await lintAs('packages/server/src/services/metaDb/drivers/pg/revisionLocks.ts', MATH_SPREAD),
    ).toHaveLength(1)
  })
})
