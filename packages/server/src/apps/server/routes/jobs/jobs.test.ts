// The synchronous import fallback's ERROR line, at the route that writes it.
//
// A terminal plan conflict after N notes has written N real notes, and this line
// is the only place a client of the synchronous path can learn that — it is the
// twin of the durable job's `result`. What carries it is one spread in a catch,
// and removing that spread left the whole import contour green.
//
// It stayed unobserved for a reason worth stating, and the reason is not that the
// archive has only two ways to be refused. Everything a Markdown tree refuses in
// PREFLIGHT — a destination collision inside the archive, frontmatter that will not
// serialize once the write path's own fields are added, two members claiming one
// identity, an unsafe path, a ceiling — is decided before a single byte is written
// and never reaches this catch at all. The branch exists for the conflicts that are
// only knowable AFTER writing has begun, and the store is where those come from: a
// destination that changed owner (`destinationOwnerConflict`, the refusal injected
// below) or a fence this job no longer holds. Hence the store as the seam.
//
// Of what does reach the catch, only an ImportPlanConflictError carries the work
// already done. A member that will not read back mid-pass arrives as a plain
// ImportError, and the line then carries the sentence alone.

import fastifyMultipart from '@fastify/multipart'
import AdmZip from 'adm-zip'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { STORE_ERROR_REASON } from '@notarium/core'

import type * as ImportService from '../../../../services/import'
import type { ApiRouteCtx } from '../_shared'
import { jobsRoutes } from './jobs'

/** Two seams for the two outcomes a real archive cannot produce here: a plan
 *  conflict whose `partial` is not a summary (the field is typed `unknown`, so
 *  nothing but this can ask what the route does when it fails the contract), and a
 *  summary carrying a repoint refusal (reaching one takes an unprovable rewrite,
 *  which is the rewriter's own test to write). Both null by default — every other
 *  test here runs the real import. */
const harness = vi.hoisted(() => ({
  refuse: null as (() => never) | null,
  answerWith: null as ImportService.ImportSummary | null,
}))

vi.mock('../../../../services/import', async (importOriginal) => {
  const actual = await importOriginal<typeof ImportService>()

  return {
    ...actual,
    runImport: async (args: Parameters<typeof actual.runImport>[0]) => {
      if (harness.refuse) {
        return harness.refuse()
      }

      return harness.answerWith ?? (await actual.runImport(args))
    },
  }
})

import { ImportPlanConflictError } from '../../../../services/import'

const BOUNDARY = '----notariumjobsboundary'

const multipart = (filename: string, content: Buffer) => ({
  payload: Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]),
  headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
})

const zipOf = (members: Array<{ name: string; title: string }>): Buffer => {
  const zip = new AdmZip()

  for (const member of members) {
    zip.addFile(
      member.name,
      Buffer.from(`---\ntitle: ${member.title}\n---\n\n# ${member.title}\n\nBody.\n`, 'utf8'),
    )
  }

  return zip.toBuffer()
}

const TREE = [
  { name: 'vault/a.md', title: 'A' },
  { name: 'vault/b.md', title: 'B' },
  { name: 'vault/c.md', title: 'C' },
]

type WriteInput = { id?: string; fileName?: string; title?: string }

/** The route with NO durable job layer — which is what selects the synchronous
 *  NDJSON fallback — over a store that answers one destination the way the
 *  identity guard would once writing has already begun. */
const appWith = async (refuse: (input: WriteInput) => boolean): Promise<FastifyInstance> => {
  const app = Fastify()

  await app.register(fastifyMultipart, {
    limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 4 },
  })
  app.addHook('onRequest', async (req) => {
    Object.assign(req, {
      spaceId: 'S',
      principal: { id: 'user:a', username: 'a', admin: false },
    })
  })
  let minted = 0
  const store = {
    list: async () => [],
    checkpoint: async () => {},
    write: async (input: WriteInput) => {
      if (refuse(input)) {
        throw Object.assign(
          new Error(`imported/vault/${input.fileName}.md is owned by stranger-1`),
          { reason: STORE_ERROR_REASON.destinationOwnerConflict },
        )
      }

      return { id: input.id ?? `n${++minted}` }
    },
  }

  await jobsRoutes(app, {
    spaceStoreFor: async () => store,
    principalId: () => 'user:a',
  } as unknown as ApiRouteCtx)

  return app
}

