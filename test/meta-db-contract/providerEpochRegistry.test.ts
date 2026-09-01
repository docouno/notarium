import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const REPO = path.resolve(import.meta.dirname, '../..')
const META = path.join(REPO, 'packages/server/src/services/metaDb')

const relative = (file: string) => path.relative(REPO, file).replaceAll(path.sep, '/')

const providerDriverFiles = (dialect: 'sqlite' | 'pg') => {
  const directory = path.join(META, 'drivers', dialect)
  return readdirSync(directory)
    .filter((name) => name === 'credentials.ts' || /^provider.*\.ts$/u.test(name))
    .map((name) => path.join(directory, name))
}

const scannedFiles = (): string[] =>
  [
    ...providerDriverFiles('sqlite'),
    ...providerDriverFiles('pg'),
    path.join(META, 'sqliteMetaDb.ts'),
    path.join(META, 'pgMetaDb.ts'),
    path.join(REPO, 'packages/server/src/services/credentialKeyring/credentialKeyring.ts'),
    path.join(REPO, 'packages/server/src/apps/server/commands/admin/main.ts'),
  ].sort()

const EXPECTED_SCAN_ZONE = [
  'packages/server/src/services/metaDb/drivers/sqlite/credentials.ts',
  'packages/server/src/services/metaDb/drivers/sqlite/providerAttachments.ts',
  'packages/server/src/services/metaDb/drivers/sqlite/providerCallLog.ts',
  'packages/server/src/services/metaDb/drivers/sqlite/providerCiphertexts.ts',
  'packages/server/src/services/metaDb/drivers/sqlite/providerResources.ts',
  'packages/server/src/services/metaDb/drivers/pg/credentials.ts',
  'packages/server/src/services/metaDb/drivers/pg/providerAttachments.ts',
  'packages/server/src/services/metaDb/drivers/pg/providerCallLog.ts',
  'packages/server/src/services/metaDb/drivers/pg/providerCiphertexts.ts',
  'packages/server/src/services/metaDb/drivers/pg/providerResources.ts',
  'packages/server/src/services/metaDb/sqliteMetaDb.ts',
  'packages/server/src/services/metaDb/pgMetaDb.ts',
  'packages/server/src/services/credentialKeyring/credentialKeyring.ts',
  'packages/server/src/apps/server/commands/admin/main.ts',
].sort()

const methodName = (node: ts.Node): string | null => {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
      return current.name.text
    }
    if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name)) {
      return current.name.text
    }
  }

  return null
}

const mutators = (): string[] => {
  const found = new Set<string>()

  for (const file of scannedFiles()) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )

    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        /\bUPDATE\s+(?:credentials|provider_resources)(?:\s+AS\s+\w+)?\s+SET\b/iu.test(node.text)
      ) {
        const method = methodName(node)

        if (!method) {
          throw new Error(`provider facet write without an owning method: ${relative(file)}`)
        }
        found.add(`${relative(file)}:${method}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  return [...found].sort()
}

describe('provider consent epoch mutation registry', () => {
  it('declares the exact non-empty scan zone, including both named system call trees', () => {
    expect(scannedFiles().map(relative)).toEqual(EXPECTED_SCAN_ZONE)
    expect(scannedFiles()).not.toHaveLength(0)
  })

  it('classifies every write as a route helper, system path, or retarget exception', () => {
    expect(mutators()).toEqual(
      [
        'packages/server/src/services/metaDb/drivers/pg/credentials.ts:mutate',
        'packages/server/src/services/metaDb/drivers/pg/providerCiphertexts.ts:purgeUnreadable',
        'packages/server/src/services/metaDb/drivers/pg/providerCiphertexts.ts:rewrapBatch',
        'packages/server/src/services/metaDb/drivers/pg/providerResources.ts:recordLastCheck',
        'packages/server/src/services/metaDb/drivers/pg/providerResources.ts:replaceIfRuntimeEpoch',
        'packages/server/src/services/metaDb/drivers/sqlite/credentials.ts:mutate',
        'packages/server/src/services/metaDb/drivers/sqlite/providerCiphertexts.ts:purgeUnreadable',
        'packages/server/src/services/metaDb/drivers/sqlite/providerCiphertexts.ts:rewrapBatch',
        'packages/server/src/services/metaDb/drivers/sqlite/providerResources.ts:recordLastCheck',
        'packages/server/src/services/metaDb/drivers/sqlite/providerResources.ts:replaceIfRuntimeEpoch',
        'packages/server/src/services/metaDb/pgMetaDb.ts:retargetProviderCredential',
        'packages/server/src/services/metaDb/sqliteMetaDb.ts:retargetProviderCredential',
      ].sort(),
    )
  })
})
