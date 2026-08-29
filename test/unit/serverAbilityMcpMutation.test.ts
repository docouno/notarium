import type { FastifyInstance } from 'fastify'
import type * as Fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CachedStore,
  decodeAbilityLocator,
  type MutationClaim,
  MutationCoordinator,
  type NoteContent,
} from '@notarium/core'
import { NotariumStore, SpaceResourceAuthority } from '@notarium/engine'
import { createServer } from '../../packages/server/src/apps/server/server'

type Rpc = {
  result?: {
    isError?: boolean
    structuredContent?: Record<string, unknown>
    content?: Array<{ text?: string }>
  }
}

type Role = {
  ref: string
  packageId: string
  noteId: string
  versionToken: string
}

// Every barrier this file parks production work on. A row that fails mid-park
// leaves its own server blocked on a promise nobody will settle, and `app.close()`
// then waits for that request forever — which is how ONE red row used to eat the
// afterEach hook and skip both `vi.restoreAllMocks()` and the temp-dir removal,
// poisoning every row after it. Teardown drains this list first, so unparking is
// not something an individual row has to remember on its failure path.
const parkedBarriers: Array<(value?: never) => void> = []

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((open, fail) => {
    resolve = open
    reject = fail
  })

  parkedBarriers.push(resolve as (value?: never) => void)
  return { promise, reject, resolve }
}

// Criterion 1 of the brief is the one wall clock this file is entitled to
// keep: an unobstructed `edit_ability` on the production composition — applied
// or semantic no-op — has to answer inside a second, and that number is the
// thing under proof. So `within` measures exactly that, and its default IS the
// criterion.
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

// Every other wait here is for an EVENT the test itself causes: a barrier one
// of its own seams resolves, or work it deliberately parked and then released.
// The breakages this file hunts do not make those late — a claim that never
// releases, a lock taken in the wrong order, a lease that leaked all leave them
// pending forever, and the assertion standing next to them, not the clock, is
// what names the fault. A budget here is therefore only a liveness backstop,
// sized to outlive a loaded machine; a tight one would turn CPU contention into
// a verdict, which is the false-red IMPL-33 and IMPL-35 were about.
const EVENT_BUDGET_MS = 15_000

// Teardown's own backstop, deliberately below `hookTimeout`. With the barriers
// above already drained a shutdown that still has not settled is a defect, not a
// slow machine, and the hook has to survive it long enough to restore the mocks
// and delete the temp tree — and then FAIL, which is why it is a budget and not
// a log line. Left-behind work is one of the faults this file exists to catch;
// printing it to stderr under a green row is how "the server never shut down"
// became something the suite reported and nobody read.
const CLOSE_BUDGET_MS = 10_000

// The per-row cap has to sit above that backstop, or it becomes the tight
// budget by the back door: a row whose waits are event-driven would be killed
// by the runner at five seconds under load, and the named error explaining
// which barrier never fired would never be printed. Twice the backstop keeps a
// genuinely stuck row bounded while letting the assertion speak first.
vi.setConfig({ hookTimeout: 20_000, testTimeout: 30_000 })

/** Wait for a barrier that one of this test's injected seams resolves. */
const barrier = <T>(promise: Promise<T>): Promise<T> => within(promise, EVENT_BUDGET_MS)

/** Wait for work to end: either work the test parked, or work whose freedom to
 *  run is asserted causally next to the wait rather than by its duration. */
const settles = <T>(promise: Promise<T>): Promise<T> => within(promise, EVENT_BUDGET_MS)

// Same reasoning as `barrier`/`settles`, one step out: a condition poll waits
// for the system to reach a state, and a broken build never reaches it. The
// budget is the backstop, not the claim.
const waitUntil = async (
  predicate: () => Promise<boolean>,
  milliseconds = EVENT_BUDGET_MS,
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

// A frozen module namespace cannot be spied the way a prototype can, so the
// direct-FS channels are observed through pass-through module mocks: every
// export stays the real implementation and only records the pathname it was
// handed.
//
// WHERE the observation sits is the whole design, and two earlier boundaries
// were wrong because each was chosen by naming the channel the previous probe
// happened to use. Watching `open` on `node:fs/promises` covered exactly the
// reader `skillAtPhysical` calls today and nothing else. Watching directory
// ENUMERATION was meant to end that chase — "below a library root the sibling
// names exist nowhere but the directory itself" — and it is simply false
// twice over: `localFs` enumerates through the `promises` namespace that
// `node:fs` re-exports (a mock that copies `actual.promises` by reference sees
// none of it), and a sibling scan can skip enumeration altogether because the
// note index already publishes its neighbours' package ids, which is precisely
// what `store.list({ classes: ['skill'] })` hands any caller.
//
// The one thing NO sibling read can skip is reading the bytes. So the counter
// lives on the file-read port: every byte-read entry point of both node fs
// modules, including the `promises` namespace `node:fs` re-exports and both
// default exports, records what it was asked to read. Enumeration is kept as a
// second, weaker channel — still informative, no longer load-bearing.
const fsPort = vi.hoisted(() => {
  const reads: string[] = []
  const enumerations: string[] = []
  // Only the ability library is recorded. A Node process reads its own module
  // sources and the runner's transforms through these same functions, and that
  // traffic would swamp the channel without telling this gate anything.
  const LIBRARY_MARKER = '/.notarium/skills'

  const record = (sink: string[], target: unknown): void => {
    const path = typeof target === 'string' ? target : String(target)

    if (path.includes(LIBRARY_MARKER)) {
      sink.push(path)
    }
  }

  // Own keys are carried over so a wrapped export keeps the properties Node
  // hangs off these functions (`realpath.native`, the promisify-custom
  // symbols); losing them would break callers that have nothing to do with
  // this gate.
  const relay = (original: unknown, sink: string[]): unknown => {
    if (typeof original !== 'function') {
      return original
    }
    const wrapper = (...args: unknown[]): unknown => {
      record(sink, args[0])

      return (original as (...rest: unknown[]) => unknown)(...args)
    }

    for (const key of Reflect.ownKeys(original)) {
      if (key === 'length' || key === 'name' || key === 'prototype') {
        continue
      }
      Object.defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(original, key)!)
    }

    return wrapper
  }
  const BYTE_READS = ['open', 'openSync', 'readFile', 'readFileSync', 'createReadStream'] as const
  const ENUMERATIONS = ['opendir', 'opendirSync', 'readdir', 'readdirSync'] as const

  const observe = <T extends object>(namespace: T): T => {
    const source = namespace as unknown as Record<string, unknown>
    const patched: Record<string, unknown> = {}

    for (const name of BYTE_READS) {
      if (name in source) {
        patched[name] = relay(source[name], reads)
      }
    }
    for (const name of ENUMERATIONS) {
      if (name in source) {
        patched[name] = relay(source[name], enumerations)
      }
    }

    return { ...namespace, ...patched } as T
  }

  return { enumerations, observe, reads }
})

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof FsPromises>()
  const observed = fsPort.observe(actual)
  const actualDefault = (actual as { default?: Record<string, unknown> }).default ?? actual

  return { ...observed, default: { ...actualDefault, ...observed } }
})

vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof Fs>()
  const observed = fsPort.observe(actual)
  // `localFs.ts` — by its own comment "the only place in the engine that
  // touches node:fs" — reads through THIS namespace: `import { promises as fs }
  // from 'node:fs'`. Leaving it as `actual.promises` by reference is exactly
  // how the two previous boundaries were walked around.
  const promises = fsPort.observe(actual.promises)
  const actualDefault = (actual as { default?: Record<string, unknown> }).default ?? actual

  return {
    ...observed,
    promises,
    default: { ...actualDefault, ...observed, promises },
  }
})

const callExactNoteClaim = <T>(
  method: CachedStore['withExactNoteClaim'],
  store: CachedStore,
  noteId: string,
  task: (current: NoteContent) => Promise<T>,
): Promise<T> => Reflect.apply(method, store, [noteId, task]) as Promise<T>

