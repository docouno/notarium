// The orchestration between a frozen plan and the write path: what reaches
// `store.write`, what the progress callback says while it happens, and what a
// refusal is called.
//
// These run against `runImport` itself rather than a store contract, because the
// question here is not whether the engine can guard a destination — it is whether
// the import ASKS it to, and reacts to the answer.

import AdmZip from 'adm-zip'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { STORE_ERROR_REASON } from '@notarium/core'

import { runImport, type RunImportArgs } from './importService'
import { ImportPlanConflictError } from './markdownTree'
import type { ImportProgress } from './types'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notarium-import-svc-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

type Member = { name: string; body: string }

const uploadOf = async (members: Member[], name = 'vault.zip'): Promise<string> => {
  const zip = new AdmZip()

  for (const member of members) {
    zip.addFile(member.name, Buffer.from(member.body, 'utf8'))
  }
  const path = join(dir, name)

  await writeFile(path, zip.toBuffer())

  return path
}

const NOTE = (title: string) => `# ${title}\n\nBody of ${title}.\n`

type WriteCall = {
  fileName?: string
  directory?: string
  id?: string
  expectedDestinationId?: string | null
  title?: string
}

/** A store that records exactly what the import asked it to write. `existing` is
 *  the destination inventory the plan is settled against; `refuse` lets a test
 *  answer one destination the way the engine's own guard would. */
const storeOf = (
  existing: Array<{ id: string; filePath: string }> = [],
  refuse?: (input: WriteCall) => { reason: string; message: string } | undefined,
) => {
  const writes: WriteCall[] = []
  let minted = 0

  return {
    writes,
    store: {
      list: async () => existing,
      checkpoint: async () => {},
      write: async (input: WriteCall) => {
        const refusal = refuse?.(input)

        if (refusal) {
          throw Object.assign(new Error(refusal.message), { reason: refusal.reason })
        }
        writes.push(input)

        return { id: input.id ?? `minted-${++minted}` }
      },
    },
  }
}

const importOf = async (
  uploadPath: string,
  store: ReturnType<typeof storeOf>['store'],
  over: Partial<RunImportArgs> = {},
) =>
  await runImport({
    store: store as never,
    uploadPath,
    tempDir: dir,
    filename: 'vault.zip',
    principal: 'user:a',
    root: 'imported',
    ...over,
  })

