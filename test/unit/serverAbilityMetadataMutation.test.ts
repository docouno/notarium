import type { FastifyInstance } from 'fastify'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decodeAbilityLocator } from '@notarium/core'
import { SpaceResourceAuthority } from '@notarium/engine'
import { createServer } from '../../packages/server/src/apps/server/server'

type Rpc = {
  result?: {
    isError?: boolean
    structuredContent?: Record<string, unknown>
    content?: Array<{ text?: string }>
  }
}

// Criterion 1 of the brief is the one wall clock this row is entitled to keep:
// the metadata `edit_ability` — a semantic no-op here — has to answer inside a
// second on the production composition, and that number is the thing under
// proof. Nothing else here is bounded by the brief, and a budget on a progress
// poll would only turn a loaded machine into a verdict (IMPL-35).
const within = async <T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation exceeded ${milliseconds} ms`)),
          milliseconds,
        )
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

// Teardown's own backstop, deliberately below `hookTimeout` so the hook survives
// a shutdown that does not settle, still restores mocks and removes the tree —
// and then FAILS, which is why it is a budget and not a log line. This row parks
// nothing, so a shutdown that will not settle is left-behind server work and
// nothing else; reporting it to stderr under a green row is how it stayed unread.
const CLOSE_BUDGET_MS = 10_000

// The per-row cap sits above the poll budgets below so a loaded machine cannot
// be killed by the runner before the one assertion that measures time — the
// `edit_ability` fenced at a second — has had its say.
vi.setConfig({ hookTimeout: 20_000, testTimeout: 30_000 })

const waitUntil = async (
  predicate: () => Promise<boolean>,
  milliseconds = 15_000,
): Promise<void> => {
  const deadline = Date.now() + milliseconds

  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`condition was not met within ${milliseconds} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const toolText = (rpc: Rpc): string =>
  rpc.result?.content?.map(({ text }) => text ?? '').join('\n') ?? ''