type Line = {
  type: string
  error?: string
  repointFailed?: number
  partial?: { imported: number; failed: number; created: string[] }
}

const ndjson = (payload: string): Line[] =>
  payload
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line)

let app: FastifyInstance | null = null
afterEach(async () => {
  await app?.close()
  app = null
  harness.refuse = null
  harness.answerWith = null
})

const importTree = async (
  members: Array<{ name: string; title: string }>,
  refuse: (input: WriteInput) => boolean = () => false,
) => {
  app = await appWith(refuse)

  const res = await app.inject({
    method: 'POST',
    url: '/api/s/main/import',
    ...multipart('vault.zip', zipOf(members)),
  })

  expect(res.statusCode).toBe(200)

  return ndjson(res.payload)
}

describe('POST /import, synchronous fallback: what the error line carries (#302)', () => {
  it('rides the work already done out on the error line', async () => {
    const lines = await importTree(TREE, (input) => input.fileName === 'b')
    const error = lines.find((line) => line.type === 'error')

    expect(lines.find((line) => line.type === 'done')).toBeUndefined()
    expect(error?.error).toMatch(/owned by stranger-1/)
    // One note of the three really landed, and without this the client is shown a
    // sentence that reads exactly like an import which changed nothing.
    expect(error?.partial).toMatchObject({ imported: 1, skipped: 0, failed: 0 })
    expect(error?.partial?.created).toHaveLength(1)
  })

  // The other half of the same contract, and the reason the branch above went
  // unobserved: a refusal the PREFLIGHT reaches is thrown with nothing written, so
  // there is no partial to carry and the line must not invent one. Every
  // archive-level refusal is of this kind — the collision below, an unserializable
  // frontmatter, a duplicate identity claim — which is why none of them would have
  // exercised the branch above.
  it('carries no partial when the refusal was decided before the first write', async () => {
    const lines = await importTree([
      { name: 'vault/Hello.md', title: 'Hello' },
      { name: 'vault/hello.md', title: 'Hello' },
    ])
    const error = lines.find((line) => line.type === 'error')

    expect(error?.error).toMatch(/destination collision/)
    expect(error).not.toHaveProperty('partial')
  })

  // The partial is validated before the line is built, not inside it. Validating it
  // inside meant a throw from the parse escaped into the `finally`, which ends the
  // response — leaving the client a stream with neither `done` NOR `error`, the very
  // outcome this branch is here to prevent. Unreachable from a real import today,
  // and held by a convention rather than by a type: `partial` is `unknown`.
  it('still writes the error line when the partial is not a summary at all', async () => {
    harness.refuse = () => {
      throw new ImportPlanConflictError('vault/b.md: the plan no longer holds', {
        imported: 'two',
      })
    }
    const lines = await importTree(TREE)
    const error = lines.find((line) => line.type === 'error')

    expect(error?.error).toMatch(/the plan no longer holds/)
    // The counts are what a partial we cannot vouch for costs. The sentence is not.
    expect(error).not.toHaveProperty('partial')
  })

  // The `done` line is built by a schema, and a schema STRIPS what it does not
  // declare. So a counter the collector fills and the tab renders can still vanish
  // between them — silently, over one line missing from the contract — and only a
  // synchronous import would ever be the one to lose it.
  it('keeps the repoint counter on the line it answers with', async () => {
    harness.answerWith = {
      imported: 3,
      skipped: 0,
      failed: 0,
      files: [],
      errors: [],
      repointFailed: 2,
      created: [],
    }
    const lines = await importTree(TREE)

    expect(lines.find((line) => line.type === 'done')?.repointFailed).toBe(2)
  })
})