describe('what the import asks the write path for (#302)', () => {
  // The plan proves what stands at each destination; the write path re-proves it
  // under its publishing swap. Neither is worth anything if the import does not
  // carry the answer across, and nothing above this line can see that it did.
  it('carries the planned occupant of every destination into the write', async () => {
    const upload = await uploadOf([
      { name: 'vault/a.md', body: NOTE('A') },
      { name: 'vault/b.md', body: NOTE('B') },
    ])
    const { store, writes } = storeOf([{ id: 'existing-b', filePath: 'imported/vault/b.md' }])

    await importOf(upload, store)

    // `null` is a claim, not an absence: it says the plan proved this path FREE,
    // and an unguarded create would silently take whatever appeared since.
    expect(writes.map((w) => w.expectedDestinationId)).toEqual([null, 'existing-b'])
    expect(writes[1].id).toBe('existing-b')
  })

  it('stops the run when a destination changed owner between plan and write', async () => {
    const upload = await uploadOf([
      { name: 'vault/a.md', body: NOTE('A') },
      { name: 'vault/b.md', body: NOTE('B') },
      { name: 'vault/c.md', body: NOTE('C') },
    ])
    const { store, writes } = storeOf([], (input) =>
      input.fileName === 'b'
        ? {
            reason: STORE_ERROR_REASON.destinationOwnerConflict,
            message: 'imported/vault/b.md is owned by stranger-1; the import planned to create it',
          }
        : undefined,
    )
    const failure = await importOf(upload, store).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(ImportPlanConflictError)
    expect((failure as Error).message).toMatch(/owned by stranger-1/)
    // Terminal, not a per-note error: the plan this run executes no longer holds,
    // so the remaining members are not attempted.
    expect(writes.map((w) => w.fileName)).toEqual(['a'])
  })

  // A retry replaying its own first attempt: the plan proved the path free, and
  // the note standing there now is the one this very plan wrote before the worker
  // died. `skipExisting` asked for exactly this to be skipped, and the layer that
  // knows whose note it is has already let it through — a stranger would have been
  // refused as an owner conflict and never reached here. Deciding it again from the
  // plan field is what killed durable retry.
  it('replays its own first attempt as a skip and keeps going', async () => {
    const upload = await uploadOf([
      { name: 'vault/a.md', body: NOTE('A') },
      { name: 'vault/b.md', body: NOTE('B') },
    ])
    const { store, writes } = storeOf([], (input) =>
      input.fileName === 'a'
        ? { reason: STORE_ERROR_REASON.noteAlreadyExists, message: 'a note already exists' }
        : undefined,
    )
    const summary = await importOf(upload, store, { skipExisting: true })

    expect(summary).toMatchObject({ skipped: 1, imported: 1, failed: 0 })
    // The run did NOT stop at the replayed member: the rest of the tree still landed.
    expect(writes.map((w) => w.fileName)).toEqual(['b'])
  })

  // The third leg of the same catch, and the one the brief keeps in force: the
  // existing partial-import model. A store failure that says nothing about the PLAN
  // is one note's failure — the rest of the tree still imports, and the summary is
  // honest about which one did not. Making it terminal instead left 159 tests green.
  it('records an ordinary write failure per note and imports the rest', async () => {
    const upload = await uploadOf([
      { name: 'vault/a.md', body: NOTE('A') },
      { name: 'vault/b.md', body: NOTE('B') },
      { name: 'vault/c.md', body: NOTE('C') },
    ])
    const { store, writes } = storeOf([], (input) =>
      // No `reason`: neither an occupied destination nor a changed owner — just a
      // write that did not work, which is what the store answers most of the time.
      input.fileName === 'b' ? { reason: '', message: 'disk went away' } : undefined,
    )
    const summary = await importOf(upload, store)

    expect(summary).toMatchObject({ imported: 2, skipped: 0, failed: 1 })
    expect(summary.errors).toEqual([{ title: 'B', error: 'disk went away' }])
    // The run did not stop at the failure: the member AFTER it landed too.
    expect(writes.map((w) => w.fileName)).toEqual(['a', 'c'])
  })

  it('still calls the note the plan already saw a skip', async () => {
    const upload = await uploadOf([{ name: 'vault/a.md', body: NOTE('A') }])
    const { store } = storeOf([{ id: 'existing-a', filePath: 'imported/vault/a.md' }], () => ({
      reason: STORE_ERROR_REASON.noteAlreadyExists,
      message: 'a note already exists at imported/vault/a.md',
    }))
    const summary = await importOf(upload, store, { skipExisting: true })

    expect(summary).toMatchObject({ skipped: 1, imported: 0, failed: 0 })
  })
})

describe('progress while a tree is written (#302)', () => {
  // The bar tracks WORK. A run where members are skipped is the case that tells
  // the two counters apart: pinning only the handler's final report let `done`
  // and `total` be anything at all in between.
  it('knows the total before the first write and counts processed, not imported', async () => {
    const upload = await uploadOf([
      { name: 'vault/a.md', body: NOTE('A') },
      { name: 'vault/b.md', body: NOTE('B') },
      { name: 'vault/c.md', body: NOTE('C') },
    ])
    const { store } = storeOf([{ id: 'existing-b', filePath: 'imported/vault/b.md' }], (input) =>
      input.expectedDestinationId
        ? {
            reason: STORE_ERROR_REASON.noteAlreadyExists,
            message: 'a note already exists',
          }
        : undefined,
    )
    const seen: ImportProgress[] = []

    await importOf(upload, store, {
      skipExisting: true,
      progressEvery: 1,
      onProgress: (progress) => {
        seen.push({ ...progress })
      },
    })

    // The determinate total exists the moment the plan does — before a byte is
    // written — and every snapshot afterwards carries it.
    expect(seen[0]).toEqual({ phase: 'writing', done: 0, total: 3, imported: 0 })
    expect(seen.every((p) => p.total === 3)).toBe(true)
    // `done` advances on the skipped member; `imported` does not. Reporting only
    // successful writes would show a 3-file import stuck at 2.
    expect(seen.map((p) => `${p.done}/${p.imported}`)).toEqual(['0/0', '1/1', '2/1', '3/2', '3/2'])
  })
})

describe('a source file’s own diagnostics (#302)', () => {
  // An unreadable identity claim imports as an ordinary fresh note — but silently
  // would mean the user never learns that the links naming that id went nowhere.
  it('reports an unreadable notarium-id instead of swallowing it', async () => {
    const upload = await uploadOf([
      { name: 'vault/a.md', body: '---\nnotarium-id: [not, a, scalar]\n---\n# A\n\nAlpha.\n' },
    ])
    const { store, writes } = storeOf()
    const summary = await importOf(upload, store)

    expect(summary.files[0].warnings).toEqual([expect.stringMatching(/unreadable notarium-id/)])
    expect(summary.imported).toBe(1)
    // Still an ordinary import under a fresh identity — the warning is the only
    // difference the claim makes.
    expect(writes[0].id).toBeTruthy()
  })
})

