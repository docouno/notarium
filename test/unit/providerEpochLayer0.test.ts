import { ESLint } from 'eslint'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = path.resolve(import.meta.dirname, '../..')
const RULE = 'provider-epochs/owned-facet-writes'
// Loading the flat config and its TypeScript plugins is the expensive part. Reusing one
// engine keeps this contract structural instead of making two cold ESLint startups race
// Vitest's ordinary five-second test timeout under CI contention.
const eslint = new ESLint({ cwd: REPO })
const WRITE = `export const mutate = (db: { prepare: (sql: string) => unknown }) =>
  db.prepare('UPDATE provider_resources SET base_url = ? WHERE id = ?')
`
const ALIASED_WRITE = `export const mutate = (db: { prepare: (sql: string) => unknown }) =>
  db.prepare('UPDATE provider_resources AS resource SET base_url = ? WHERE resource.id = ?')
`

const lintAs = async (relativePath: string, code = WRITE): Promise<string[]> => {
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO, relativePath) })

  return result.messages.filter(({ ruleId }) => ruleId === RULE).map(({ message }) => message)
}

describe('provider epoch write owner — layer 0', () => {
  it('refuses a provider facet update in a route or a new service', async () => {
    await expect(
      lintAs('packages/server/src/apps/server/routes/providerAttachments/probe.ts'),
    ).resolves.toHaveLength(1)
    await expect(
      lintAs('packages/server/src/services/providerRegistry/attachments/probe.ts', ALIASED_WRITE),
    ).resolves.toHaveLength(1)
  })

  it('allows only the facet owners and three named system paths', async () => {
    for (const owner of [
      'packages/server/src/services/metaDb/drivers/sqlite/credentials.ts',
      'packages/server/src/services/metaDb/drivers/pg/credentials.ts',
      'packages/server/src/services/metaDb/drivers/sqlite/providerResources.ts',
      'packages/server/src/services/metaDb/drivers/pg/providerResources.ts',
      'packages/server/src/services/metaDb/drivers/sqlite/providerCiphertexts.ts',
      'packages/server/src/services/metaDb/drivers/pg/providerCiphertexts.ts',
      'packages/server/src/services/metaDb/sqliteMetaDb.ts',
      'packages/server/src/services/metaDb/pgMetaDb.ts',
    ]) {
      await expect(lintAs(owner), owner).resolves.toEqual([])
    }
  })
})