describe('production MCP ability mutation — real createServer composition', () => {
  let root: string
  let app: FastifyInstance | undefined
  let cookie = ''
  let token = ''
  let personalSlug = ''
  let projectHandle = ''
  let rpcId = 0

  // Both producers below end in `CachedStore.poll()`, which takes a GLOBAL claim
  // on the store's fair MutationCoordinator. Every row here parks a real operation
  // that is holding an exact claim, and the queue is fair: a global claim that
  // arrives while that park is open is admitted after it, and from then on EVERY
  // later claim in the store — including the unrelated-target reads these rows use
  // as their non-vacuity evidence — sits behind that queued global claim until the
  // row's own `release.resolve()`. Nothing in the store is broken; the row simply
  // stops being able to observe anything until it ends itself, and the barrier is
  // what ends it. Which tick lands inside the window is pure wall clock, so this is
  // exactly the class of flake `pollIntervalMs = 0` was already silencing for the
  // periodic timer — these two are the same producer reached by a file change and
  // by a write whose snapshot effect the engine does not model. The one row that
  // is ABOUT a background producer keeps its own, and states so.
  const isolateBackgroundReconcile = (): void => {
    vi.spyOn(NotariumStore.prototype, 'watch').mockReturnValue(null)
    vi.spyOn(
      CachedStore.prototype as unknown as { reconcileSoon(): void },
      'reconcileSoon',
    ).mockImplementation(() => undefined)
  }

  const boot = async (pollIntervalMs = 0): Promise<void> => {
    isolateBackgroundReconcile()
    app = await createServer({
      spaces: [],
      spacesRoot: join(root, 'spaces'),
      metaDbUrl: `sqlite:${join(root, 'meta.db')}`,
      authMode: 'password',
      engineDataDir: join(root, 'engine'),
      jobsDataDir: join(root, 'jobs'),
      importStagingDir: join(root, 'jobs', 'imports'),
      pollIntervalMs,
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
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/me/tokens',
      headers: { cookie },
      payload: { name: 'Codex', scope: 'write' },
    })

    expect(tokenResponse.statusCode, tokenResponse.body).toBe(201)
    token = (tokenResponse.json() as { token: string }).token
    personalSlug = (setup.json() as { personalSpace: string }).personalSpace
    const project = await app.inject({
      method: 'POST',
      url: `/api/s/${personalSlug}/projects`,
      headers: { cookie },
      payload: { folderPath: 'product', create: true },
    })

    expect(project.statusCode, project.body).toBe(201)
    projectHandle = (project.json() as { handle: string }).handle
  }

  const createProject = async (folderPath: string, space = personalSlug): Promise<string> => {
    const response = await app!.inject({
      method: 'POST',
      url: `/api/s/${space}/projects`,
      headers: { cookie },
      payload: { folderPath, create: true },
    })

    expect(response.statusCode, response.body).toBe(201)
    return (response.json() as { handle: string }).handle
  }

  const createSpace = async (slug: string): Promise<void> => {
    const response = await app!.inject({
      method: 'POST',
      url: '/api/spaces',
      headers: { cookie },
      payload: { slug, displayName: slug },
    })

    expect(response.statusCode, response.body).toBe(201)
  }

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

  const createRole = async (
    name: string,
    project = projectHandle,
    instructions = `# ${name}\n\nInitial instructions.`,
  ): Promise<Role> => {
    const created = await call('create_ability', {
      kind: 'role',
      name,
      description: `The ${name} role.`,
      instructions,
      placement: { home: 'project', project },
      idempotencyKey: `create-${name}`,
    })

    expect(created.result?.isError, toolText(created)).not.toBe(true)
    const structured = created.result!.structuredContent as {
      ref: string
      versionToken: string
    }
    const locator = decodeAbilityLocator(structured.ref)

    expect(locator).toMatchObject({ source: 'owned', kind: 'role' })
    const packageId = locator!.packageId
    const db = new DatabaseSync(join(root, 'meta.db'), { readOnly: true })

    try {
      const operation = db
        .prepare(
          `SELECT note_id FROM ability_create_operations
            WHERE package_id = ? AND phase = 'succeeded'`,
        )
        .get(packageId) as { note_id: string } | undefined

      expect(operation).toBeDefined()
      return {
        ref: structured.ref,
        packageId,
        noteId: operation!.note_id,
        versionToken: structured.versionToken,
      }
    } finally {
      db.close()
    }
  }

  const readRole = async (ref: string) => {
    const read = await call('get_ability', { ref })

    expect(read.result?.isError, toolText(read)).not.toBe(true)
    return (read.result!.structuredContent as { ability: Record<string, unknown> }).ability
  }

  const editRole = (role: Role, instructions: string, versionToken = role.versionToken) =>
    call('edit_ability', { ref: role.ref, versionToken, instructions })

  const revisionCount = (noteId: string): number => {
    const db = new DatabaseSync(join(root, 'meta.db'), { readOnly: true })

    try {
      return (
        db
          .prepare(`SELECT COUNT(*) AS count FROM note_revisions WHERE note_id = ?`)
          .get(noteId) as {
          count: number
        }
      ).count
    } finally {
      db.close()
    }
  }

  // "No authority is holding anything" only means something once an authority
  // has actually been reached: `[].flatMap(...)` is `[]`, so the emptiness check
  // alone passes just as happily on a row where the seam that collects them
  // never fired. The size check is the positive control that makes the line a
  // statement about the system rather than about the set.
  const expectAuthoritiesIdle = (authorities: ReadonlySet<SpaceResourceAuthority>): void => {
    expect(authorities.size).toBeGreaterThan(0)
    expect([...authorities].flatMap((authority) => authority.diagnostics())).toEqual([])
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'notarium-mcp-ability-mutation-'))
    await mkdir(join(root, 'spaces'))
  })

  afterEach(async () => {
    // Four steps, in this order and each isolated from the others' failure.
    // Unpark first: a row that died at a barrier still has server work suspended
    // inside one of this file's mocks, and `close()` waits for it. Restore and
    // remove regardless of what `close()` did — a leaked prototype spy is what
    // turns one red row into a red file, and it must not depend on a shutdown
    // that may itself be the thing that hung.
    //
    // Then RAISE what `close()` did. Once every barrier above is released, a
    // shutdown that still will not settle is left-behind work — a coordinator
    // claim never released, a resource lease never settled — which is one of the
    // faults this file exists to catch, on the one path where nothing else can
    // observe it. Reporting it to stderr under a green row is how it stayed
    // unread. The teardown is deliberately the last thing to speak: it runs
    // after the row's own assertions, so a row that failed on its own terms
    // still reports its own message first.
    for (const release of parkedBarriers.splice(0)) {
      release()
    }
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

  it('finishes applied and semantic no-op edits, and fences stale compound steps', async () => {
    await boot()
    const role = await createRole('bounded-edit')
    const before = revisionCount(role.noteId)
    const body = '# Bounded edit\n\nUpdated instructions.'
    const applied = await within(editRole(role, body))

    expect(applied.result?.isError, toolText(applied)).not.toBe(true)
    expect(applied.result?.structuredContent).toMatchObject({
      steps: [{ step: 'document', outcome: 'applied' }],
      versionToken: expect.any(String),
    })
    const appliedToken = (applied.result!.structuredContent as { versionToken: string })
      .versionToken

    expect(appliedToken).not.toBe(role.versionToken)
    expect(await readRole(role.ref)).toMatchObject({
      instructions: body,
      versionToken: appliedToken,
    })
    expect(revisionCount(role.noteId)).toBe(before + 1)

    const noOp = await within(editRole(role, body, appliedToken))

    expect(noOp.result?.isError, toolText(noOp)).not.toBe(true)
    expect(noOp.result?.structuredContent).toMatchObject({
      steps: [{ step: 'document', outcome: 'skipped' }],
      versionToken: appliedToken,
    })
    expect(revisionCount(role.noteId)).toBe(before + 1)

    const preferencesBefore = new DatabaseSync(join(root, 'meta.db'), { readOnly: true })
    let preferenceRows: number

    try {
      preferenceRows = (
        preferencesBefore.prepare(`SELECT COUNT(*) AS count FROM ability_preferences`).get() as {
          count: number
        }
      ).count
    } finally {
      preferencesBefore.close()
    }
    const stale = await within(
      call('edit_ability', {
        ref: role.ref,
        versionToken: role.versionToken,
        instructions: '# Stale\n\nMust not land.',
        enabled: false,
      }),
    )

    expect(stale.result?.isError, toolText(stale)).not.toBe(true)
    expect(stale.result?.structuredContent).toMatchObject({
      steps: [{ step: 'document', outcome: 'failed', error: expect.any(String) }],
    })
    const after = new DatabaseSync(join(root, 'meta.db'), { readOnly: true })

    try {
      expect(after.prepare(`SELECT COUNT(*) AS count FROM ability_preferences`).get()).toEqual({
        count: preferenceRows,
      })
    } finally {
      after.close()
    }
    expect(await readRole(role.ref)).toMatchObject({
      instructions: body,
      versionToken: appliedToken,
    })
  })

  it('keeps exact edit target observations constant across 1 and 256 packages', async () => {
    await boot()
    const role = await createRole('shape-target')
    const exactOriginal = CachedStore.prototype.withExactNoteClaim
    const stores = new Set<CachedStore>()
    const captureStore = vi
      .spyOn(CachedStore.prototype, 'withExactNoteClaim')
      .mockImplementation(async function <T>(
        this: CachedStore,
        noteId: string,
        task: (current: NoteContent) => Promise<T>,
      ): Promise<T> {
        if (noteId === role.noteId) {
          stores.add(this)
        }

        return callExactNoteClaim(exactOriginal, this, noteId, task)
      })

    await readRole(role.ref)
    captureStore.mockRestore()
    const store = [...stores][0]

    expect(store).toBeDefined()
    const projects = await app!.inject({
      method: 'GET',
      url: `/api/s/${personalSlug}/projects`,
      headers: { cookie },
    })

    expect(projects.statusCode, projects.body).toBe(200)
    const projectId = (
      projects.json() as { projects: Array<{ handle: string; id: string }> }
    ).projects.find(({ handle }) => handle === projectHandle)?.id

    expect(projectId).toBeTruthy()
    // The library root that holds the target AND every sibling planted below.
    const placement = join(
      root,
      'spaces',
      personalSlug,
      '.notarium',
      'skills',
      '_projects',
      Buffer.from(projectId!, 'utf8').toString('base64url'),
    )
    const skillsRoot = join(root, 'spaces', personalSlug, '.notarium', 'skills')

    const observeShape = async (
      versionToken: string,
      instructions: string,
      expectedPackages: number,
    ) => {
      await store!.checkpoint()
      await store!.graphHealth()
      const list = vi.spyOn(store!, 'list')
      const checkpoint = vi.spyOn(store!, 'checkpoint')
      const reconcile = vi.spyOn(store!, 'reconcile')
      const reconcileSoon = vi.spyOn(
        store! as unknown as { reconcileSoon(): void },
        'reconcileSoon',
      )
      const graphInvalidation = vi.spyOn(
        (
          store! as unknown as {
            graphCache: { onSnapshotChanged(): void }
          }
        ).graphCache,
        'onSnapshotChanged',
      )
      const graph = vi.spyOn(store!, 'graph')
      const graphHealth = vi.spyOn(store!, 'graphHealth')
      const innerRead = vi.spyOn(NotariumStore.prototype, 'read')
      const innerGraph = vi.spyOn(NotariumStore.prototype, 'graph')
      const manifestObservation = vi.spyOn(
        SpaceResourceAuthority.prototype,
        'observeStrictAdmitted',
      )
      // The exact package path asks for the directory-bound flavour, and it does not
      // route through the plain one — count it or the manifest channel reads as empty.
      const boundObservation = vi.spyOn(
        SpaceResourceAuthority.prototype,
        'observeDirectoryBoundAdmitted',
      )
      const ordinaryObservation = vi.spyOn(SpaceResourceAuthority.prototype, 'observe')
      // The strict path also reads the filesystem directly, through neither
      // authority channel — a gate blind to that cannot see a class-wide scan
      // there — so the file-read port is reset here and asserted below next to
      // the two authority channels.
      fsPort.reads.length = 0
      fsPort.enumerations.length = 0

      try {
        const edited = await within(editRole(role, instructions, versionToken), 3_000)

        expect(edited.result?.isError, toolText(edited)).not.toBe(true)
        expect(edited.result?.structuredContent).toMatchObject({
          steps: [{ step: 'document', outcome: 'applied' }],
          versionToken: expect.any(String),
        })
        expect(checkpoint).not.toHaveBeenCalled()
        expect(reconcile).not.toHaveBeenCalled()
        expect(reconcileSoon).not.toHaveBeenCalled()
        expect(graph).not.toHaveBeenCalled()
        expect(graphHealth).not.toHaveBeenCalled()
        expect(graphInvalidation).not.toHaveBeenCalled()

        const skillListResults = await Promise.all(
          list.mock.calls.flatMap((invocation, index) => {
            const options = invocation[0] as { classes?: string[] } | undefined

            return options?.classes?.includes('skill')
              ? [list.mock.results[index]!.value as Promise<Array<{ id: string }>>]
              : []
          }),
        )

        expect(skillListResults).toHaveLength(1)
        expect(skillListResults[0]).toHaveLength(expectedPackages)
        const readTargets = innerRead.mock.calls.map(([target]) => String(target))

        expect(readTargets.length).toBeGreaterThan(0)
        expect(
          readTargets.every((target) => target === role.noteId || target.includes(role.packageId)),
        ).toBe(true)
        const manifestTargets = [
          ...manifestObservation.mock.calls.map(([path]) => String(path)),
          ...boundObservation.mock.calls.map(([path]) => String(path)),
          ...ordinaryObservation.mock.calls.map(([path]) => String(path)),
        ].filter((path) => path.endsWith('/SKILL.md'))

        expect(manifestTargets.length).toBeGreaterThan(0)
        expect(manifestTargets.every((path) => path.includes(role.packageId))).toBe(true)
        // The file-read port. Every byte read out of the ability library during
        // the edit lands here, whichever fs API asked for it and however the
        // caller learned the pathname.
        const libraryReads = fsPort.reads.filter((path) => path.startsWith(`${skillsRoot}/`))
        // The target's own manifest, and this channel's positive control: an
        // exact edit DOES read the package it is editing off disk, so a zero
        // here means the observation went dead, not that the read stopped.
        const targetManifestBytes = libraryReads.filter(
          (path) => path.includes(role.packageId) && path.endsWith('/SKILL.md'),
        )
        // Bytes read out of a NEIGHBOUR's package directory, by any API and
        // however its name was learned — enumerating the placement root, or
        // reading the ids straight off the note index without enumerating
        // anything. This is a measured tail, not a violation: the admitted
        // write validates the manifest name against every sibling in the
        // placement (`assertSkillManifestNameAvailableAdmitted` → `files.scan()`
        // + `files.read()` per sibling), which is O(packages) by design. The row
        // therefore pins the number instead of tolerating it silently: a second
        // channel that also walks the neighbours pushes it off the pinned value
        // and reddens the row.
        const siblingReads = libraryReads.filter(
          (path) => path.startsWith(`${placement}/`) && !path.includes(role.packageId),
        )

        expect(targetManifestBytes.length).toBeGreaterThan(0)
        // The enumeration channel, kept as a second and weaker observation. It
        // is no longer load-bearing: a sibling scan does not have to enumerate
        // anything, because `store.list({ classes: ['skill'] })` already hands
        // out the neighbours' package ids. The positive control still holds —
        // an exact edit does enumerate a library root, since `findRoleBase`
        // resolves the locator through `manifestIndex` over the SPACE root, the
        // discovery axis design 03 deliberately leaves outside the O(1) claim.
        const libraryEnumerations = fsPort.enumerations.filter((path) =>
          path.startsWith(skillsRoot),
        )

        expect(libraryEnumerations.length).toBeGreaterThan(0)

        await store!.graphHealth()
        expect(innerGraph).not.toHaveBeenCalled()

        return {
          versionToken: (edited.result!.structuredContent as { versionToken: string }).versionToken,
          targetBodyObservations: readTargets.length,
          targetManifestObservations: manifestTargets.length,
          targetManifestByteReads: targetManifestBytes.length,
          siblingPackageByteReads: siblingReads.length,
          libraryEnumerations: libraryEnumerations.length,
        }
      } finally {
        ordinaryObservation.mockRestore()
        boundObservation.mockRestore()
        manifestObservation.mockRestore()
        innerGraph.mockRestore()
        innerRead.mockRestore()
        graphInvalidation.mockRestore()
        reconcileSoon.mockRestore()
        graphHealth.mockRestore()
        graph.mockRestore()
        reconcile.mockRestore()
        checkpoint.mockRestore()
        list.mockRestore()
      }
    }

    const sparse = await observeShape(
      role.versionToken,
      '# Shape target\n\nOne-package observation.',
      1,
    )
    await Promise.all(
      Array.from({ length: 255 }, async (_, offset) => {
        const serial = String(offset + 1).padStart(4, '0')
        const packageId = `ScalePkg${serial}`
        const packageRoot = join(placement, packageId)

        await mkdir(packageRoot, { recursive: true })
        await writeFile(
          join(packageRoot, 'SKILL.md'),
          [
            '---',
            `notarium-id: ${packageId}`,
            `name: scale-role-${serial}`,
            'description: Scale-only role package.',
            'metadata:',
            '  notarium.kind: role',
            '---',
            '',
            `# Scale role ${serial}`,
            '',
            'A neighbour of the edit target, counted by the file-read port below.',
          ].join('\n'),
        )
      }),
    )
    await store!.reconcile()
    await store!.checkpoint()
    const dense = await observeShape(
      sparse.versionToken,
      '# Shape target\n\nTwo-hundred-and-fifty-six-package observation.',
      256,
    )

    // The O(1) claim: what the edit observes ABOUT ITS TARGET does not move
    // when the placement goes from one package to 256.
    expect(dense.targetBodyObservations).toBe(sparse.targetBodyObservations)
    expect(dense.targetManifestObservations).toBe(sparse.targetManifestObservations)
    expect(dense.targetManifestByteReads).toBe(sparse.targetManifestByteReads)

    // The measured tails, pinned to their numbers rather than left silent.
    // An applied write still re-derives the manifest-name index from file truth
    // (`assertSkillManifestNameAvailableAdmitted`), so it walks the placement
    // once and reads each neighbour's manifest exactly once: 255 sibling reads
    // and one extra enumeration per package. That is the accepted shape of this
    // axis, the same way the class-wide `skill` list above is. Pinning it is
    // what makes a SECOND walk — through the note index, through
    // `manifestIndex`, through a raw fs call — arithmetic instead of invisible.
    // A change that removes the walk lands here too, and is meant to: the
    // number is the contract, and moving it is a decision, not a detail.
    expect(sparse.siblingPackageByteReads).toBe(0)
    expect(dense.siblingPackageByteReads).toBe(255)
    expect(sparse.libraryEnumerations).toBe(8)
    expect(dense.libraryEnumerations).toBe(sparse.libraryEnumerations + 255)
  }, 30_000)

  it('holds same-target reads behind the admitted edit while unrelated targets progress', async () => {
    await boot()
    const role = await createRole('serialized-target')
    const sibling = await createRole('parallel-package')
    const unrelated = await app!.inject({
      method: 'POST',
      url: `/api/s/${personalSlug}/notes`,
      headers: { cookie },
      payload: { directory: 'product', content: '# Unrelated\n\nIndependent body.' },
    })

    expect(unrelated.statusCode, unrelated.body).toBe(200)
    const unrelatedId = (unrelated.json() as { id: string }).id
    const entered = deferred()
    const release = deferred()
    const readRequested = deferred()
    const original = CachedStore.prototype.withExactNoteClaim
    let targetCalls = 0
    // True exactly while the admitted edit sits inside its exact claim. The read
    // records it at its own admission, so "the read waited" is decided by the
    // holder's state at that instant, not by which promise settled first.
    let editHolds = false
    let readAdmittedWhileHeld: boolean | undefined

    vi.spyOn(CachedStore.prototype, 'withExactNoteClaim').mockImplementation(async function <T>(
      this: CachedStore,
      noteId: string,
      task: (current: NoteContent) => Promise<T>,
    ): Promise<T> {
      if (noteId === role.noteId) {
        const targetCall = ++targetCalls

        if (targetCall === 2) {
          return callExactNoteClaim(original, this, noteId, async (current) => {
            editHolds = true
            entered.resolve()
            try {
              await release.promise
              return await task(current)
            } finally {
              editHolds = false
            }
          })
        }
        if (targetCall === 3) {
          readRequested.resolve()
          return callExactNoteClaim(original, this, noteId, async (current) => {
            readAdmittedWhileHeld ??= editHolds
            return task(current)
          })
        }
      }

      return callExactNoteClaim(original, this, noteId, task)
    })

    const body = '# Serialized target\n\nThe admitted edit wins.'
    const editing = editRole(role, body)

    await barrier(entered.promise)
    let sameTargetSettled = false
    const sameTarget = readRole(role.ref)
    void sameTarget.then(
      () => {
        sameTargetSettled = true
      },
      () => {
        sameTargetSettled = true
      },
    )
    await barrier(readRequested.promise)
    // Unrelated work of the same shape, started AFTER the pending read and run
    // to completion on the same server. It does double duty, and neither part
    // is a stopwatch. It proves independent targets progress: `editHolds` is
    // cleared only by this test's own `release.resolve()` further down, so work
    // that finishes here provably finished DURING the held claim, and work that
    // were wrongly serialized behind it could not finish here at all. And it
    // paces the same-target read: an unserialized read, admitted first and with
    // no contention, would reach its own task before identical later work ends.
    const [otherPackage, otherNote] = await settles(
      Promise.all([
        readRole(sibling.ref),
        app!.inject({
          method: 'GET',
          url: `/api/note?id=${encodeURIComponent(unrelatedId)}`,
          headers: { cookie },
        }),
      ]),
    )

    expect(editHolds).toBe(true)
    await settles(readRole(sibling.ref))
    expect(editHolds).toBe(true)
    expect(otherPackage).toMatchObject({ name: 'parallel-package' })
    expect(otherNote.statusCode, otherNote.body).toBe(200)
    expect(readAdmittedWhileHeld).toBeUndefined()
    expect(sameTargetSettled).toBe(false)

    release.resolve()
    const [edited, read] = await settles(Promise.all([editing, sameTarget]))

    expect(edited.result?.isError, toolText(edited)).not.toBe(true)
    expect(read).toMatchObject({ instructions: body })
    expect(readAdmittedWhileHeld).toBe(false)
  })

  it('holds same-target reads behind an admitted semantic no-op', async () => {
    await boot()
    const role = await createRole('serialized-no-op')
    const pacer = await createRole('no-op-pacer')
    const instructions = '# Serialized no-op\n\nStable instructions.'
    const createdRevisions = revisionCount(role.noteId)
    const applied = await within(editRole(role, instructions))

    expect(applied.result?.isError, toolText(applied)).not.toBe(true)
    role.versionToken = (applied.result!.structuredContent as { versionToken: string }).versionToken
    await waitUntil(async () => revisionCount(role.noteId) === createdRevisions + 1)
    const before = revisionCount(role.noteId)
    const entered = deferred()
    const release = deferred()
    const readRequested = deferred()
    const original = CachedStore.prototype.withExactNoteClaim
    let targetCalls = 0
    // A semantic no-op leaves body, token and revision count untouched, so no
    // content assertion can tell a serialized read from an unserialized one.
    // What still differs is WHEN the read is admitted: only the holder's state
    // at that instant separates "waited for the release" from "never waited".
    let noOpHolds = false
    let readAdmittedWhileHeld: boolean | undefined

    vi.spyOn(CachedStore.prototype, 'withExactNoteClaim').mockImplementation(async function <T>(
      this: CachedStore,
      noteId: string,
      task: (current: NoteContent) => Promise<T>,
    ): Promise<T> {
      if (noteId === role.noteId) {
        const targetCall = ++targetCalls

        if (targetCall === 2) {
          return callExactNoteClaim(original, this, noteId, async (current) => {
            noOpHolds = true
            entered.resolve()
            try {
              await release.promise
              return await task(current)
            } finally {
              noOpHolds = false
            }
          })
        }
        if (targetCall === 3) {
          readRequested.resolve()
          return callExactNoteClaim(original, this, noteId, async (current) => {
            readAdmittedWhileHeld ??= noOpHolds
            return task(current)
          })
        }
      }

      return callExactNoteClaim(original, this, noteId, task)
    })

    const noOp = editRole(role, instructions)

    await barrier(entered.promise)
    let readSettled = false
    const reading = readRole(role.ref)
    void reading.finally(() => {
      readSettled = true
    })
    await barrier(readRequested.promise)
    // Pacer, not a sleep. Two complete `get_ability` reads of an unrelated
    // package are issued AFTER the pending one and awaited here: they are the
    // very same operation on the very same server, so an unserialized read —
    // admitted first, with no contention — would have reached its claimed task
    // well before they return. This is the deliberate compromise: proving that
    // something did NOT happen needs some barrier, and a same-operation pacer
    // scales with the machine, where a fixed hold would not. That the pacer
    // really did run inside the window is not assumed either: `noOpHolds` is
    // cleared only by this test's own `release.resolve()` below.
    await settles(readRole(pacer.ref))
    await settles(readRole(pacer.ref))
    expect(noOpHolds).toBe(true)
    expect(readAdmittedWhileHeld).toBeUndefined()
    expect(readSettled).toBe(false)

    release.resolve()
    const [result, read] = await settles(Promise.all([noOp, reading]))

    expect(result.result?.isError, toolText(result)).not.toBe(true)
    expect(result.result?.structuredContent).toMatchObject({
      steps: [{ step: 'document', outcome: 'skipped' }],
      versionToken: role.versionToken,
    })
    expect(read).toMatchObject({ instructions, versionToken: role.versionToken })
    expect(revisionCount(role.noteId)).toBe(before)
    expect(readAdmittedWhileHeld).toBe(false)
  })

  it('serializes one placement but admits mutations in a different placement', async () => {
    await boot()
    const sameA = await createRole('same-placement-a')
    const sameB = await createRole('same-placement-b')
    const otherProject = await createProject('support')
    const independent = await createRole('other-placement', otherProject)
    const original = SpaceResourceAuthority.prototype.admitSkillPlacement
    const firstAdmitted = deferred()
    const releaseFirst = deferred()
    const sameRequested = deferred()
    const sameAdmitted = deferred()
    const independentAdmitted = deferred()
    const createAdmitted = deferred()
    let sameWasAdmitted = false
    let createWasAdmitted = false
    // True exactly while the first placement lease is parked, so the row can say
    // WHEN the other placement got through instead of how fast it was.
    let firstPlacementHolds = false

    vi.spyOn(SpaceResourceAuthority.prototype, 'admitSkillPlacement').mockImplementation(
      async function (this: SpaceResourceAuthority, path, mode, owner, options) {
        if (owner === 'ability-create-placement') {
          const lease = await original.call(this, path, mode, owner, options)

          createWasAdmitted = true
          createAdmitted.resolve()
          return lease
        }
        if (owner !== 'role-exact-mutation-placement') {
          return original.call(this, path, mode, owner, options)
        }
        if (path.includes(sameB.packageId)) {
          sameRequested.resolve()
        }
        const lease = await original.call(this, path, mode, owner, options)

        if (path.includes(sameA.packageId)) {
          firstPlacementHolds = true
          firstAdmitted.resolve()
          try {
            await releaseFirst.promise
          } finally {
            firstPlacementHolds = false
          }
        } else if (path.includes(sameB.packageId)) {
          sameWasAdmitted = true
          sameAdmitted.resolve()
        } else if (path.includes(independent.packageId)) {
          independentAdmitted.resolve()
        }

        return lease
      },
    )

    const first = call('edit_ability', { ref: sameA.ref, enabled: false })

    await barrier(firstAdmitted.promise)
    const second = editRole(sameB, '# Same placement B\n\nSecond.')

    await barrier(sameRequested.promise)
    const other = editRole(independent, '# Other placement\n\nIndependent.')

    await barrier(independentAdmitted.promise)
    // Criterion 1 applies here — this is an unobstructed `edit_ability` — so the
    // one-second budget stays. What it must NOT be is the whole proof that the
    // other placement is admitted independently: that is `firstPlacementHolds`,
    // which only this test's `releaseFirst` can clear.
    const otherResult = await within(other)

    expect(firstPlacementHolds).toBe(true)
    expect(otherResult.result?.isError, toolText(otherResult)).not.toBe(true)
    expect(sameWasAdmitted).toBe(false)
    const createCoreRequested = deferred()
    const acquireOriginal = MutationCoordinator.prototype.acquire
    let watchCreate = true

    vi.spyOn(MutationCoordinator.prototype, 'acquire').mockImplementation(async function (
      this: MutationCoordinator,
      claim: MutationClaim,
    ): Promise<() => void> {
      if (watchCreate && claim.global) {
        watchCreate = false
        createCoreRequested.resolve()
      }

      return Reflect.apply(acquireOriginal, this, [claim]) as Promise<() => void>
    })
    const creating = createRole('created-during-metadata')

    // The order is asserted on the barrier itself, not on a wall clock: create
    // must reach its Core global claim while the placement lease is still held.
    // Under the wrong lock order the promise never settles and the budget turns
    // this red; a slow machine only makes it settle later.
    await barrier(createCoreRequested.promise)

    const health = await app!.inject({ method: 'GET', url: '/api/health' })

    expect(health.statusCode).toBe(200)
    expect(createWasAdmitted).toBe(false)
    releaseFirst.resolve()

    await barrier(Promise.all([sameAdmitted.promise, createAdmitted.promise]))
    // Parked by this test for as long as it held `releaseFirst`, so their
    // latency is not criterion 1's subject; only their completion is.
    const [firstResult, secondResult, created] = await settles(
      Promise.all([first, second, creating]),
    )

    expect(firstResult.result?.isError, toolText(firstResult)).not.toBe(true)
    expect(secondResult.result?.isError, toolText(secondResult)).not.toBe(true)
    expect(created.ref).toEqual(expect.any(String))
    // The row waits on barriers rather than on elapsed time, so it needs the
    // headroom those budgets imply: a machine slow enough to need it must not
    // be reported as a broken lock order. It runs in ~1.5 s when nothing hangs.
  }, 30_000)

  it('releases Core and package leases across exact, package, physical, and DB failures', async () => {
    await boot()
    const role = await createRole('failure-cuts')
    const neighbour = await app!.inject({
      method: 'POST',
      url: `/api/s/${personalSlug}/notes`,
      headers: { cookie },
      payload: { content: '# Failure neighbour\n\nUnrelated to every cut.' },
    })

    expect(neighbour.statusCode, neighbour.body).toBe(200)
    const neighbourId = (neighbour.json() as { id: string }).id
    const exactOriginal = CachedStore.prototype.withExactNoteClaim
    const stores = new Set<CachedStore>()
    const captureStore = vi
      .spyOn(CachedStore.prototype, 'withExactNoteClaim')
      .mockImplementation(async function <T>(
        this: CachedStore,
        noteId: string,
        task: (current: NoteContent) => Promise<T>,
      ): Promise<T> {
        if (noteId === role.noteId) {
          stores.add(this)
        }

        return callExactNoteClaim(exactOriginal, this, noteId, task)
      })

    await readRole(role.ref)
    captureStore.mockRestore()
    const store = [...stores][0]

    expect(store).toBeDefined()
    const authorities = new Set<SpaceResourceAuthority>()

    // A same-target retry is not enough after a cut: a Core lease that leaked
    // holds the whole space, and the next edit of the same target would queue
    // behind it just as an unrelated reader would. So every cut is followed by
    // work that shares nothing with the target — one unrelated read and one
    // reconcile — before the target is asked to move again.
    const unrelatedProgresses = async (): Promise<void> => {
      const read = await settles(
        app!.inject({
          method: 'GET',
          url: `/api/note?id=${encodeURIComponent(neighbourId)}`,
          headers: { cookie },
        }),
      )

      expect(read.statusCode, read.body).toBe(200)
      await settles(store!.reconcile())
    }
    const innerReadOriginal = NotariumStore.prototype.read
    let failExactObservation = false

    vi.spyOn(NotariumStore.prototype, 'read').mockImplementation(async function (
      this: NotariumStore,
      target,
      options,
    ) {
      if (
        failExactObservation &&
        (String(target) === role.noteId || String(target).includes(role.packageId))
      ) {
        failExactObservation = false
        throw new Error('injected exact current observation failure')
      }

      return Reflect.apply(innerReadOriginal, this, [target, options])
    })

    const placementOriginal = SpaceResourceAuthority.prototype.admitSkillPlacement
    let failPlacementAdmission = false

    vi.spyOn(SpaceResourceAuthority.prototype, 'admitSkillPlacement').mockImplementation(
      async function (this: SpaceResourceAuthority, path, mode, owner, options) {
        authorities.add(this)
        if (
          failPlacementAdmission &&
          path.includes(role.packageId) &&
          owner === 'role-exact-mutation-placement'
        ) {
          failPlacementAdmission = false
          throw new Error('injected failure before placement admission')
        }

        return placementOriginal.call(this, path, mode, owner, options)
      },
    )

    const packageOriginal = SpaceResourceAuthority.prototype.admitPackage
    let failPackage = false

    vi.spyOn(SpaceResourceAuthority.prototype, 'admitPackage').mockImplementation(async function (
      this: SpaceResourceAuthority,
      path,
      mode,
      owner,
      options,
    ) {
      authorities.add(this)
      if (failPackage && path.includes(role.packageId) && owner === 'role-exact-mutation-package') {
        failPackage = false
        throw new Error('injected failure between placement and package admission')
      }

      return packageOriginal.call(this, path, mode, owner, options)
    })

    // The exact package path observes its manifest directory-bound, so the cut has to
    // sit on that entry: the plain strict one is never reached from here.
    const observeOriginal = SpaceResourceAuthority.prototype.observeDirectoryBoundAdmitted
    let failObservation = false

    vi.spyOn(SpaceResourceAuthority.prototype, 'observeDirectoryBoundAdmitted').mockImplementation(
      async function (this: SpaceResourceAuthority, path, maxBytes) {
        authorities.add(this)
        if (failObservation && path.includes(role.packageId)) {
          failObservation = false
          throw new Error('injected admitted manifest observation failure')
        }

        return observeOriginal.call(this, path, maxBytes)
      },
    )

    const publishOriginal = SpaceResourceAuthority.prototype.publishAdmitted
    let failPublish = false

    vi.spyOn(SpaceResourceAuthority.prototype, 'publishAdmitted').mockImplementation(
      async function (this: SpaceResourceAuthority, request) {
        authorities.add(this)
        if (failPublish && request.kind === 'put' && request.path.includes(role.packageId)) {
          failPublish = false
          throw new Error('injected physical CAS failure')
        }

        return publishOriginal.call(this, request)
      },
    )

    // 1 — exact current observation.
    failExactObservation = true
    const exactFailure = await within(editRole(role, '# Failure cuts\n\nExact failure.'))

    expect(exactFailure.result?.isError, toolText(exactFailure)).toBe(true)
    // This cut lands BEFORE any resource authority is reached, so there is no
    // lease here to leak and "every authority is idle" would be a sentence about
    // an empty set. What the row can state instead is where the cut fell: no
    // authority seam ran at all. An injection that drifted past one of them
    // would land here, and the idle check below — after the retry, with the
    // seams live — is where leases start being observable.
    expect(authorities.size).toBe(0)
    await unrelatedProgresses()
    const afterExact = await within(editRole(role, '# Failure cuts\n\nAfter exact failure.'))

    expect(afterExact.result?.isError, toolText(afterExact)).not.toBe(true)
    expectAuthoritiesIdle(authorities)
    let current = await readRole(role.ref)

    // 2 — before placement admission, under the held Core exact claim.
    failPlacementAdmission = true
    const placementFailure = await within(
      editRole(role, '# Failure cuts\n\nPlacement failure.', current.versionToken as string),
    )

    expect(placementFailure.result?.isError, toolText(placementFailure)).not.toBe(true)
    expect(placementFailure.result?.structuredContent).toMatchObject({
      steps: [{ step: 'document', outcome: 'failed', error: expect.any(String) }],
    })
    expectAuthoritiesIdle(authorities)
    await unrelatedProgresses()
    const afterPlacement = await within(
      editRole(role, '# Failure cuts\n\nAfter placement failure.', current.versionToken as string),
    )

    expect(afterPlacement.result?.isError, toolText(afterPlacement)).not.toBe(true)
    expectAuthoritiesIdle(authorities)
    current = await readRole(role.ref)

    // 3 — after placement, before package admission.
    failPackage = true
    const packageFailure = await within(
      editRole(role, '# Failure cuts\n\nPackage failure.', current.versionToken as string),
    )

    expect(packageFailure.result?.isError, toolText(packageFailure)).not.toBe(true)
    expect(packageFailure.result?.structuredContent).toMatchObject({
      steps: [{ step: 'document', outcome: 'failed', error: expect.any(String) }],
    })
    expectAuthoritiesIdle(authorities)
    await unrelatedProgresses()
    const afterPackage = await within(
      editRole(role, '# Failure cuts\n\nAfter package failure.', current.versionToken as string),
    )

    expect(afterPackage.result?.isError, toolText(afterPackage)).not.toBe(true)
    expectAuthoritiesIdle(authorities)
    current = await readRole(role.ref)

    // 4 — after physical manifest observation.
    failObservation = true
    const observationFailure = await within(
      editRole(role, '# Failure cuts\n\nObservation failure.', current.versionToken as string),
    )

    expect(
      observationFailure.result?.isError === true ||
        (
          observationFailure.result?.structuredContent as
            { steps?: Array<{ outcome: string }> } | undefined
        )?.steps?.some(({ outcome }) => outcome === 'failed'),
    ).toBe(true)
    expectAuthoritiesIdle(authorities)
    await unrelatedProgresses()
    const afterObservation = await within(
      editRole(
        role,
        '# Failure cuts\n\nAfter observation failure.',
        current.versionToken as string,
      ),
    )

    expect(afterObservation.result?.isError, toolText(afterObservation)).not.toBe(true)
    expectAuthoritiesIdle(authorities)
    current = await readRole(role.ref)

    // 6 — physical write CAS.
    failPublish = true
    const physicalFailure = await within(
      editRole(role, '# Failure cuts\n\nPhysical failure.', current.versionToken as string),
    )

    expect(physicalFailure.result?.isError, toolText(physicalFailure)).not.toBe(true)
    expect(physicalFailure.result?.structuredContent).toMatchObject({
      steps: [{ step: 'document', outcome: 'failed', error: expect.any(String) }],
    })
    expectAuthoritiesIdle(authorities)
    await unrelatedProgresses()
    const afterPhysical = await within(
      editRole(role, '# Failure cuts\n\nAfter physical failure.', current.versionToken as string),
    )

    expect(afterPhysical.result?.isError, toolText(afterPhysical)).not.toBe(true)
    expectAuthoritiesIdle(authorities)

    // 5 — DB metadata update.
    const database = new DatabaseSync(join(root, 'meta.db'))

    try {
      database.exec(`
        CREATE TRIGGER fail_ability_preference_insert
        BEFORE INSERT ON ability_preferences
        BEGIN
          SELECT RAISE(ABORT, 'injected ability preference failure');
        END;
      `)
    } finally {
      database.close()
    }
    const dbFailure = await within(call('edit_ability', { ref: role.ref, enabled: false }))

    expect(
      dbFailure.result?.isError === true ||
        (
          dbFailure.result?.structuredContent as { steps?: Array<{ outcome: string }> } | undefined
        )?.steps?.some(({ outcome }) => outcome === 'failed'),
    ).toBe(true)
    expectAuthoritiesIdle(authorities)
    await unrelatedProgresses()
    const repair = new DatabaseSync(join(root, 'meta.db'))

    try {
      repair.exec(`DROP TRIGGER fail_ability_preference_insert`)
    } finally {
      repair.close()
    }
    const afterDb = await within(call('edit_ability', { ref: role.ref, enabled: false }))

    expect(afterDb.result?.isError, toolText(afterDb)).not.toBe(true)
    expectAuthoritiesIdle(authorities)
    await unrelatedProgresses()
    await settles(readRole(role.ref))
  }, 30_000)

  it('preserves one fresh identity when edit and move win in either order', async () => {
    await boot()
    await createSpace('shared')
    const sharedProject = await createProject('launch', 'shared')
    const editFirstRole = await createRole('edit-before-move', sharedProject)
    const movePacer = await createRole('edit-before-move-pacer', sharedProject)
    const exactOriginal = CachedStore.prototype.withExactNoteClaim
    const editEntered = deferred()
    const releaseEdit = deferred()
    const moveRequested = deferred()
    let editTargetCalls = 0
    // True exactly while the edit sits inside its exact claim. The move records
    // it at its OWN admission, so "the move waited" is decided by the holder's
    // state at that instant rather than by the test releasing the edit first.
    let editHolds = false
    let moveAdmittedWhileHeld: boolean | undefined

    vi.spyOn(CachedStore.prototype, 'withExactNoteClaim').mockImplementation(async function <T>(
      this: CachedStore,
      noteId: string,
      task: (current: NoteContent) => Promise<T>,
    ): Promise<T> {
      if (noteId === editFirstRole.noteId) {
        const targetCall = ++editTargetCalls

        if (targetCall === 2) {
          return callExactNoteClaim(exactOriginal, this, noteId, async (current) => {
            editHolds = true
            editEntered.resolve()
            try {
              await releaseEdit.promise
              return await task(current)
            } finally {
              editHolds = false
            }
          })
        }
        if (targetCall === 3) {
          moveRequested.resolve()
          return callExactNoteClaim(exactOriginal, this, noteId, async (current) => {
            moveAdmittedWhileHeld ??= editHolds
            return task(current)
          })
        }
      }

      return callExactNoteClaim(exactOriginal, this, noteId, task)
    })
    const editedBody = '# Edit before move\n\nFresh edited manifest.'
    const editing = editRole(editFirstRole, editedBody)

    await barrier(editEntered.promise)
    const moving = call('edit_ability', {
      ref: editFirstRole.ref,
      home: { home: 'space' },
    })

    await barrier(moveRequested.promise)
    // Pacer, not a sleep: two complete reads of an unrelated package in the same
    // placement, issued AFTER the move asked for the target's exact claim. They
    // take their own non-conflicting claims, so they only wait on the machine —
    // and a move admitted without the edit's claim would have reached its own
    // task well before they return. `editHolds` is cleared by nothing but
    // `releaseEdit` below, which is what makes their completion an observation
    // of the held window.
    await settles(readRole(movePacer.ref))
    await settles(readRole(movePacer.ref))
    expect(editHolds).toBe(true)
    expect(moveAdmittedWhileHeld).toBeUndefined()
    releaseEdit.resolve()
    const [edited, moved] = await settles(Promise.all([editing, moving]))

    expect(edited.result?.isError, toolText(edited)).not.toBe(true)
    expect(moved.result?.isError, toolText(moved)).not.toBe(true)
    // The move did enter, and only once the edit's claim had let go.
    expect(moveAdmittedWhileHeld).toBe(false)
    const movedRef = (moved.result!.structuredContent as { ref: string }).ref

    expect(moved.result?.structuredContent).toMatchObject({
      steps: [{ step: 'home', outcome: 'applied' }],
    })
    expect(movedRef).not.toBe(editFirstRole.ref)
    expect(await readRole(movedRef)).toMatchObject({
      instructions: editedBody,
      scope: 'space',
    })

    vi.mocked(CachedStore.prototype.withExactNoteClaim).mockRestore()
    const moveFirstRole = await createRole('move-before-edit', sharedProject)
    const placementOriginal = SpaceResourceAuthority.prototype.admitSkillPlacement
    const moveAdmitted = deferred()
    const releaseMove = deferred()
    const staleRequested = deferred()

    vi.spyOn(SpaceResourceAuthority.prototype, 'admitSkillPlacement').mockImplementation(
      async function (this: SpaceResourceAuthority, path, mode, owner, options) {
        const lease = await placementOriginal.call(this, path, mode, owner, options)

        if (path.includes(moveFirstRole.packageId) && owner === 'role-move-placement') {
          moveAdmitted.resolve()
          await releaseMove.promise
        }

        return lease
      },
    )
    const moveWins = call('edit_ability', {
      ref: moveFirstRole.ref,
      home: { home: 'space' },
    })

    await barrier(moveAdmitted.promise)
    const staleExactOriginal = CachedStore.prototype.withExactNoteClaim

    vi.spyOn(CachedStore.prototype, 'withExactNoteClaim').mockImplementation(async function <T>(
      this: CachedStore,
      noteId: string,
      task: (current: NoteContent) => Promise<T>,
    ): Promise<T> {
      if (noteId === moveFirstRole.noteId) {
        staleRequested.resolve()
      }

      return callExactNoteClaim(staleExactOriginal, this, noteId, task)
    })
    const staleEdit = editRole(
      moveFirstRole,
      '# Move before edit\n\nA stale write must not land.',
      moveFirstRole.versionToken,
    )

    await barrier(staleRequested.promise)
    releaseMove.resolve()
    const movedFirst = await settles(moveWins)
    const staleResult = await settles(staleEdit)

    expect(movedFirst.result?.isError, toolText(movedFirst)).not.toBe(true)
    expect(staleResult.result?.isError, toolText(staleResult)).not.toBe(true)
    expect(staleResult.result?.structuredContent).toMatchObject({
      steps: [{ step: 'document', outcome: 'failed', error: expect.any(String) }],
    })
    const currentRef = (movedFirst.result!.structuredContent as { ref: string }).ref
    const current = await readRole(currentRef)

    expect(current).toMatchObject({ scope: 'space' })
    expect(current.instructions).not.toContain('A stale write must not land.')
  })

  it('rejects a move when the admitted source package is physically replaced', async () => {
    await boot()
    await createSpace('replacement-space')
    const project = await createProject('launch', 'replacement-space')
    const role = await createRole('physical-replacement', project)
    const projects = await app!.inject({
      method: 'GET',
      url: '/api/s/replacement-space/projects',
      headers: { cookie },
    })

    expect(projects.statusCode, projects.body).toBe(200)
    const projectId = (
      projects.json() as { projects: Array<{ handle: string; id: string }> }
    ).projects.find(({ handle }) => handle === project)?.id

    expect(projectId).toBeTruthy()
    const projectDirectory = Buffer.from(projectId!, 'utf8').toString('base64url')
    const source = join(
      root,
      'spaces',
      'replacement-space',
      '.notarium',
      'skills',
      '_projects',
      projectDirectory,
      role.packageId,
    )
    const target = join(root, 'spaces', 'replacement-space', '.notarium', 'skills', role.packageId)
    const displaced = `${source}.displaced`
    const originalManifest = await readFile(join(source, 'SKILL.md'), 'utf8')
    const admitOriginal = SpaceResourceAuthority.prototype.admitPackage
    const observeOriginal = SpaceResourceAuthority.prototype.observeDirectoryBoundAdmitted
    let moveSourceAdmitted = false
    let replaced = false

    vi.spyOn(SpaceResourceAuthority.prototype, 'admitPackage').mockImplementation(async function (
      this: SpaceResourceAuthority,
      path,
      mode,
      owner,
      options,
    ) {
      const lease = await admitOriginal.call(this, path, mode, owner, options)

      if (owner === 'role-move-source' && path.includes(role.packageId)) {
        moveSourceAdmitted = true
      }

      return lease
    })
    vi.spyOn(SpaceResourceAuthority.prototype, 'observeDirectoryBoundAdmitted').mockImplementation(
      async function (this: SpaceResourceAuthority, path, maxBytes) {
        const observation = await observeOriginal.call(this, path, maxBytes)

        if (moveSourceAdmitted && !replaced && path.includes(role.packageId)) {
          replaced = true
          await rename(source, displaced)
          await mkdir(source, { recursive: true })
          await writeFile(join(source, 'SKILL.md'), originalManifest)
        }

        return observation
      },
    )

    const moved = await within(
      call('edit_ability', { ref: role.ref, home: { home: 'space' } }),
      3_000,
    )

    expect(replaced).toBe(true)
    expect(moved.result?.isError, toolText(moved)).not.toBe(true)
    expect(moved.result?.structuredContent).toMatchObject({
      steps: [{ step: 'home', outcome: 'failed', error: expect.any(String) }],
    })
    await expect(readFile(join(target, 'SKILL.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readFile(join(source, 'SKILL.md'), 'utf8')).resolves.toBe(originalManifest)
    const db = new DatabaseSync(join(root, 'meta.db'), { readOnly: true })

    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ability_placement_trail`).get()).toEqual({
        count: 0,
      })
    } finally {
      db.close()
    }
  })

  it('lets the periodic poll progress after the exact edit without leaving HOL', async () => {
    const stage = async <T>(name: string, promise: Promise<T>): Promise<T> => {
      try {
        return await settles(promise)
      } catch (error) {
        throw new Error(`${name}: ${(error as Error).message}`, { cause: error })
      }
    }

    // Drive the exact producer the periodic timer calls through its public test/host
    // entrypoint. Waiting for a real 50 ms interval made this queue-order proof depend
    // on whether a loaded Vitest process gave timers a turn inside an arbitrary budget.
    const stores = new Set<CachedStore>()
    const startOriginal = CachedStore.prototype.start

    vi.spyOn(CachedStore.prototype, 'start').mockImplementation(function (
      this: CachedStore,
    ): Promise<void> {
      stores.add(this)
      return Reflect.apply(startOriginal, this, []) as Promise<void>
    })
    await boot()
    const role = await createRole('reconcile-progress')

    expect(stores.size).toBe(1)
    const store = [...stores][0]!
    const exactOriginal = CachedStore.prototype.withExactNoteClaim
    const gatedRoleId = role.noteId
    let targetCalls = 0
    let exactHeld = false
    const entered = deferred()
    const release = deferred()
    const pollRequested = deferred()
    const runOriginal = MutationCoordinator.prototype.run

    vi.spyOn(MutationCoordinator.prototype, 'run').mockImplementation(async function <T>(
      this: MutationCoordinator,
      claim: MutationClaim,
      task: () => Promise<T>,
    ): Promise<T> {
      const pending = Reflect.apply(runOriginal, this, [claim, task]) as Promise<T>

      if (exactHeld && claim.global) {
        pollRequested.resolve()
      }

      return pending
    })

    vi.spyOn(CachedStore.prototype, 'withExactNoteClaim').mockImplementation(async function <T>(
      this: CachedStore,
      noteId: string,
      task: (current: NoteContent) => Promise<T>,
    ): Promise<T> {
      if (noteId === gatedRoleId && ++targetCalls === 2) {
        return callExactNoteClaim(exactOriginal, this, noteId, async (current) => {
          exactHeld = true
          entered.resolve()
          try {
            await release.promise
            return await task(current)
          } finally {
            exactHeld = false
          }
        })
      }

      return callExactNoteClaim(exactOriginal, this, noteId, task)
    })
    const unrelated = await app!.inject({
      method: 'POST',
      url: `/api/s/${personalSlug}/notes`,
      headers: { cookie },
      payload: { content: '# Reconcile neighbour\n\nIndependent.' },
    })

    expect(unrelated.statusCode, unrelated.body).toBe(200)
    const unrelatedId = (unrelated.json() as { id: string }).id

    const pollStatus = async (): Promise<string | null> => {
      const response = await app!.inject({
        method: 'GET',
        url: `/api/s/${personalSlug}/status`,
        headers: { cookie },
      })

      expect(response.statusCode, response.body).toBe(200)
      return (response.json() as { delta: { lastPollAt: string | null } }).delta.lastPollAt
    }

    await stage('baseline reconcile', store.reconcile())
    const heldPoll = (await pollStatus())!
    const editing = editRole(role, '# Reconcile progress\n\nUpdated.')

    await stage('exact edit entry', entered.promise)
    const followingRead = app!.inject({
      method: 'GET',
      url: `/api/note?id=${encodeURIComponent(unrelatedId)}`,
      headers: { cookie },
    })

    // The HOL half of this row: an exact edit fences its own target only, so an
    // unrelated read completes while that exact claim is still deliberately held.
    const read = await stage('unrelated read', followingRead)

    expect(read.statusCode, read.body).toBe(200)
    expect(exactHeld).toBe(true)
    const polling = store.reconcile()

    try {
      await stage('poll claim request', pollRequested.promise)
      expect(await pollStatus()).toBe(heldPoll)
    } finally {
      release.resolve()
    }
    const [edited] = await stage('edit and poll completion', Promise.all([editing, polling]))

    expect(edited.result?.isError, toolText(edited)).not.toBe(true)
    expect(Date.parse((await pollStatus())!)).toBeGreaterThan(Date.parse(heldPoll))
    await stage('post-poll read', readRole(role.ref))
  }, 30_000)

  it('keeps package delete behind its existing Core-global claim', async () => {
    await boot()
    const role = await createRole('global-delete-order')
    const unrelated = await app!.inject({
      method: 'POST',
      url: `/api/s/${personalSlug}/notes`,
      headers: { cookie },
      payload: { content: '# Delete neighbour\n\nMust wait behind the global claim.' },
    })

    expect(unrelated.statusCode, unrelated.body).toBe(200)
    const unrelatedId = (unrelated.json() as { id: string }).id
    // A note read takes its own Core claim keyed by the note's id and its storage
    // path, and which spelling reaches the engine depends on the mount's identity
    // capability. Both are captured here so the admission seam below recognises
    // this read whichever way it is addressed.
    const unrelatedDetail = await app!.inject({
      method: 'GET',
      url: `/api/note?id=${encodeURIComponent(unrelatedId)}`,
      headers: { cookie },
    })

    expect(unrelatedDetail.statusCode, unrelatedDetail.body).toBe(200)
    const unrelatedAddresses = new Set(
      [unrelatedId, (unrelatedDetail.json() as { id?: string }).id].filter(Boolean) as string[],
    )
    const unrelatedPath = (unrelatedDetail.json() as { filePath: string }).filePath
    // The pacer is the same operation on a DIFFERENT space, and a second space is
    // a second store with its own coordinator — so it is not gated by this
    // delete's claim at all. Completing it inside the window is what makes the
    // same-space read's silence an observation rather than a scheduling artifact.
    await createSpace('delete-pacer')
    const pacerNote = await app!.inject({
      method: 'POST',
      url: '/api/s/delete-pacer/notes',
      headers: { cookie },
      payload: { content: '# Delete pacer\n\nIndependent store, independent coordinator.' },
    })

    expect(pacerNote.statusCode, pacerNote.body).toBe(200)
    const pacerId = (pacerNote.json() as { id: string }).id
    const readPacer = () =>
      app!.inject({
        method: 'GET',
        url: `/api/note?id=${encodeURIComponent(pacerId)}`,
        headers: { cookie },
      })
    const original = SpaceResourceAuthority.prototype.admitSkillPlacement
    const admitted = deferred()
    const release = deferred()
    const authorities = new Set<SpaceResourceAuthority>()
    // True exactly while the delete sits at its package lease — which it reaches
    // from inside the Core-global claim it already holds. So the holder's state at
    // the instant the unrelated read is admitted decides "the read waited for the
    // global claim", instead of which promise happened to settle first.
    let deleteHoldsCore = false
    let watchUnrelated = false
    let unrelatedAdmittedWhileHeld: boolean | undefined
    const innerRead = NotariumStore.prototype.read

    vi.spyOn(NotariumStore.prototype, 'read').mockImplementation(async function (
      this: NotariumStore,
      key,
      options,
    ) {
      // Reached only from inside the read's own admitted claim, so this is the
      // read's admission point, not its request.
      if (
        watchUnrelated &&
        (String(key) === unrelatedPath ||
          [...unrelatedAddresses].some((address) => String(key).includes(address)))
      ) {
        unrelatedAdmittedWhileHeld ??= deleteHoldsCore
      }

      return innerRead.call(this, key, options)
    })
    vi.spyOn(SpaceResourceAuthority.prototype, 'admitSkillPlacement').mockImplementation(
      async function (this: SpaceResourceAuthority, path, mode, owner, options) {
        const lease = await original.call(this, path, mode, owner, options)
        authorities.add(this)

        if (path.includes(role.packageId) && owner === 'notarium-remove-skill-package') {
          deleteHoldsCore = true
          admitted.resolve()
          try {
            await release.promise
          } finally {
            deleteHoldsCore = false
          }
        }

        return lease
      },
    )
    const deleting = call('delete_ability', { ref: role.ref })

    await barrier(admitted.promise)
    let unrelatedSettled = false

    watchUnrelated = true
    const reading = app!.inject({
      method: 'GET',
      url: `/api/note?id=${encodeURIComponent(unrelatedId)}`,
      headers: { cookie },
    })
    void reading.then(
      () => {
        unrelatedSettled = true
      },
      () => {
        unrelatedSettled = true
      },
    )
    const firstPacer = await settles(readPacer())
    const secondPacer = await settles(readPacer())

    expect(firstPacer.statusCode, firstPacer.body).toBe(200)
    expect(secondPacer.statusCode, secondPacer.body).toBe(200)
    const health = await app!.inject({ method: 'GET', url: '/api/health' })

    expect(health.statusCode).toBe(200)
    expect(deleteHoldsCore).toBe(true)
    expect(unrelatedAdmittedWhileHeld).toBeUndefined()
    expect(unrelatedSettled).toBe(false)
    release.resolve()
    const [removed, read] = await settles(Promise.all([deleting, reading]))

    expect(removed.result?.isError, toolText(removed)).not.toBe(true)
    expect(read.statusCode, read.body).toBe(200)
    // The read did get in, and only after the global claim let go of it.
    expect(unrelatedAdmittedWhileHeld).toBe(false)
    expectAuthoritiesIdle(authorities)
  })

  it('finishes server work and releases leases after the MCP client disconnects', async () => {
    await boot()
    const role = await createRole('disconnect-cleanup')
    const authorities = new Set<SpaceResourceAuthority>()
    const placementOriginal = SpaceResourceAuthority.prototype.admitSkillPlacement

    vi.spyOn(SpaceResourceAuthority.prototype, 'admitSkillPlacement').mockImplementation(
      async function (this: SpaceResourceAuthority, path, mode, owner, options) {
        authorities.add(this)
        return placementOriginal.call(this, path, mode, owner, options)
      },
    )
    const exactOriginal = CachedStore.prototype.withExactNoteClaim
    const entered = deferred()
    const release = deferred()
    const terminal = deferred()
    let targetCalls = 0

    vi.spyOn(CachedStore.prototype, 'withExactNoteClaim').mockImplementation(async function <T>(
      this: CachedStore,
      noteId: string,
      task: (current: NoteContent) => Promise<T>,
    ): Promise<T> {
      const guarded =
        noteId === role.noteId && ++targetCalls === 2
          ? (current: NoteContent) => {
              entered.resolve()
              return release.promise.then(() => task(current))
            }
          : task

      try {
        return await callExactNoteClaim(exactOriginal, this, noteId, guarded)
      } finally {
        if (guarded !== task) {
          terminal.resolve()
        }
      }
    })

    await app!.listen({ host: '127.0.0.1', port: 0 })
    const address = app!.server.address()

    if (!address || typeof address === 'string') {
      throw new Error('Fastify did not expose an ephemeral TCP address')
    }
    const controller = new AbortController()
    const request = fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: {
          name: 'edit_ability',
          arguments: {
            ref: role.ref,
            versionToken: role.versionToken,
            instructions: '# Disconnect cleanup\n\nServer work still terminates.',
          },
        },
      }),
      signal: controller.signal,
    })

    await barrier(entered.promise)
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    release.resolve()
    await barrier(terminal.promise)
    expectAuthoritiesIdle(authorities)
    await settles(readRole(role.ref))
    expectAuthoritiesIdle(authorities)
  })
})