describe('cancelling a run (#302)', () => {
  it('stops a foreign import at the note the cancel arrived on', async () => {
    const path = join(dir, 'conversations.json')

    await writeFile(
      path,
      JSON.stringify(
        ['one', 'two', 'three'].map((name, i) => ({
          uuid: `c-${i}`,
          name,
          created_at: '2024-01-01T00:00:00Z',
          chat_messages: [{ sender: 'human', text: 'hi', created_at: '2024-01-01T00:00:00Z' }],
        })),
      ),
    )
    const controller = new AbortController()
    const writes: string[] = []
    const store = {
      list: async () => [],
      checkpoint: async () => {},
      write: async (input: { title?: string }) => {
        writes.push(input.title ?? '')
        controller.abort()

        return { id: `n${writes.length}` }
      },
    }

    // A bare JSON upload has no per-member boundary to check: the cancel between
    // two notes of ONE array is caught here or not at all.
    await expect(
      runImport({
        store: store as never,
        uploadPath: path,
        tempDir: dir,
        filename: 'conversations.json',
        principal: 'user:a',
        signal: controller.signal,
      }),
    ).rejects.toThrow(/canceled/)
    expect(writes).toHaveLength(1)
  })

  it('stops a tree import at the member the cancel arrived on', async () => {
    const upload = await uploadOf([
      { name: 'vault/a.md', body: NOTE('A') },
      { name: 'vault/b.md', body: NOTE('B') },
      { name: 'vault/c.md', body: NOTE('C') },
    ])
    const controller = new AbortController()
    const { store, writes } = storeOf()
    const abortingStore = {
      ...store,
      write: async (input: WriteCall) => {
        const result = await store.write(input)

        controller.abort()

        return result
      },
    }

    await expect(
      importOf(upload, abortingStore as never, { signal: controller.signal }),
    ).rejects.toThrow(/canceled/)
    expect(writes.map((w) => w.fileName)).toEqual(['a'])
  })
})

describe('the durable plan seam (#302)', () => {
  // `publish` returning null is a failure to publish, not "there is no sidecar".
  // Folding the two into one `??` let a durable run keep writing from a plan no
  // retry could ever read back — the in-memory plan the design forbids.
  it('refuses to write from an unpublished plan, retryably', async () => {
    const upload = await uploadOf([{ name: 'vault/a.md', body: NOTE('A') }])
    const { store, writes } = storeOf()
    const failure = await importOf(upload, store, {
      uploadRef: 'S/job.import',
      planStore: { load: async () => null, publish: async () => null, persistedPhase: null },
    }).catch((err: unknown) => err)

    expect((failure as Error).message).toMatch(/not published durably/)
    // NOT an ImportError: the next attempt may well publish fine, so the job keeps
    // its retry budget instead of dying terminally on a transient disk fault.
    expect(failure).not.toBeInstanceOf(ImportPlanConflictError)
    expect(writes).toHaveLength(0)
  })

  it('writes under the identities the published plan settled on', async () => {
    const upload = await uploadOf([{ name: 'vault/a.md', body: NOTE('A') }])
    const { store, writes } = storeOf()
    let published: unknown = null

    await importOf(upload, store, {
      uploadRef: 'S/job.import',
      planStore: {
        load: async () => null,
        publish: async (plan) => {
          published = plan

          return plan
        },
        persistedPhase: null,
      },
    })

    expect(writes[0].id).toBe(
      (published as { entries: Array<{ targetId: string }> }).entries[0].targetId,
    )
  })

  it('refuses a canonical winner that belongs to another staged upload', async () => {
    const upload = await uploadOf([{ name: 'vault/a.md', body: NOTE('A') }])
    const { store, writes } = storeOf()
    const failure = await importOf(upload, store, {
      uploadRef: 'S/job.import',
      planStore: {
        load: async () => null,
        publish: async (plan) => ({ ...plan, uploadRef: 'S/another-job.import' }),
        persistedPhase: null,
      },
    }).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(ImportPlanConflictError)
    expect(writes).toHaveLength(0)
  })

  // Replacing an unreadable old-build sidecar is a read/rename sequence, not a
  // filesystem CAS. The current job fence must span it so a reaped worker cannot
  // overwrite the plan its newer claimant just published.
  it('claims first and publishes the durable plan inside the job fence', async () => {
    const upload = await uploadOf([{ name: 'vault/a.md', body: NOTE('A') }])
    const { store } = storeOf()
    const order: string[] = []
    let fenced = false

    await importOf(upload, store, {
      uploadRef: 'S/job.import',
      planStore: {
        load: async () => null,
        publish: async (plan) => {
          expect(fenced).toBe(true)
          order.push('publish')

          return plan
        },
        persistedPhase: null,
      },
      reservation: {
        claim: async () => {
          order.push('claim')
        },
        fenced: async (_destination, write) => {
          fenced = true
          try {
            return await write()
          } finally {
            fenced = false
          }
        },
      },
    })

    expect(order).toEqual(['claim', 'publish'])
  })
})