describe('production Owned ability metadata mutation', () => {
  let root: string
  let app: FastifyInstance | undefined
  let cookie = ''
  let token = ''
  let personalSlug = ''
  let rpcId = 0

  const call = async (name: string, args: Record<string, unknown>): Promise<Rpc> => {
    const response = await app!.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args },
      },
    })

    expect(response.statusCode, response.body).toBe(200)
    return response.json() as Rpc
  }

  const pollStatus = async (): Promise<string | null> => {
    const response = await app!.inject({
      method: 'GET',
      url: `/api/s/${personalSlug}/status`,
      headers: { cookie },
    })

    expect(response.statusCode, response.body).toBe(200)
    return (response.json() as { delta: { lastPollAt: string | null } }).delta.lastPollAt
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'notarium-ability-metadata-'))
    await mkdir(join(root, 'spaces'))
    app = await createServer({
      spaces: [],
      spacesRoot: join(root, 'spaces'),
      metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
      authMode: 'password',
      engineDataDir: join(root, 'engine'),
      jobsDataDir: join(root, 'jobs'),
      importStagingDir: join(root, 'jobs', 'imports'),
      pollIntervalMs: 10,
      replayKeyring: {
        path: join(root, 'replay-keys'),
        topology: 'canonical-local',
      },
    })
    await app.ready()

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'alice', displayName: 'Alice', password: 'alice-password-1' },
    })

    expect(setup.statusCode, setup.body).toBe(200)
    cookie = String(setup.headers['set-cookie']).split(';')[0]!
    personalSlug = (setup.json() as { personalSpace: string }).personalSpace
    await mkdir(join(root, 'spaces', personalSlug, '.notarium', 'profile'), { recursive: true })
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/me/tokens',
      headers: { cookie },
      payload: { name: 'Codex', scope: 'write' },
    })

    expect(tokenResponse.statusCode, tokenResponse.body).toBe(201)
    token = (tokenResponse.json() as { token: string }).token
  })

  afterEach(async () => {
    // Restoring the prototype spies and deleting the temp tree must not depend on
    // a shutdown that may itself be the thing that hung: a row that fails while a
    // mock still holds server work would otherwise eat the whole hook and leak
    // that spy into every row after it. The shutdown verdict is raised only after
    // that cleanup, so an unsettled `close()` fails the file instead of printing
    // under a green row.
    let shutdownFailure: unknown

    try {
      await within(app?.close() ?? Promise.resolve(), CLOSE_BUDGET_MS)
    } catch (error) {
      shutdownFailure = error
    } finally {
      app = undefined
      vi.restoreAllMocks()
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
    if (shutdownFailure) {
      throw new Error(`server close did not settle: ${(shutdownFailure as Error).message}`, {
        cause: shutdownFailure,
      })
    }
  })

  it('keeps self-linked wrong-kind Role metadata bounded and releases package admission', async () => {
    const created = await call('create_ability', {
      kind: 'role',
      name: 'self-linked-metadata',
      description: 'Exercise metadata without loading Role dependencies.',
      instructions: '# Self-linked metadata\n\nThe package remains readable.',
      placement: { home: 'personal' },
      idempotencyKey: 'self-linked-metadata-one',
    })

    expect(created.result?.isError, toolText(created)).not.toBe(true)
    const ref = created.result!.structuredContent!.ref as string
    const locator = decodeAbilityLocator(ref)

    expect(locator).toMatchObject({ source: 'owned', kind: 'role' })
    if (!locator || locator.source !== 'owned' || locator.kind !== 'role') {
      throw new Error('create_ability returned no Owned Role locator')
    }
    const manifestPath = join(
      root,
      'spaces',
      personalSlug,
      '.notarium',
      'skills',
      locator.packageId,
      'SKILL.md',
    )
    const manifest = await readFile(manifestPath, 'utf8')
    const selfLink = `[[notarium-id:personal:${locator.packageId}|self]]`
    const linkedManifest = manifest.replace(
      '  notarium.kind: role\n',
      `  notarium.kind: role\n  notarium.skills: "${selfLink}"\n`,
    )

    expect(linkedManifest).not.toBe(manifest)
    await writeFile(manifestPath, linkedManifest)

    // Deliberately unbudgeted: the ≤1 s bound belongs to the metadata mutation
    // below, which is what this row proves stays bounded. This read is a
    // progress poll driven by `waitUntil` — putting the mutation's budget on a
    // retried observation makes one slow read a verdict instead of a retry.
    const readRole = async (): Promise<Record<string, unknown>> => {
      const read = await call('get_ability', { ref })

      expect(read.result?.isError, toolText(read)).not.toBe(true)
      return read.result!.structuredContent!
    }

    await waitUntil(async () => {
      const detail = await readRole()
      const ability = detail.ability as
        { health?: { attachments?: Array<{ health?: string }> } } | undefined

      return ability?.health?.attachments?.[0]?.health === 'wrong-kind'
    })
    await waitUntil(async () => (await pollStatus()) !== null)
    const pollBefore = await pollStatus()
    const authorities = new Set<SpaceResourceAuthority>()
    const admitPackage = SpaceResourceAuthority.prototype.admitPackage

    vi.spyOn(SpaceResourceAuthority.prototype, 'admitPackage').mockImplementation(async function (
      this: SpaceResourceAuthority,
      path,
      mode,
      owner,
      options,
    ) {
      authorities.add(this)
      return admitPackage.call(this, path, mode, owner, options)
    })

    const edited = await within(call('edit_ability', { ref, enabled: true }))

    expect(edited.result?.isError, toolText(edited)).not.toBe(true)
    expect(edited.result?.structuredContent).toMatchObject({
      steps: [{ step: 'enabled', outcome: 'skipped' }],
    })
    await waitUntil(async () => (await pollStatus()) !== pollBefore)
    const after = await readRole()

    expect(after).toMatchObject({
      ability: {
        enabled: true,
        health: { healthy: false, attachments: [{ health: 'wrong-kind' }] },
      },
    })
    expect(authorities.size).toBeGreaterThan(0)
    expect([...authorities].flatMap((authority) => authority.diagnostics())).toEqual([])
  })
})
