import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const repo = fileURLToPath(new URL('../../', import.meta.url))
let doc = ''

beforeAll(async () => {
  doc = await readFile(join(repo, 'docs/providers.md'), 'utf8')
})

describe('provider operator canon', () => {
  it('names every current lifecycle and recovery surface', () => {
    for (const heading of [
      '## Ownership and resolution',
      '## Credentials',
      '## Network policy',
      '## Local provider reachability',
      '## Validation, calls and limits',
      '## Consent lifecycle',
      '## Credential keyring',
      '## Backup, restore and recovery',
      '## System-owned resources',
      '## Measured provider shapes',
      '## Guarantees',
      '## Non-guarantees',
    ]) {
      expect(doc).toContain(heading)
    }
    expect(doc).toContain('PROVIDERS_PRIVATE_ORIGINS')
    expect(doc).toContain('reconcile-credential-keyring --expected-key-id')
    expect(doc).toContain('purge-unreadable-secrets --expected-key-id')
    expect(doc).toContain('two-step `--apply` flow')
    expect(doc).toContain('full access to the entire instance')
    expect(doc).toContain('cannot be revoked in password mode')
  })

  it('keeps the reachability and backup prices literal', () => {
    expect(doc).toContain('inside `DATA_DIR` but outside every root')
    expect(doc).toContain('hard-links or')
    expect(doc).toContain('Notarium does **not**\nrecommend it')
    expect(doc).toContain('does not claim to probe whether a server is live')
    expect(doc).not.toContain('PROVIDERS_PRIVATE_NETWORK')
    expect(doc).not.toMatch(/keyring (?:is|must stay) outside `?DATA_DIR`?/iu)
    expect(doc).not.toMatch(/command checks (?:that )?the server is stopped/iu)
  })

  it('publishes synthetic measurement numbers without captured bodies', () => {
    for (const fact of [
      '60,440,334 bytes',
      '124,020,823 bytes',
      '90,150,498 bytes',
      'median 876 ms',
      'Cold TTFT medians were 4.03 s',
      '120 s',
    ]) {
      expect(doc).toContain(fact)
    }
    expect(doc).toContain('no captured provider body')
  })
})