// The gate that refuses to rebuild a missing plan is a statement about a TREE:
// only a tree ever publishes a sidecar. Asked of every auto-detected ZIP — which
// is what the web sends, since it forces no `format` — it failed the ordinary
// Claude/ChatGPT archive for lacking a plan it never has.
describe('the plan gate and an archive that never publishes a plan (#302)', () => {
  const foreignZip = async () => {
    const zip = new AdmZip()

    zip.addFile(
      'conversations.json',
      Buffer.from(
        JSON.stringify([
          {
            uuid: 'c-1',
            name: 'Chat',
            created_at: '2024-01-01T00:00:00Z',
            chat_messages: [{ sender: 'human', text: 'hi', created_at: '2024-01-01T00:00:00Z' }],
          },
        ]),
        'utf8',
      ),
    )
    const path = join(dir, 'export.zip')

    await writeFile(path, zip.toBuffer())

    return path
  }

  // `writing` is a reap-reclaim mid-run; `done` is the crash window between the
  // handler persisting the phase and the runner recording the success. Both used
  // to turn a foreign import terminal — the second one after it had ALREADY
  // imported everything.
  it.each([['writing'], ['done']])(
    'imports a foreign archive re-claimed at phase %s',
    async (persistedPhase) => {
      const { store, writes } = storeOf()
      let published = 0
      const summary = await importOf(await foreignZip(), store, {
        uploadRef: 'S/job.import',
        planStore: {
          load: async () => null,
          publish: async () => {
            published++

            return null
          },
          persistedPhase,
        },
      })

      expect(summary.imported).toBe(1)
      expect(writes).toHaveLength(1)
      // Nothing to rebuild and nothing to publish: the gate guards a document this
      // path does not have, which is exactly why it must not be asked here.
      expect(published).toBe(0)
    },
  )

  it('still refuses to rebuild a TREE plan once writing began', async () => {
    const upload = await uploadOf([{ name: 'vault/a.md', body: NOTE('A') }])
    const { store, writes } = storeOf()
    const failure = await importOf(upload, store, {
      uploadRef: 'S/job.import',
      planStore: { load: async () => null, publish: async () => null, persistedPhase: 'writing' },
    }).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(ImportPlanConflictError)
    expect(writes).toHaveLength(0)
  })
})

describe('what a foreign import reports (#302)', () => {
  // The wire contract says archive order. Registering every member's meta after
  // the stream instead of as it finished sorted the result by "produced a note
  // first", which put an unrecognised member behind one listed after it.
  it('lists members in archive order, including one that produced no note', async () => {
    const zip = new AdmZip()

    zip.addFile('a-settings.json', Buffer.from('{"theme":"dark"}', 'utf8'))
    zip.addFile(
      'b-conversations.json',
      Buffer.from(
        JSON.stringify([
          {
            uuid: 'c-1',
            name: 'Chat',
            created_at: '2024-01-01T00:00:00Z',
            chat_messages: [{ sender: 'human', text: 'hi', created_at: '2024-01-01T00:00:00Z' }],
          },
        ]),
        'utf8',
      ),
    )
    const path = join(dir, 'export.zip')

    await writeFile(path, zip.toBuffer())
    const { store } = storeOf()
    const summary = await runImport({
      store: store as never,
      uploadPath: path,
      tempDir: dir,
      filename: 'export.zip',
      principal: 'user:a',
    })

    expect(summary.files.map((file) => file.file)).toEqual([
      'a-settings.json',
      'b-conversations.json',
    ])
    expect(summary.files[0].format).toBe('unsupported')
  })
})
