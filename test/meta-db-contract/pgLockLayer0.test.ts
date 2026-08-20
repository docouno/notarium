/**
 * Layer 0, checked as a RULE rather than as a state of the code.
 *
 * WHY: the observation gate can only recognize a lock that came through a helper, so
 * "every tiered lock is inside `lockOrder`/`revisionLocks`" is its premise, not a
 * detail. That premise lives in one ESLint block — and deleting the block leaves
 * `npm run lint` green, every test green, and the gate quietly blind: an inline
 * `client.query('… FOR UPDATE')` would take a lock nothing observes and nothing
 * orders. Round 6 of the implementation review found exactly that hole; this file is
 * the answer to it. It lints TEXT through the repo's own config, so the rule is
 * exercised, not restated.
 */
import { ESLint } from 'eslint'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = path.resolve(import.meta.dirname, '../..')
const DRIVER = 'packages/server/src/services/metaDb/drivers/pg'

const TIERED_LOCK_RULE = 'no-restricted-syntax'

/** Lint one snippet AS IF it were the given file, through the repo's flat config. */
const lintAs = async (relativePath: string, code: string): Promise<string[]> => {
  const eslint = new ESLint({ cwd: REPO })
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO, relativePath) })

  return result.messages
    .filter((message) => message.ruleId === TIERED_LOCK_RULE)
    .map((message) => message.message)
}

describe('Postgres lock order — layer 0', () => {
  it('refuses a tiered lock taken outside the two helper modules', async () => {
    const messages = await lintAs(
      `${DRIVER}/probe.ts`,
      `export const probe = async (client: { query: (sql: string) => Promise<unknown> }) => {
  await client.query('SELECT id FROM note_identity WHERE id = $1 FOR UPDATE')
}
`,
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/drivers\/pg\/lockOrder/)
  })

  it('sees the lock through ANY receiver, not one spelled `client`', async () => {
    // Half of this driver runs through `ctx.required.query`, so a rule keyed to a
    // variable name would leave a hole in its own foundation. The selector matches the
    // called MEMBER; this is the case that decided that.
    const messages = await lintAs(
      `${DRIVER}/probe.ts`,
      `export const probe = async (ctx: { required: { query: (sql: string) => Promise<unknown> } }) => {
  await ctx.required.query('SELECT 1 FROM note_identity FOR UPDATE')
}
`,
    )

    expect(messages).toHaveLength(1)
  })

  it('sees every row-lock strength, including the ones a first draft forgets', async () => {
    // `FOR KEY SHARE` is not a hypothetical: the first pattern missed it, and the
    // driver already had one — `agentDeltaCursors`, on `folders`, exempted as
    // "outside the hierarchy" and then left there when tier 4 gave that table a level
    // (L4f). It goes through `lockProjectParentRow` now, and the live gate levels a
    // lock statement by its table, so neither half rests on the inline note.
    const strengths = [
      'SELECT 1 FROM note_identity FOR NO KEY UPDATE',
      'SELECT 1 FROM note_identity FOR KEY SHARE',
      'SELECT 1 FROM note_identity FOR SHARE',
      'SELECT pg_advisory_xact_lock(1)',
      'LOCK TABLE note_identity IN SHARE ROW EXCLUSIVE MODE',
    ]

    for (const sql of strengths) {
      const messages = await lintAs(
        `${DRIVER}/probe.ts`,
        `export const probe = async (client: { query: (sql: string) => Promise<unknown> }) => {
  await client.query(\`${sql}\`)
}
`,
      )

      expect(messages, sql).toHaveLength(1)
    }
  })

  it('lets the helper modules take the locks they own', async () => {
    for (const owner of [`${DRIVER}/lockOrder.ts`, `${DRIVER}/revisionLocks.ts`]) {
      const messages = await lintAs(
        owner,
        `export const probe = async (client: { query: (sql: string) => Promise<unknown> }) => {
  await client.query('SELECT id FROM note_identity WHERE id = $1 FOR UPDATE')
}
`,
      )

      expect(messages, owner).toEqual([])
    }
  })

  it('leaves code outside the meta-DB driver alone', async () => {
    const messages = await lintAs(
      'packages/server/src/services/spaces/probe.ts',
      `export const probe = async (client: { query: (sql: string) => Promise<unknown> }) => {
  await client.query('SELECT 1 FROM somewhere FOR UPDATE')
}
`,
    )

    expect(messages).toEqual([])
  })
})
