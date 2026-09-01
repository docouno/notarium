// The `.notariummeta` marker subsystem (#13 I0c): the tolerant parser, the
// engine-managed marker store over a real localFs tree, the write-through
// mark-as-project core-op, and the boot-scan that rebuilds the registry from
// on-disk markers. These exercise the REAL filesystem walk (dotfile handling,
// index-isolation, the `.notarium/` skip) — the one piece the e2e fake (no FS)
// can't cover.

import type * as nodeFs from 'node:fs'
import {
  closeSync,
  promises as fs,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalFsFiles } from '@notarium/engine'

// The anchor probe is three synchronous calls; wrapping exactly those (and
// nothing else this file touches) is what makes its negative branches provable
// without a second operating system.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>()

  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    fstatSync: vi.fn(actual.fstatSync),
    openSync: vi.fn(actual.openSync),
    statSync: vi.fn(actual.statSync),
  }
})

import {
  acquireMarkPrefixLock,
  createMarkerStore,
  ensureFolderIdentity,
  finalizeFolderMove,
  localFsAnchoredFiles,
  type MarkerScan,
  type MarkerStore,
  type MarkerStoreOptions,
  markFolderAsProject,
  parseMarker,
  type ProjectRecord,
  recordFolderRename,
  renameProjectSlug,
  scanProjectsAtBoot,
  serializeMarker,
  unmarkProject,
  withMarkLock,
} from '@notarium/server'

// The runtime seam stays off the package barrel: a pure table that ACCEPTS the
// fact it should discover reads like a capability query once it is public.
import {
  anchoredMarkerWritesAvailable,
  anchoredMarkerWritesForRuntime,
} from '../../packages/server/src/services/projects/markerStore'
import { InMemoryFolders } from '../fake-server/folders'
import { InMemoryProjects } from '../fake-server/projects'

const actualFs = await vi.importActual<typeof nodeFs>('node:fs')
const closeSyncMock = vi.mocked(closeSync)
const fstatSyncMock = vi.mocked(fstatSync)
const openSyncMock = vi.mocked(openSync)
const statSyncMock = vi.mocked(statSync)

const VALID_ID = 'Ab3xK9_qZ2mN' // 12 chars, freshNoteId shape
const now = () => new Date('2026-06-18T00:00:00.000Z')

/** A store built the way production builds one: the host anchor probed (or
 *  stated) AND the storage half handed over. Both are prerequisites of the same
 *  capability, so a case that means to withhold one has to say which. */
const capableMarkerStore = (
  notesDirFor: (space: string) => string | null,
  options: MarkerStoreOptions = {},
) => createMarkerStore(notesDirFor, { anchoredFilesForRoot: localFsAnchoredFiles(), ...options })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notarium-proj-'))
})
afterEach(() => {
  // An unconsumed one-shot would leak into the next case, and these four sit on
  // the anchor probe every marker store runs at construction.
  closeSyncMock.mockReset().mockImplementation(actualFs.closeSync)
  fstatSyncMock.mockReset().mockImplementation(actualFs.fstatSync)
  openSyncMock.mockReset().mockImplementation(actualFs.openSync)
  statSyncMock.mockReset().mockImplementation(actualFs.statSync)
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** Two markers, because the anchor is missing for two unrelated reasons and only
 *  one of them is permanent: a non-Linux platform will never grow `/proc`, while
 *  a Linux host without the dynamic fd entries is a property of THIS container. */
const ANCHOR_PLATFORM_GATE = '[gate: anchored marker write (non-Linux platform)]'
const ANCHOR_PROC_GATE = '[gate: anchored marker write (/proc/self/fd unavailable)]'
const anchorGate = anchoredMarkerWritesAvailable()
  ? null
  : anchoredMarkerWritesForRuntime({ platform: process.platform, procSelfFdAnchor: true })
    ? ANCHOR_PROC_GATE
    : ANCHOR_PLATFORM_GATE

/** `describe` for a suite that publishes a real marker through an open directory
 *  inode. Its deterministic siblings below run everywhere and are NOT gated. */
const describeAnchoredMarkerWrite = (name: string, fn: () => void): void => {
  const suite = anchorGate === null ? describe : describe.skip

  suite(anchorGate === null ? name : `${name} ${anchorGate}`, fn)
}

/** The single-case form, for a publishing test inside a suite that is NOT gated.
 *  Most suites below are mixed — a marker write sits beside cases that only read
 *  the registry — so gating them whole would hide the portable half behind a
 *  runtime verdict it does not depend on. */
const itAnchoredMarkerWrite = (name: string, fn: () => void | Promise<void>): void => {
  const test = anchorGate === null ? it : it.skip

  test(anchorGate === null ? name : `${name} ${anchorGate}`, fn)
}

/** A stat answer the probe can compare, with no real inode behind it. */
const inode = (dev: bigint, ino: bigint) => ({ dev, ino }) as unknown as Stats

/** Pin `process.platform` for one case so the matrix means the same on a laptop
 *  as it does in CI. */
const withPlatform = <T>(value: string, run: () => T): T => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

  Object.defineProperty(process, 'platform', { configurable: true, value })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
}

const writeMarkerFile = (folderPath: string, body: Record<string, unknown>) => {
  const target = folderPath ? join(dir, folderPath) : dir
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, '.notariummeta'), JSON.stringify(body))
}

/** A markerStore whose scan returns a fixed result — lets a test drive the
 *  `complete` flag (a real FS can't reproduce a transient read error as root). */
const stubMarkerStore = (scan: MarkerScan): MarkerStore => ({
  available: () => true,
  write: async () => {},
  read: async () => null,
  remove: async () => {},
  folderExists: async () => true,
  scan: async () => scan,
})

describe('parseMarker (#13)', () => {
  it('accepts a well-formed marker and reads every field', () => {
    expect(
      parseMarker(
        JSON.stringify({
          id: VALID_ID,
          slug: 'billing',
          displayName: 'Billing',
          status: 'archived',
        }),
      ),
    ).toEqual({
      id: VALID_ID,
      slug: 'billing',
      displayName: 'Billing',
      status: 'archived',
    })
  })

  it('tolerates unknown/future keys (additive evolution — no migration; color is v-next, not wired in v1)', () => {
    const f = parseMarker(JSON.stringify({ id: VALID_ID, futureField: 42, color: '#fff' }))
    expect(f).toEqual({ id: VALID_ID }) // unknown keys ignored, never half-carried
  })

  it('fail-closes on broken JSON / missing or malformed id (folder treated as unmarked)', () => {
    expect(parseMarker('{not json')).toBeNull()
    expect(parseMarker(JSON.stringify({ displayName: 'no id' }))).toBeNull()
    expect(parseMarker(JSON.stringify({ id: 'too-short' }))).toBeNull()
    expect(parseMarker(JSON.stringify({ id: 12345 }))).toBeNull()
  })

  it('drops a malformed slug rather than trusting it (re-derived later)', () => {
    expect(parseMarker(JSON.stringify({ id: VALID_ID, slug: 'Bad Slug!' }))?.slug).toBeUndefined()
  })

  it('round-trips through serializeMarker', () => {
    const fields = {
      id: VALID_ID,
      slug: 'billing',
      displayName: 'Billing',
      status: 'active' as const,
    }
    expect(parseMarker(serializeMarker(fields))).toEqual(fields)
  })

  it('round-trips a durable Unicode display name without changing code points', () => {
    const displayName = '研发 e\u0301 🚀'
    const fields = { id: VALID_ID, slug: 'research', displayName }

    expect(parseMarker(serializeMarker(fields))?.displayName).toBe(displayName)
  })

  it('round-trips a folder marker (#100 phase 3): type + RAW pathAliases (cyrillic dirs survive)', () => {
    // The engine stores directories VERBATIM (a cyrillic `Космос`, not a slug), so
    // pathAliases are raw paths — only a sanity gate (no `..`, no leading slash),
    // NOT a slug check (which would drop them). Caught live on a dev stand.
    const fields = { id: VALID_ID, type: 'folder' as const, pathAliases: ['Космос', 'old/sub dir'] }
    expect(parseMarker(serializeMarker(fields))).toEqual(fields)
    // A project marker omits `type` (the file-format default) → it round-trips bare.
    expect(serializeMarker({ id: VALID_ID, slug: 'x' })).not.toMatch(/"type"/)
    // Traversal / leading-slash path aliases are dropped, never trusted.
    const dirty = parseMarker(
      JSON.stringify({
        id: VALID_ID,
        type: 'folder',
        pathAliases: ['ok', '../esc', '/abs', 'a//b', 'ok'],
      }),
    )
    expect(dirty?.pathAliases).toEqual(['ok'])
  })

  it('drops marker strings that JSON can decode but UTF-8/path scalars cannot preserve', () => {
    const lone = String.fromCharCode(0xd800)
    const marker = parseMarker(
      JSON.stringify({
        id: VALID_ID,
        type: 'folder',
        displayName: `bad${lone}`,
        pathAliases: [`bad${lone}`, 'bad\0path', 'valid/Путь'],
      }),
    )

    expect(marker?.displayName).toBeUndefined()
    expect(marker?.pathAliases).toEqual(['valid/Путь'])
  })

  it('round-trips aliases (#100 phase 2): well-formed past slugs survive, malformed/dup are dropped', () => {
    // Past handle slugs travel in the marker (Fork A) so old `space/<slug>` survives
    // an external re-clone. Only slug-shaped entries are trusted; dups collapse.
    const fields = {
      id: VALID_ID,
      slug: 'guides',
      aliases: ['docs', 'handbook'],
      displayName: 'Guides',
    }
    expect(parseMarker(serializeMarker(fields))).toEqual(fields)
    const dirty = parseMarker(
      JSON.stringify({ id: VALID_ID, slug: 'guides', aliases: ['docs', 'Bad Slug!', 'docs', 42] }),
    )
    expect(dirty?.aliases).toEqual(['docs']) // malformed + dup dropped, never trusted blind
    // An empty aliases array is omitted on serialize (no noise in the committed marker).
    expect(serializeMarker({ id: VALID_ID, slug: 'x', aliases: [] })).not.toMatch(/aliases/)
  })
})

describe('anchored marker write capability', () => {
  it.each([
    ['linux', true, true],
    ['linux', false, false],
    ['darwin', true, false],
    ['win32', false, false],
  ] as const)('answers %s with a proven fd anchor=%s', (platform, procSelfFdAnchor, available) => {
    expect(anchoredMarkerWritesForRuntime({ platform, procSelfFdAnchor })).toBe(available)
  })

  /** Drive the three probe calls without touching a real `/proc`. */
  const probeWith = (opened: Stats | Error, throughProc: Stats | Error): boolean =>
    withPlatform('linux', () => {
      // The gate probe at module scope already ran through these same mocks. Read
      // this case's own calls, not whatever ran before it: without the clear the
      // pathname assertions below pass or fail by test ORDER.
      closeSyncMock.mockClear()
      fstatSyncMock.mockClear()
      openSyncMock.mockClear()
      statSyncMock.mockClear()
      openSyncMock.mockImplementationOnce((() => 4242) as never)
      fstatSyncMock.mockImplementationOnce(((): Stats => {
        if (opened instanceof Error) {
          throw opened
        }

        return opened
      }) as never)
      statSyncMock.mockImplementationOnce(((): Stats => {
        if (throughProc instanceof Error) {
          throw throughProc
        }

        return throughProc
      }) as never)
      closeSyncMock.mockImplementationOnce(() => {})

      return anchoredMarkerWritesAvailable()
    })

  it('declares the capability only when /proc/self/fd re-enters the opened inode', () => {
    expect(probeWith(inode(1n, 2n), inode(1n, 2n))).toBe(true)
    // Which pathnames, not just which verdict. The DYNAMIC entry is the whole
    // proof: stat-ing `/proc/self/fd` itself answers true on a container that
    // carries the directory without per-fd entries — the exact host that must
    // be refused, and a shape both routes agree on by accident on a real Linux.
    // Pathname AND mode. `O_DIRECTORY` is the only thing that makes the open
    // fail closed on the object's TYPE: without it a FIFO left over a masked
    // `/proc` blocks this call — which runs inside server construction — until a
    // writer appears, and a device node is simply opened.
    expect(openSyncMock.mock.calls[0]).toEqual([
      '/proc/self/fd',
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0),
    ])
    expect(statSyncMock.mock.calls[0]?.[0]).toBe('/proc/self/fd/4242')
    // The fd is handed back either way — a probe that leaked one per store would
    // exhaust the process long before anyone noticed the capability was right.
    expect(closeSyncMock).toHaveBeenCalledWith(4242)
  })

  it.each([
    ['the entry names a different inode', inode(1n, 2n), inode(1n, 99n)],
    ['the entry is on a different device', inode(1n, 2n), inode(7n, 2n)],
    [
      'the dynamic entry is missing',
      inode(1n, 2n),
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    ],
    [
      'the opened fd cannot be stat-ed',
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      inode(1n, 2n),
    ],
  ] as const)('withholds it when %s', (_case, opened, throughProc) => {
    expect(probeWith(opened, throughProc)).toBe(false)
    expect(closeSyncMock).toHaveBeenCalledWith(4242)
  })

  it('withholds it when /proc/self/fd cannot be opened as a directory', () => {
    const closed = withPlatform('linux', () => {
      closeSyncMock.mockClear()
      openSyncMock.mockImplementationOnce((() => {
        throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' })
      }) as never)

      return anchoredMarkerWritesAvailable()
    })

    expect(closed).toBe(false)
    expect(closeSyncMock).not.toHaveBeenCalled()
  })

  // The table above is fed facts by hand; this pins the WIRING of the platform
  // half — that it is read from the process rather than assumed. Deleting that
  // conjunct left every test green, and a kernel serving a plausible
  // `/proc/self/fd` would then be declared able to anchor a write it cannot.
  it.each([
    ['linux', true],
    ['darwin', false],
    ['win32', false],
  ] as const)('reads the platform from the process itself on %s', (platform, available) => {
    const answered = withPlatform(platform, () => {
      openSyncMock.mockImplementationOnce((() => 4242) as never)
      fstatSyncMock.mockImplementationOnce((() => inode(1n, 2n)) as never)
      statSyncMock.mockImplementationOnce((() => inode(1n, 2n)) as never)
      closeSyncMock.mockImplementationOnce(() => {})

      return anchoredMarkerWritesAvailable()
    })

    expect(answered).toBe(available)
  })

  it('closes the gate only where the runtime truly cannot anchor a write', () => {
    // The same blind spot the other two gates have: welded shut it skips every
    // gated case in this file and the run stays green, so the contract stops
    // being exercised without one red line. The probe is the witness — the gate
    // must never claim something the runtime did not say.
    expect(anchorGate === null).toBe(anchoredMarkerWritesAvailable())
  })

  it('has no capability for a space without a notes dir (honest degradation)', () => {
    expect(capableMarkerStore(() => null, { anchoredWritesAvailable: true }).available('s')).toBe(
      false,
    )
  })

  it('has no capability where the STORAGE half is absent, anchor or not', () => {
    // The other prerequisite, and the one a host-anchor-only answer used to miss:
    // `/proc/self/fd` says this process can address an opened directory, not that
    // the adapter under it can publish bytes conditionally.
    expect(
      createMarkerStore(() => dir, {
        anchoredWritesAvailable: true,
        anchoredFilesForRoot: undefined,
      }).available('s'),
    ).toBe(false)
  })

  it('refuses a write with no storage half before it resolves a root or opens a folder', async () => {
    const notesDirFor = vi.fn(() => dir)
    const store = createMarkerStore(notesDirFor, {
      anchoredWritesAvailable: true,
      anchoredFilesForRoot: undefined,
    })

    mkdirSync(join(dir, 'docs'), { recursive: true })
    notesDirFor.mockClear()

    await expect(store.write('s', 'docs', 'raw')).rejects.toMatchObject({ code: 'ENOTSUP' })
    // Not one filesystem call: the refusal is the shape of the store, settled at
    // construction, not something discovered on the way to a temp file.
    expect(notesDirFor).not.toHaveBeenCalled()
    expect(readdirSync(join(dir, 'docs'))).toEqual([])
  })

  it('anchors the storage half on the opened fd, never on the public pathname', async () => {
    const roots: string[] = []
    const store = createMarkerStore(() => dir, {
      anchoredWritesAvailable: true,
      anchoredFilesForRoot: (anchorRoot) => {
        roots.push(anchorRoot)

        return localFsAnchoredFiles()!(anchorRoot)
      },
    })

    mkdirSync(join(dir, 'docs'), { recursive: true })
    await store.write('s', 'docs', serializeMarker({ id: VALID_ID, slug: 'docs' }))

    // `/proc/self/fd/<fd>` — the public path would let a folder replaced between
    // the open and the write receive the bytes.
    expect(roots).toHaveLength(1)
    expect(roots[0]).toMatch(/^\/proc\/self\/fd\/\d+$/)
    await expect(store.read('s', 'docs')).resolves.toContain(VALID_ID)
  })

  it('reads, scans and unmarks with no storage half at all', async () => {
    // The read side is portable and asks nothing: a host that cannot publish a
    // marker must still be able to see the ones already on disk.
    const capable = capableMarkerStore(() => dir)

    mkdirSync(join(dir, 'docs'), { recursive: true })
    await capable.write('s', 'docs', serializeMarker({ id: VALID_ID, slug: 'docs' }))

    const readOnly = createMarkerStore(() => dir, {
      anchoredWritesAvailable: true,
      anchoredFilesForRoot: undefined,
    })

    await expect(readOnly.read('s', 'docs')).resolves.toContain(VALID_ID)
    expect((await readOnly.scan('s')).hits.map((hit) => hit.folderPath)).toEqual(['docs'])
    await expect(readOnly.folderExists('s', 'docs')).resolves.toBe(true)
    await readOnly.remove('s', 'docs')
    await expect(readOnly.read('s', 'docs')).resolves.toBeNull()
  })

  it('has no capability where the anchor is absent, notes dir or not', () => {
    expect(capableMarkerStore(() => dir, { anchoredWritesAvailable: false }).available('s')).toBe(
      false,
    )
    expect(capableMarkerStore(() => dir, { anchoredWritesAvailable: true }).available('s')).toBe(
      true,
    )
  })

  // Production supplies notes-root resolution and the conditional mutation
  // factory, but leaves the host-anchor fact unstated. Every case above pins
  // that fact, so this one proves the default still consults the runtime probe.
  it('consults the probe when the caller states nothing, as the server does', () => {
    const declared = withPlatform('linux', () => {
      openSyncMock.mockImplementationOnce((() => {
        throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' })
      }) as never)

      return capableMarkerStore(() => dir).available('s')
    })

    expect(declared).toBe(false)
  })

  it('refuses a write on an unsupported runtime before it touches the folder', async () => {
    const notesDirFor = vi.fn(() => dir)
    const store = capableMarkerStore(notesDirFor, { anchoredWritesAvailable: false })
    mkdirSync(join(dir, 'docs'), { recursive: true })
    notesDirFor.mockClear()

    await expect(
      store.write('s', 'docs', serializeMarker({ id: VALID_ID, slug: 'docs' })),
    ).rejects.toMatchObject({ code: 'ENOTSUP' })
    // Neither the marker nor the temp file an interrupted CAS would leave: the
    // refusal landed before the root was even resolved.
    expect(notesDirFor).not.toHaveBeenCalled()
    expect(await fs.readdir(join(dir, 'docs'))).toEqual([])
  })

  it('keeps the whole portable half working with no anchor at all', async () => {
    // Both canon docs promise this — the read side asks nothing of the runtime,
    // and dropping a marker is an ordinary portable `remove`, because an anchor
    // is what a PUBLICATION needs, not a deletion. Of the four methods only
    // `scan` was pinned, so gating any of the other three was invisible.
    const store = capableMarkerStore(() => dir, { anchoredWritesAvailable: false })

    writeMarkerFile('docs', { id: VALID_ID, slug: 'docs' })

    await expect(store.read('s', 'docs')).resolves.toContain(VALID_ID)
    await expect(store.folderExists('s', 'docs')).resolves.toBe(true)
    await store.remove('s', 'docs')
    await expect(store.read('s', 'docs')).resolves.toBeNull()
  })

  it('refuses to write a marker under a dot namespace (mount-boundary belt #78), normalising backslashes, ahead of the runtime verdict', async () => {
    // A dot-segment verdict is a pure string decision no host can change, so it
    // stays ahead of the capability check: relabelling it "unavailable" would
    // make the mount boundary read differently from one OS to the next.
    const store = capableMarkerStore(() => dir, { anchoredWritesAvailable: false })

    await expect(store.write('s', '.notarium/memory', '{}')).rejects.toThrow(/dot namespace/)
    await expect(store.write('s', 'foo\\.notarium\\memory', '{}')).rejects.toThrow(/dot namespace/)
  })
})

describeAnchoredMarkerWrite('markerStore over a real tree (#13)', () => {
  it('writes/reads the sibling dotfile and finds it on scan (root + nested), skipping dot-dirs', async () => {
    const store = capableMarkerStore(() => dir)
    mkdirSync(join(dir, 'docs'), { recursive: true })
    await store.write('s', 'docs', serializeMarker({ id: VALID_ID, slug: 'docs' }))
    expect(parseMarker((await store.read('s', 'docs')) ?? '')?.id).toBe(VALID_ID)
    // A marker under the agent-mount (.notarium) and another dot-dir must NOT be enumerated.
    writeMarkerFile('.notarium/memory', { id: 'ZZZZZZZZZZZZ' })
    writeMarkerFile('', { id: 'RootRootRoot' })
    const { hits, complete } = await store.scan('s')
    expect(hits.map((h) => h.folderPath).sort()).toEqual(['', 'docs'])
    expect(complete).toBe(true) // a clean walk → safe to prune on
  })

  it('never provisions a missing user directory as a marker side effect', async () => {
    const store = capableMarkerStore(() => dir)

    await expect(
      store.write('s', 'missing', serializeMarker({ id: VALID_ID, slug: 'missing' })),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not overwrite a marker that races publication', async () => {
    const store = capableMarkerStore(() => dir)
    const folder = join(dir, 'docs')
    const marker = join(folder, '.notariummeta')
    const realLink = fs.link.bind(fs)
    let injected = false

    mkdirSync(folder, { recursive: true })
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      if (!injected && String(to).endsWith('/.notariummeta')) {
        injected = true
        await fs.writeFile(marker, 'FOREIGN-MARKER')
      }

      return realLink(from, to)
    })

    await expect(store.write('s', 'docs', 'INTENDED-MARKER')).rejects.toThrow()
    expect(injected).toBe(true)
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('FOREIGN-MARKER')
  })

  it('does not publish through a stale pathname when the marked folder is replaced', async () => {
    const store = capableMarkerStore(() => dir)
    const source = join(dir, 'docs')
    const moved = join(dir, 'moved')
    const marker = join(source, '.notariummeta')
    const realOpen = fs.open.bind(fs)
    const realRename = fs.rename.bind(fs)
    let injected = false
    let foreignTemp = ''

    mkdirSync(source, { recursive: true })
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, ...args) => {
      const handle = await realOpen(path, flags, ...args)

      if (!injected && String(path).endsWith('.tmp')) {
        injected = true
        foreignTemp = join(source, String(path).split('/').at(-1) ?? 'foreign.tmp')
        await realRename(source, moved)
        await fs.mkdir(source)
        await fs.writeFile(foreignTemp, 'FOREIGN-TEMP')
      }

      return handle
    })

    await expect(store.write('s', 'docs', 'INTENDED-MARKER')).rejects.toThrow()
    expect(injected).toBe(true)
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(foreignTemp, 'utf8')).resolves.toBe('FOREIGN-TEMP')
    expect((await fs.readdir(moved)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it.each([
    ['restores the prior marker in the captured directory', null, 'OLD'],
    ['preserves a second writer in the captured directory', 'PEER', 'PEER'],
  ] as const)('%s after an update loses its public pathname', async (_name, peer, expected) => {
    const source = join(dir, 'docs')
    const moved = join(dir, 'moved')
    const marker = join(source, '.notariummeta')
    const movedMarker = join(moved, '.notariummeta')
    const anchoredFilesForRoot = localFsAnchoredFiles()
    let injected = false

    expect(anchoredFilesForRoot).toBeDefined()
    mkdirSync(source, { recursive: true })
    await fs.writeFile(marker, 'OLD')

    const store = createMarkerStore(() => dir, {
      anchoredWritesAvailable: true,
      anchoredFilesForRoot: (anchorRoot) => {
        const anchored = anchoredFilesForRoot!(anchorRoot)

        return {
          ...anchored,
          mutation: {
            ...anchored.mutation,
            replaceIfAbsent: async (from, to, expectedSource, content) => {
              const replaced = await anchored.mutation.replaceIfAbsent(
                from,
                to,
                expectedSource,
                content,
              )

              // The anchored update is complete here, while MarkerStore has not
              // yet verified that the public pathname still names this inode.
              if (!injected && replaced && expectedSource === 'OLD' && content === 'NEW') {
                injected = true
                await fs.rename(source, moved)
                await fs.mkdir(source)
                await fs.writeFile(marker, 'PUBLIC-REPLACEMENT')

                if (peer !== null) {
                  await fs.writeFile(movedMarker, peer)
                }
              }

              return replaced
            },
          },
        }
      },
    })

    await expect(store.write('s', 'docs', 'NEW')).rejects.toMatchObject({ code: 'ESTALE' })
    expect(injected).toBe(true)
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('PUBLIC-REPLACEMENT')
    await expect(fs.readFile(movedMarker, 'utf8')).resolves.toBe(expected)
  })

  it('a written marker is STRUCTURALLY INVISIBLE to the note index (#78): localFs.scan returns the .md, never the marker', async () => {
    const store = capableMarkerStore(() => dir)
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'real-note.md'), '# Real note\n')
    await store.write('s', 'docs', serializeMarker({ id: VALID_ID, slug: 'docs' }))
    const indexed = (await createLocalFsFiles(dir).base.scan()).map((f) => f.path)
    expect(indexed).toContain('docs/real-note.md')
    expect(indexed.some((p) => p.endsWith('.notariummeta'))).toBe(false)
  })

  it('folderExists is false for a regular file (you cannot mark a file as a project)', async () => {
    const store = capableMarkerStore(() => dir)
    writeFileSync(join(dir, 'README.md'), '# readme\n')
    expect(await store.folderExists('s', 'README.md')).toBe(false)
    expect(await store.folderExists('s', '')).toBe(true) // the space root is a dir
    mkdirSync(join(dir, 'docs'), { recursive: true })
    expect(await store.folderExists('s', 'docs')).toBe(true)
  })

  it('a SYMLINKED marker (not a regular file) is not enumerated AND marks the scan incomplete (no prune on it)', async () => {
    const store = capableMarkerStore(() => dir)
    mkdirSync(join(dir, 'p'), { recursive: true })
    writeFileSync(join(dir, 'target.json'), serializeMarker({ id: VALID_ID, slug: 'p' }))
    symlinkSync(join(dir, 'target.json'), join(dir, 'p', '.notariummeta'))
    const { hits, complete } = await store.scan('s')
    expect(hits.some((h) => h.folderPath === 'p')).toBe(false) // lstat-style dirent → not a regular file
    expect(complete).toBe(false) // unclassifiable marker → lower bound → reconcile must not prune
  })
})

describe('markFolderAsProject (#13)', () => {
  it('fences every child mark behind a held folder-delete prefix', async () => {
    let openChild!: () => void
    const childGate = new Promise<void>((resolve) => {
      openChild = resolve
    })
    let openChildEntered!: () => void
    const childEntered = new Promise<void>((resolve) => {
      openChildEntered = resolve
    })
    const child = withMarkLock('s\0tree/child', async () => {
      openChildEntered()
      await childGate
    })

    await childEntered
    let prefixEntered = false
    const prefix = acquireMarkPrefixLock('s\0tree').then((release) => {
      prefixEntered = true
      return release
    })
    await Promise.resolve()
    expect(prefixEntered).toBe(false)

    openChild()
    await child
    const releasePrefix = await prefix
    let laterChildEntered = false
    const laterChild = withMarkLock('s\0tree/later', async () => {
      laterChildEntered = true
    })
    await Promise.resolve()
    expect(laterChildEntered).toBe(false)

    await releasePrefix()
    await laterChild
    expect(laterChildEntered).toBe(true)
  })

  itAnchoredMarkerWrite(
    'mints an id + slug, writes a real marker, upserts the registry row',
    async () => {
      const projects = new InMemoryProjects()
      const markerStore = capableMarkerStore(() => dir)
      mkdirSync(join(dir, 'docs'))
      const rec = await markFolderAsProject(
        { projects, markerStore, now },
        {
          space: 's',
          folderPath: 'docs',
          displayName: 'Docs',
        },
      )
      expect(rec.createdActive).toBe(true)
      expect(rec.slug).toBe('docs')
      expect(rec.id).toMatch(/^[A-Za-z0-9_-]{12}$/)
      expect(await projects.getByHandle('s', 'docs')).toMatchObject({ id: rec.id, path: 'docs' })
      // The marker landed on disk and carries id+slug (Fork A).
      const onDisk = parseMarker(readFileSync(join(dir, 'docs', '.notariummeta'), 'utf8'))
      expect(onDisk).toMatchObject({ id: rec.id, slug: 'docs', displayName: 'Docs' })
    },
  )

  it('adopts a folder identity that already sits on the SPACE ROOT', async () => {
    const projects = new InMemoryProjects()
    const folders = new InMemoryFolders(projects)
    // A registry-only host (no marker store): the id can only come from the folder row.
    // Writing a page at the root identifies it, so the root arrives at the mark already
    // carrying an identity, exactly like any other folder.
    const folderId = await ensureFolderIdentity(
      { projects, folders, now },
      {
        space: 's',
        folderPath: '',
      },
    )
    expect(folderId).toMatch(/^[A-Za-z0-9_-]{12}$/)

    const rec = await markFolderAsProject(
      { projects, folders, now },
      { space: 's', folderPath: '', displayName: 'Root' },
    )

    // The mark must FLIP that row rather than mint a second one for the same
    // (space, path): a real driver refuses the duplicate on its shared unique index, and
    // the boot scan that would prune a stale folder row needs a marker store — which a
    // host taking this branch does not have — so the space could never be marked again.
    // `''` is falsy, which is how the root slipped out of the adoption.
    expect(rec.id).toBe(folderId)
    expect(await folders.byPath('s', '')).toBeNull()
    expect((await projects.listForSpace('s')).map((p) => p.id)).toEqual([folderId])
  })

  itAnchoredMarkerWrite(
    'is idempotent: a re-mark reuses the marker id+createdAt, no duplicate',
    async () => {
      const projects = new InMemoryProjects()
      const markerStore = capableMarkerStore(() => dir)
      mkdirSync(join(dir, 'docs'))
      const first = await markFolderAsProject(
        { projects, markerStore, now },
        { space: 's', folderPath: 'docs' },
      )
      const again = await markFolderAsProject(
        { projects, markerStore, now: () => new Date('2027-01-01T00:00:00.000Z') },
        { space: 's', folderPath: 'docs' },
      )
      expect(first.createdActive).toBe(true)
      expect(again.createdActive).toBe(false)
      expect(again.id).toBe(first.id)
      expect(again.createdAt).toBe(first.createdAt) // mint moment preserved
      expect((await projects.listForSpace('s')).length).toBe(1)
    },
  )

  itAnchoredMarkerWrite(
    'owns the transition outcome inside the mark lock for concurrent marks',
    async () => {
      const projects = new InMemoryProjects()
      const markerStore = capableMarkerStore(() => dir)
      mkdirSync(join(dir, 'docs'))
      const [first, second] = await Promise.all([
        markFolderAsProject(
          { projects, markerStore, now },
          { space: 's', folderPath: 'docs', displayName: 'Docs' },
        ),
        markFolderAsProject(
          { projects, markerStore, now },
          { space: 's', folderPath: 'docs', displayName: 'Docs' },
        ),
      ])

      expect([first.createdActive, second.createdActive].sort()).toEqual([false, true])
      expect(first.id).toBe(second.id)
    },
  )

  itAnchoredMarkerWrite('suffixes a colliding slug -2/-3 (the I0c trap)', async () => {
    const projects = new InMemoryProjects()
    const markerStore = capableMarkerStore(() => dir)

    for (const path of ['a', 'b', 'c']) {
      mkdirSync(join(dir, path))
    }
    const a = await markFolderAsProject(
      { projects, markerStore, now },
      { space: 's', folderPath: 'a', displayName: 'Docs' },
    )
    const b = await markFolderAsProject(
      { projects, markerStore, now },
      { space: 's', folderPath: 'b', displayName: 'Docs' },
    )
    const c = await markFolderAsProject(
      { projects, markerStore, now },
      { space: 's', folderPath: 'c', displayName: 'Docs' },
    )
    expect([a.slug, b.slug, c.slug]).toEqual(['docs', 'docs-2', 'docs-3'])
  })

  it('runs registry-only without a marker store (the e2e fake)', async () => {
    const projects = new InMemoryProjects()
    const rec = await markFolderAsProject(
      { projects, now },
      { space: 's', folderPath: 'docs', displayName: 'Docs' },
    )
    expect(rec.slug).toBe('docs')
    expect(await projects.getById(rec.id)).toBeTruthy()
  })

  itAnchoredMarkerWrite(
    'marking a COPIED folder mints a FRESH id — never steals the original (Fork B re-mint on write)',
    async () => {
      const projects = new InMemoryProjects()
      const markerStore = capableMarkerStore(() => dir)
      mkdirSync(join(dir, 'a'))
      const orig = await markFolderAsProject(
        { projects, markerStore, now },
        { space: 's', folderPath: 'a', displayName: 'Proj' },
      )
      // Simulate `cp -r a b`: the copy carries the original's marker verbatim.
      writeMarkerFile('b', { id: orig.id, slug: orig.slug, displayName: 'Proj' })
      const copy = await markFolderAsProject(
        { projects, markerStore, now },
        { space: 's', folderPath: 'b', displayName: 'Proj' },
      )
      expect(copy.id).not.toBe(orig.id) // fresh id
      expect(copy.slug).toBe('proj-2') // fresh slug, suffixed for uniqueness
      // The original is untouched (still owns its id at its path).
      expect(await projects.getById(orig.id)).toMatchObject({ path: 'a', slug: 'proj' })
    },
  )

  itAnchoredMarkerWrite(
    'heals a divergent marker: the row already at the path wins, the marker is rewritten to match',
    async () => {
      const projects = new InMemoryProjects()
      const markerStore = capableMarkerStore(() => dir)
      mkdirSync(join(dir, 'p'))
      const rec = await markFolderAsProject(
        { projects, markerStore, now },
        { space: 's', folderPath: 'p', displayName: 'P' },
      )
      // A hand-edit puts a bogus (but well-formed) id in the marker.
      writeMarkerFile('p', { id: 'ZZZZZZZZZZZZ', slug: 'bogus' })
      const again = await markFolderAsProject(
        { projects, markerStore, now },
        { space: 's', folderPath: 'p' },
      )
      expect(again.id).toBe(rec.id) // the path-row wins, no fork
      expect(parseMarker(readFileSync(join(dir, 'p', '.notariummeta'), 'utf8'))?.id).toBe(rec.id) // marker healed
    },
  )
})

describe('ensureFolderIdentity (#212 — the shared lazy-mint path)', () => {
  const deps = () => {
    const projects = new InMemoryProjects()
    const folders = new InMemoryFolders(projects)
    const markerStore = capableMarkerStore(() => dir)
    return { projects, folders, markerStore, now }
  }

  itAnchoredMarkerWrite(
    'mints a fresh type=folder identity for an unidentified folder + writes the marker',
    async () => {
      const d = deps()
      mkdirSync(join(dir, 'docs'))
      const id = await ensureFolderIdentity(d, { space: 's', folderPath: 'docs' })
      expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/)
      expect(await d.folders.byPath('s', 'docs')).toMatchObject({ id, path: 'docs' })
      const onDisk = parseMarker(readFileSync(join(dir, 'docs', '.notariummeta'), 'utf8'))
      expect(onDisk).toMatchObject({ id, type: 'folder' })
    },
  )

  itAnchoredMarkerWrite(
    'mints NOTHING for a folder that does not exist yet — the marker cannot create one',
    async () => {
      const d = deps()

      // The reason a page move mints its destination's id from the move's `finalize`
      // rather than its `prepare`: a marker is metadata ABOUT a folder and never
      // provisions one, so before the mutation lands there may be no folder to mark.
      await expect(
        ensureFolderIdentity(d, { space: 's', folderPath: 'not-yet' }),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await d.folders.byPath('s', 'not-yet')).toBeNull()
    },
  )

  itAnchoredMarkerWrite(
    'is idempotent + returns a PROJECT id unchanged when the folder is already a project',
    async () => {
      const d = deps()
      mkdirSync(join(dir, 'docs'))
      const proj = await markFolderAsProject(d, {
        space: 's',
        folderPath: 'docs',
        displayName: 'Docs',
      })
      const id = await ensureFolderIdentity(d, { space: 's', folderPath: 'docs' })
      expect(id).toBe(proj.id) // a project IS an identified folder — its id is the folder id
      expect(await d.folders.byPath('s', 'docs')).toBeNull() // no second (folder-type) row minted
      // Idempotent for a plain folder too.
      mkdirSync(join(dir, 'guides'))
      const a = await ensureFolderIdentity(d, { space: 's', folderPath: 'guides' })
      const b = await ensureFolderIdentity(d, { space: 's', folderPath: 'guides' })
      expect(a).toBe(b)
    },
  )

  itAnchoredMarkerWrite(
    'does not recreate a missing folder while preparing its identity',
    async () => {
      const d = deps()

      await expect(
        ensureFolderIdentity(d, { space: 's', folderPath: 'missing' }),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await d.markerStore.folderExists('s', 'missing')).toBe(false)
      expect(await d.folders.byPath('s', 'missing')).toBeNull()
    },
  )

  itAnchoredMarkerWrite(
    'reuses a FREE folder marker id (a clone whose registry row was lost)',
    async () => {
      const d = deps()
      writeMarkerFile('docs', { id: VALID_ID, type: 'folder', pathAliases: ['old'] })
      const id = await ensureFolderIdentity(d, { space: 's', folderPath: 'docs' })
      expect(id).toBe(VALID_ID) // adopted, not re-minted
      expect(await d.folders.byPath('s', 'docs')).toMatchObject({
        id: VALID_ID,
        pathAliases: ['old'],
      })
    },
  )

  it('REGRESSION (#212 P2): NEVER clobbers a PROJECT marker whose registry row is missing', async () => {
    const d = deps()
    // A project marker on disk (fresh clone / lost row) — no registry row yet.
    writeMarkerFile('docs', {
      id: VALID_ID,
      slug: 'billing',
      displayName: 'Billing',
      status: 'active',
    })
    const id = await ensureFolderIdentity(d, { space: 's', folderPath: 'docs' })
    expect(id).toBe(VALID_ID) // the project id IS the folder id
    // The marker is UNTOUCHED — boot reconcile still rebuilds the project from it.
    const onDisk = parseMarker(readFileSync(join(dir, 'docs', '.notariummeta'), 'utf8'))
    expect(onDisk).toMatchObject({ id: VALID_ID, slug: 'billing', displayName: 'Billing' })
    expect(onDisk?.type).toBeUndefined() // still a project marker, NOT downgraded to folder
    expect(await d.folders.byPath('s', 'docs')).toBeNull() // no folder-type row written
  })

  itAnchoredMarkerWrite(
    'preserves a co-located SPACE facet (#100 phase 4) when it does write a folder marker',
    async () => {
      const d = deps()
      // A space root whose root project was unmarked: the marker carries ONLY the space
      // facet (no folder/project id). Creating a page there must keep the space identity.
      writeMarkerFile('', { space: { id: 'SpAcE1234567', slug: 's' } })
      const id = await ensureFolderIdentity(d, { space: 's', folderPath: '' })
      expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/)
      const onDisk = parseMarker(readFileSync(join(dir, '.notariummeta'), 'utf8'))
      expect(onDisk).toMatchObject({ id, type: 'folder', space: { id: 'SpAcE1234567', slug: 's' } })
    },
  )

  itAnchoredMarkerWrite(
    'a COPIED project folder (marker id OWNED by a live project elsewhere) gets a FRESH id (Fork-B)',
    async () => {
      const d = deps()
      mkdirSync(join(dir, 'a'))
      const orig = await markFolderAsProject(d, {
        space: 's',
        folderPath: 'a',
        displayName: 'Proj',
      })
      // `cp -r a b`: the copy carries the original's project marker verbatim (its id is LIVE).
      writeMarkerFile('b', { id: orig.id, slug: orig.slug, displayName: 'Proj' })
      const id = await ensureFolderIdentity(d, { space: 's', folderPath: 'b' })
      expect(id).not.toBe(orig.id) // never hand out — or resolve a page onto — the original's id
      expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/)
      expect(await d.projects.getById(orig.id)).toMatchObject({ path: 'a' }) // original untouched
      expect(await d.folders.byPath('s', 'b')).toMatchObject({ id }) // the copy re-identified as a plain folder
    },
  )
})

describeAnchoredMarkerWrite('unmarkProject (#13)', () => {
  it('removes the marker file + the registry row; re-mark mints a fresh id', async () => {
    const projects = new InMemoryProjects()
    const markerStore = capableMarkerStore(() => dir)
    mkdirSync(join(dir, 'docs'))
    const rec = await markFolderAsProject(
      { projects, markerStore, now },
      { space: 's', folderPath: 'docs', displayName: 'Docs' },
    )
    const ok = await unmarkProject({ projects, markerStore, now }, { space: 's', id: rec.id })
    expect(ok).toBe(true)
    expect(await projects.getById(rec.id)).toBeNull()
    expect(await markerStore.read('s', 'docs')).toBeNull() // marker file gone
    // A fresh mark of the same folder gets a NEW id (the old identity was dropped).
    const again = await markFolderAsProject(
      { projects, markerStore, now },
      { space: 's', folderPath: 'docs', displayName: 'Docs' },
    )
    expect(again.id).not.toBe(rec.id)
  })

  it('is anti-enumeration: an id in another space (or unknown) is not unmarked', async () => {
    const projects = new InMemoryProjects()
    const markerStore = capableMarkerStore(() => dir)
    mkdirSync(join(dir, 'docs'))
    const rec = await markFolderAsProject(
      { projects, markerStore, now },
      { space: 's', folderPath: 'docs' },
    )
    expect(
      await unmarkProject({ projects, markerStore, now }, { space: 'other', id: rec.id }),
    ).toBe(false)
    expect(await unmarkProject({ projects, markerStore, now }, { space: 's', id: 'nope' })).toBe(
      false,
    )
    expect(await projects.getById(rec.id)).toBeTruthy() // untouched
  })
})

describeAnchoredMarkerWrite('space facet preservation (#100 phase 4 — closeout seam)', () => {
  // The space-ROOT `.notariummeta` carries BOTH the root project identity AND the
  // space-identity facet (#100 phase 4). A project-side write/unmark of the root must
  // NEVER strip the space facet (the marker.ts invariant) — else the on-disk space
  // identity (Fork A, re-clone durability) is lost until the next boot heal. This
  // is the seam between the phase 2/phase 3 project writers and the phase 4 facet, uncovered until
  // #100 closed out.
  const SPACE_ID = 'Sp4ceX9_qZ2m' // 12 chars, freshNoteId shape

  const seedSpaceFacet = async (
    markerStore: MarkerStore,
    facet: { id: string; slug: string; aliases?: string[] },
  ) => {
    const existing = parseMarker((await markerStore.read('s', '')) ?? '') ?? {}
    await markerStore.write('s', '', serializeMarker({ ...existing, space: facet }))
  }

  it('unmark of the ROOT project keeps the space facet (strips only project fields)', async () => {
    const projects = new InMemoryProjects()
    const markerStore = capableMarkerStore(() => dir)
    const root = await markFolderAsProject(
      { projects, markerStore, now },
      { space: 's', folderPath: '', displayName: 'My Space' },
    )
    await seedSpaceFacet(markerStore, { id: SPACE_ID, slug: 'my-space', aliases: ['old-space'] })
    expect(await unmarkProject({ projects, markerStore, now }, { space: 's', id: root.id })).toBe(
      true,
    )
    const after = parseMarker((await markerStore.read('s', '')) ?? '')
    expect(after?.space).toEqual({ id: SPACE_ID, slug: 'my-space', aliases: ['old-space'] })
    expect(after?.id).toBeUndefined() // project identity gone…
    expect(after?.slug).toBeUndefined() // …but the marker SURVIVES carrying the space facet
  })

  it('re-mark / displayName-rename of the ROOT project keeps the space facet', async () => {
    const projects = new InMemoryProjects()
    const markerStore = capableMarkerStore(() => dir)
    const root = await markFolderAsProject(
      { projects, markerStore, now },
      { space: 's', folderPath: '', displayName: 'My Space' },
    )
    await seedSpaceFacet(markerStore, { id: SPACE_ID, slug: 'my-space' })
    // A re-mark (POST /projects on the root — e.g. a displayName tweak).
    await markFolderAsProject(
      { projects, markerStore, now },
      { space: 's', folderPath: '', displayName: 'Renamed' },
    )
    let m = parseMarker((await markerStore.read('s', '')) ?? '')
    expect(m?.space).toEqual({ id: SPACE_ID, slug: 'my-space' })
    expect(m?.displayName).toBe('Renamed') // project facet still updated
    // A displayName-only rename (PATCH /projects/:id on the root — a slug rename is 400).
    await renameProjectSlug(
      { projects, markerStore, now },
      { space: 's', id: root.id, displayName: 'Again' },
    )
    m = parseMarker((await markerStore.read('s', '')) ?? '')
    expect(m?.space).toEqual({ id: SPACE_ID, slug: 'my-space' })
    expect(m?.displayName).toBe('Again')
  })

  it('a NON-root unmark still removes the whole marker (no space facet to preserve)', async () => {
    const projects = new InMemoryProjects()
    const markerStore = capableMarkerStore(() => dir)
    mkdirSync(join(dir, 'docs'))
    const rec = await markFolderAsProject(
      { projects, markerStore, now },
      { space: 's', folderPath: 'docs', displayName: 'Docs' },
    )
    expect(await unmarkProject({ projects, markerStore, now }, { space: 's', id: rec.id })).toBe(
      true,
    )
    expect(await markerStore.read('s', 'docs')).toBeNull()
  })
})

describe('renameProjectSlug (#100 phase 2)', () => {
  itAnchoredMarkerWrite(
    'renames the slug → old slug joins aliases (registry + on-disk marker), id/path stable',
    async () => {
      const projects = new InMemoryProjects()
      const markerStore = capableMarkerStore(() => dir)
      mkdirSync(join(dir, 'docs'))
      const rec = await markFolderAsProject(
        { projects, markerStore, now },
        { space: 's', folderPath: 'docs', displayName: 'Docs' },
      )
      const res = await renameProjectSlug(
        { projects, markerStore, now },
        { space: 's', id: rec.id, slug: 'guides' },
      )
      expect(res.ok).toBe(true)
      const row = (await projects.getById(rec.id))!
      expect(row).toMatchObject({ id: rec.id, path: 'docs', slug: 'guides', aliases: ['docs'] })
      // Truth travels: the on-disk marker carries the new slug + the alias history.
      expect(parseMarker((await markerStore.read('s', 'docs')) ?? '')).toMatchObject({
        slug: 'guides',
        aliases: ['docs'],
      })
      // Resolution layer: the old current-slug handle is now free of a CURRENT holder.
      expect(await projects.getByHandle('s', 'guides')).toMatchObject({ id: rec.id })
      expect(await projects.getByHandle('s', 'docs')).toBeNull() // 'docs' is an alias, not current
    },
  )

  // The HANDLE axis stays ASCII while note names went Unicode (#296): a handle is a URL
  // segment under SpaceSlugSchema, and it is minted through the same `asciiSlug` that
  // resolution uses — mint and lookup have to agree, or a project becomes unreachable by
  // the very handle the registry gave it.
  it('keeps a project handle in the ASCII alphabet, whatever the folder is called', async () => {
    const projects = new InMemoryProjects()
    const rec = await markFolderAsProject(
      { projects, now },
      { space: 's', folderPath: '第三季度', displayName: '第三季度规划' },
    )
    expect(rec.slug).toMatch(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/)
    expect(await projects.getByHandle('s', rec.slug)).toMatchObject({ id: rec.id })

    // A second one cannot take the same handle silently.
    const other = await markFolderAsProject(
      { projects, now },
      { space: 's', folderPath: '会議', displayName: '会議の議事録' },
    )
    expect(other.slug).not.toBe(rec.slug)
    expect(await projects.getByHandle('s', other.slug)).toMatchObject({ id: other.id })
  })

  it('refuses to rename a handle onto a non-ASCII slug', async () => {
    const projects = new InMemoryProjects()
    const rec = await markFolderAsProject(
      { projects, now },
      { space: 's', folderPath: 'docs', displayName: 'Docs' },
    )
    const res = await renameProjectSlug(
      { projects, now },
      { space: 's', id: rec.id, slug: '第三季度' },
    )
    // Nothing sluggable in the ASCII alphabet → not a handle; the old one still holds.
    expect(res.ok).toBe(false)
    expect((await projects.getById(rec.id))!.slug).toBe('docs')
  })

  it('A→B→A never self-aliases the current name (idempotent — reuses the note alias algebra)', async () => {
    const projects = new InMemoryProjects()
    const rec = await markFolderAsProject(
      { projects, now },
      { space: 's', folderPath: 'docs', displayName: 'Docs' },
    )
    await renameProjectSlug({ projects, now }, { space: 's', id: rec.id, slug: 'guides' })
    await renameProjectSlug({ projects, now }, { space: 's', id: rec.id, slug: 'docs' })
    const row = (await projects.getById(rec.id))!
    expect(row.slug).toBe('docs')
    // 'docs' is current again → NOT in its own aliases (no self-shadowing). 'guides'
    // stays a valid past handle (it was real for a while — `team/guides` still
    // resolves), exactly the note A→B→A semantics (#100 phase 0).
    expect(row.aliases).not.toContain('docs')
    expect(row.aliases).toEqual(['guides'])
  })

  it('rejects a slug already held by another LIVE project (409 — explicit rename is not suffixed)', async () => {
    const projects = new InMemoryProjects()
    await markFolderAsProject(
      { projects, now },
      { space: 's', folderPath: 'docs', displayName: 'Docs' },
    )
    const b = await markFolderAsProject(
      { projects, now },
      { space: 's', folderPath: 'handbook', displayName: 'Handbook' },
    )
    const res = await renameProjectSlug({ projects, now }, { space: 's', id: b.id, slug: 'docs' })
    expect(res).toEqual({ ok: false, code: 'collision' })
    expect((await projects.getById(b.id))!.slug).toBe('handbook') // unchanged
  })

  it('rejects renaming the ROOT project’s slug (its handle is the space slug — #100 phase 4)', async () => {
    const projects = new InMemoryProjects()
    const root = await markFolderAsProject(
      { projects, now },
      { space: 's', folderPath: '', displayName: 'Root' },
    )
    expect(
      await renameProjectSlug({ projects, now }, { space: 's', id: root.id, slug: 'x' }),
    ).toEqual({
      ok: false,
      code: 'root',
    })
  })

  it('anti-enumeration: an id in another space (or unknown) is not_found', async () => {
    const projects = new InMemoryProjects()
    const rec = await markFolderAsProject({ projects, now }, { space: 's', folderPath: 'docs' })
    expect(
      await renameProjectSlug({ projects, now }, { space: 'other', id: rec.id, slug: 'x' }),
    ).toEqual({
      ok: false,
      code: 'not_found',
    })
    expect(
      await renameProjectSlug({ projects, now }, { space: 's', id: 'nope', slug: 'x' }),
    ).toEqual({
      ok: false,
      code: 'not_found',
    })
  })

  it('displayName-only update touches no slug/alias; an empty-after-slugify slug is invalid', async () => {
    const projects = new InMemoryProjects()
    const rec = await markFolderAsProject(
      { projects, now },
      { space: 's', folderPath: 'docs', displayName: 'Docs' },
    )
    const r1 = await renameProjectSlug(
      { projects, now },
      { space: 's', id: rec.id, displayName: 'Documentation' },
    )
    expect(r1.ok).toBe(true)
    expect(await projects.getById(rec.id)).toMatchObject({
      slug: 'docs',
      displayName: 'Documentation',
      aliases: [],
    })
    // A slug that slugifies to nothing (only punctuation) is rejected, not stored empty.
    expect(
      await renameProjectSlug({ projects, now }, { space: 's', id: rec.id, slug: '!!!' }),
    ).toEqual({
      ok: false,
      code: 'invalid',
    })
  })
})

describe('scanProjectsAtBoot (#13)', () => {
  it('rebuilds the registry from on-disk markers (durability: lost table / fresh clone)', async () => {
    writeMarkerFile('', { id: 'RootRootRoot', slug: 'root', displayName: 'Root' })
    writeMarkerFile('billing', { id: VALID_ID, slug: 'billing', displayName: 'Billing' })
    const projects = new InMemoryProjects()
    const markerStore = capableMarkerStore(() => dir)
    await scanProjectsAtBoot({ projects, markerStore, now }, ['s'])
    const rows = await projects.listForSpace('s')
    expect(rows.map((r) => `${r.path}:${r.slug}:${r.id}`).sort()).toEqual([
      ':root:RootRootRoot',
      'billing:billing:Ab3xK9_qZ2mN',
    ])
  })

  it('is idempotent across re-runs (preserves createdAt, no churn)', async () => {
    writeMarkerFile('billing', { id: VALID_ID, slug: 'billing' })
    const projects = new InMemoryProjects()
    const markerStore = capableMarkerStore(() => dir)
    await scanProjectsAtBoot({ projects, markerStore, now }, ['s'])
    const firstSeen = (await projects.getById(VALID_ID))!.createdAt
    await scanProjectsAtBoot(
      { projects, markerStore, now: () => new Date('2027-01-01T00:00:00.000Z') },
      ['s'],
    )
    expect((await projects.getById(VALID_ID))!.createdAt).toBe(firstSeen)
    expect((await projects.listForSpace('s')).length).toBe(1)
  })

  it('scans a personal domain like any other space (#13: personal holds projects too)', async () => {
    // Reversal of the old «personal never gets a row» invariant — boot-scan is now
    // space-agnostic, so a marker in the personal domain rebuilds its row normally.
    writeMarkerFile('', { id: VALID_ID, slug: 'root' })
    const projects = new InMemoryProjects()
    const markerStore = capableMarkerStore(() => dir)
    await scanProjectsAtBoot({ projects, markerStore, now }, ['alice-personal'])
    expect(
      (await projects.listForSpace('alice-personal')).map((r) => `${r.path}:${r.slug}`),
    ).toEqual([':root'])
  })

  it('ignores broken markers (fail-closed)', async () => {
    mkdirSync(join(dir, 'bad'), { recursive: true })
    writeFileSync(join(dir, 'bad', '.notariummeta'), '{not json')
    const projects = new InMemoryProjects()
    const markerStore = capableMarkerStore(() => dir)
    await scanProjectsAtBoot({ projects, markerStore, now }, ['s'])
    expect((await projects.listForSpace('s')).length).toBe(0)
  })

  it('collapses a copied folder (same id at two paths) to ONE row — first path wins, deterministically', async () => {
    writeMarkerFile('a', { id: VALID_ID, slug: 'proj' })
    writeMarkerFile('b', { id: VALID_ID, slug: 'proj' }) // a copy carrying the same id
    const projects = new InMemoryProjects()
    const markerStore = capableMarkerStore(() => dir)
    await scanProjectsAtBoot({ projects, markerStore, now }, ['s'])
    const rows = await projects.listForSpace('s')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: VALID_ID, path: 'a' }) // sorted: 'a' before 'b'
  })

  it('suffixes colliding DERIVED slugs at boot (two folders → one slug must not crash the upsert)', async () => {
    writeMarkerFile('a', { id: 'AAAAAAAAAAAA', displayName: 'Docs' }) // no slug → derive
    writeMarkerFile('b', { id: 'BBBBBBBBBBBB', displayName: 'Docs' })
    const projects = new InMemoryProjects()
    const markerStore = capableMarkerStore(() => dir)
    await scanProjectsAtBoot({ projects, markerStore, now }, ['s'])
    const bySlug = (await projects.listForSpace('s')).map((r) => `${r.path}:${r.slug}`).sort()
    expect(bySlug).toEqual(['a:docs', 'b:docs-2']) // deterministic (scan sorted by path)
  })

  it('rebuilds from markers on a host that cannot WRITE them (read path is portable)', async () => {
    writeMarkerFile('billing', { id: VALID_ID, slug: 'billing', displayName: 'Billing' })
    const projects = new InMemoryProjects()
    const markerStore = capableMarkerStore(() => dir, { anchoredWritesAvailable: false })

    expect(markerStore.available('s')).toBe(false)
    await scanProjectsAtBoot({ projects, markerStore, now }, ['s'])
    // Write availability gates MUTATIONS. Reconcile is a read, and a row it can
    // restore must not be forfeited because this host cannot publish a marker.
    expect((await projects.listForSpace('s')).map((r) => `${r.path}:${r.slug}`)).toEqual([
      'billing:billing',
    ])
  })

  it('still refuses to prune on an incomplete scan when writes are unavailable', async () => {
    const projects = new InMemoryProjects()
    await projects.upsert({
      id: VALID_ID,
      space: 's',
      path: 'gone',
      slug: 'gone',
      aliases: [],
      pathAliases: [],
      displayName: 'Gone',
      status: 'active',
      lastSeen: now().toISOString(),
      createdAt: now().toISOString(),
    })
    // No notes dir ⇒ scan is an empty LOWER BOUND, not "every marker is gone".
    const markerStore = capableMarkerStore(() => null, { anchoredWritesAvailable: false })

    await scanProjectsAtBoot({ projects, markerStore, now }, ['s'])
    expect((await projects.listForSpace('s')).map((r) => r.id)).toEqual([VALID_ID])
  })

  it('one space failing does not abort the rest (per-space resilience)', async () => {
    writeMarkerFile('ok', { id: VALID_ID, slug: 'ok' })
    const projects = new InMemoryProjects()
    const real = capableMarkerStore(() => dir)
    // The marker scan throws for the FIRST space — the second must still rebuild
    // (the per-space try/catch isolates the failure).
    let calls = 0
    const flaky: MarkerStore = {
      ...real,
      scan: async (space) => {
        calls++
        if (calls === 1) {
          throw new Error('marker scan failed at boot')
        }

        return real.scan(space)
      },
    }
    await scanProjectsAtBoot({ projects, markerStore: flaky, now }, ['boom', 's'])
    expect((await projects.getByHandle('s', 'ok'))?.path).toBe('ok') // 's' rebuilt despite 'boom' failing
  })
})

describe('reconcile — external changes survive a rescan (#13 I3)', () => {
  itAnchoredMarkerWrite(
    're-adopts an externally-moved folder: the marker at the new path updates the row by id',
    async () => {
      // Mark 'old', then simulate `mv old new` outside us (the marker travels).
      const projects = new InMemoryProjects()
      const markerStore = capableMarkerStore(() => dir)
      mkdirSync(join(dir, 'old'))
      const rec = await markFolderAsProject(
        { projects, markerStore, now },
        { space: 's', folderPath: 'old', displayName: 'P' },
      )
      rmSync(join(dir, 'old'), { recursive: true, force: true })
      writeMarkerFile('new', { id: rec.id, slug: rec.slug, displayName: 'P' })
      await scanProjectsAtBoot({ projects, markerStore, now }, ['s'])
      const rows = await projects.listForSpace('s')
      expect(rows).toHaveLength(1) // ONE row, re-adopted (not a stale + a new one)
      expect(rows[0]).toMatchObject({ id: rec.id, slug: rec.slug, path: 'new' }) // id+slug stable, path moved
    },
  )

  it('adopts the marker’s aliases on a cold rebuild (#100 phase 2 re-clone durability)', async () => {
    // A repo cloned with a committed marker that already carries past slugs (the
    // project was renamed before): a fresh meta-DB must reconstruct the alias
    // history from the marker, so old `space/<old-slug>` handles keep resolving.
    writeMarkerFile('guides', {
      id: VALID_ID,
      slug: 'guides',
      aliases: ['docs', 'handbook'],
      displayName: 'Guides',
    })
    const projects = new InMemoryProjects()
    const markerStore = capableMarkerStore(() => dir)
    await scanProjectsAtBoot({ projects, markerStore, now }, ['s'])
    expect(await projects.getById(VALID_ID)).toMatchObject({
      slug: 'guides',
      aliases: ['docs', 'handbook'],
    })
  })

  itAnchoredMarkerWrite(
    'heals an external marker slug-edit: the marker slug wins, the displaced registry slug → alias (#100 phase 2)',
    async () => {
      // Slug is mutable now (phase 2), so the marker is its truth. Someone hand-edits the
      // marker slug (git) WITHOUT recording the old one in aliases → boot adopts the
      // new slug AND folds the displaced registry slug into the history, so the old
      // `space/docs` handle is not silently lost.
      const projects = new InMemoryProjects()
      const markerStore = capableMarkerStore(() => dir)
      mkdirSync(join(dir, 'p'))
      const rec = await markFolderAsProject(
        { projects, markerStore, now },
        { space: 's', folderPath: 'p', displayName: 'Docs' },
      )
      expect(rec.slug).toBe('docs')
      writeMarkerFile('p', { id: rec.id, slug: 'guides', displayName: 'Docs' }) // external slug edit, no alias
      await scanProjectsAtBoot({ projects, markerStore, now }, ['s'])
      expect(await projects.getById(rec.id)).toMatchObject({ slug: 'guides', aliases: ['docs'] })
    },
  )

  itAnchoredMarkerWrite(
    'prunes a row whose marker vanished externally (folder/marker deleted off our routes)',
    async () => {
      const projects = new InMemoryProjects()
      const markerStore = capableMarkerStore(() => dir)
      mkdirSync(join(dir, 'gone'))
      mkdirSync(join(dir, 'stays'))
      await markFolderAsProject(
        { projects, markerStore, now },
        { space: 's', folderPath: 'gone', displayName: 'Gone' },
      )
      await markFolderAsProject(
        { projects, markerStore, now },
        { space: 's', folderPath: 'stays', displayName: 'Stays' },
      )
      expect((await projects.listForSpace('s')).length).toBe(2)
      rmSync(join(dir, 'gone'), { recursive: true, force: true }) // external delete
      await scanProjectsAtBoot({ projects, markerStore, now }, ['s'])
      const rows = await projects.listForSpace('s')
      expect(rows.map((r) => r.path)).toEqual(['stays']) // 'gone' pruned, 'stays' kept
    },
  )

  it('does NOT prune on an INCOMPLETE scan (a transient read error must not nuke live rows)', async () => {
    // A row exists, but the scan reports complete:false (e.g. a dir was unreadable)
    // — pruning on a lower-bound hit set would wrongly delete a live project.
    const projects = new InMemoryProjects()
    await projects.upsert({
      id: VALID_ID,
      space: 's',
      path: 'live',
      slug: 'live',
      aliases: [],
      pathAliases: [],
      displayName: 'Live',
      status: 'active',
      lastSeen: now().toISOString(),
      createdAt: now().toISOString(),
    })
    const stub = stubMarkerStore({ hits: [], complete: false })
    await scanProjectsAtBoot({ projects, markerStore: stub, now }, ['s'])
    expect((await projects.getById(VALID_ID))?.path).toBe('live') // survived the partial scan
  })

  it('DOES prune on a COMPLETE empty scan (every marker was genuinely removed)', async () => {
    const projects = new InMemoryProjects()
    await projects.upsert({
      id: VALID_ID,
      space: 's',
      path: 'gone',
      slug: 'gone',
      aliases: [],
      pathAliases: [],
      displayName: 'Gone',
      status: 'active',
      lastSeen: now().toISOString(),
      createdAt: now().toISOString(),
    })
    const stub = stubMarkerStore({ hits: [], complete: true })
    await scanProjectsAtBoot({ projects, markerStore: stub, now }, ['s'])
    expect(await projects.getById(VALID_ID)).toBeNull() // complete scan, no marker → pruned
  })

  itAnchoredMarkerWrite(
    'does NOT prune a row whose marker became CORRUPT (readable but unparseable ≠ absent)',
    async () => {
      const projects = new InMemoryProjects()
      const markerStore = capableMarkerStore(() => dir)
      mkdirSync(join(dir, 'p'))
      const rec = await markFolderAsProject(
        { projects, markerStore, now },
        { space: 's', folderPath: 'p', displayName: 'P' },
      )
      // An external edit corrupts the marker (a stray byte / git conflict marker).
      writeFileSync(join(dir, 'p', '.notariummeta'), '{ broken <<<<<<< json')
      await scanProjectsAtBoot({ projects, markerStore, now }, ['s'])
      expect(await projects.getById(rec.id)).toBeTruthy() // a parse failure suppresses prune — the project survives
    },
  )

  itAnchoredMarkerWrite(
    'a marker whose id is OWNED BY ANOTHER SPACE is a cross-space copy — the row never migrates (#16)',
    async () => {
      const projects = new InMemoryProjects()
      const markerStore = capableMarkerStore((space) => join(dir, space)) // per-space subtrees
      mkdirSync(join(dir, 'A', 'proj'), { recursive: true })
      // Space A owns the project; space B's tree holds a COPY carrying A's id (a backup
      // restored into the wrong space, or a cross-space `cp -r`).
      const recA = await markFolderAsProject(
        { projects, markerStore, now },
        { space: 'A', folderPath: 'proj', displayName: 'P' },
      )
      mkdirSync(join(dir, 'B', 'copy'), { recursive: true })
      writeFileSync(
        join(dir, 'B', 'copy', '.notariummeta'),
        serializeMarker({ id: recA.id, slug: recA.slug, displayName: 'P' }),
      )
      // Both scan orders must converge to the same answer (A keeps the row, B gets none).
      for (const order of [
        ['A', 'B'],
        ['B', 'A'],
      ] as const) {
        await scanProjectsAtBoot({ projects, markerStore, now }, order)
        expect(await projects.getById(recA.id)).toMatchObject({ space: 'A', path: 'proj' }) // never crosses to B
        expect((await projects.listForSpace('B')).length).toBe(0) // copy is row-less, no migration
      }
    },
  )
})

describe('recordFolderRename + folder boot reconcile (#100 phase 3)', () => {
  const make = () => {
    const projects = new InMemoryProjects()
    const folders = new InMemoryFolders(projects)
    return { projects, folders }
  }

  // Mirror the /move-folder handler: re-prefix the rows (table-wide), THEN record.
  const move = async (
    deps: ReturnType<typeof make>,
    space: string,
    oldPath: string,
    newPath: string,
  ) => {
    await deps.projects.renamePrefix(space, oldPath, newPath)
    await recordFolderRename({ ...deps, now }, { space, oldPath, newPath })
  }

  it('does not run dependent path-history after a best-effort re-prefix failure', async () => {
    const deps = make()
    await ensureFolderIdentity({ ...deps, now }, { space: 's', folderPath: 'docs' })
    const original = await deps.folders.byPath('s', 'docs')
    const failure = new Error('registry unavailable')
    vi.spyOn(deps.projects, 'renamePrefix').mockRejectedValueOnce(failure)
    const onError = vi.fn()

    await finalizeFolderMove(
      { ...deps, now, onError },
      { space: 's', oldPath: 'docs', newPath: 'guides' },
    )

    expect(onError).toHaveBeenCalledWith('renamePrefix', failure)
    expect(await deps.folders.byPath('s', 'docs')).toEqual(original)
    expect(await deps.folders.byPath('s', 'guides')).toBeNull()
  })

  it('lazily mints a folder identity on first rename, recording the old path', async () => {
    const deps = make()
    await move(deps, 's', 'docs', 'guides')
    const rows = await deps.folders.listForSpace('s')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ space: 's', path: 'guides', pathAliases: ['docs'] })
    expect(rows[0].id).toMatch(/^[A-Za-z0-9_-]{12}$/) // a real freshNoteId
  })

  it('accumulates past paths across chained renames; A→B→A leaves no self-alias', async () => {
    const deps = make()
    await move(deps, 's', 'a', 'b')
    await move(deps, 's', 'b', 'c')
    let row = (await deps.folders.listForSpace('s'))[0]
    expect(row.path).toBe('c')
    expect(row.pathAliases).toEqual(['a', 'b'])
    // c → a (back to the first path): 'a' drops out of the history (idempotent).
    await move(deps, 's', 'c', 'a')
    row = (await deps.folders.listForSpace('s'))[0]
    expect(row.path).toBe('a')
    expect(row.pathAliases).toEqual(['b', 'c'])
  })

  it('a moved PROJECT folder grows its path-history without minting a separate identity', async () => {
    const deps = make()
    await deps.projects.upsert({
      id: VALID_ID,
      space: 's',
      path: 'work',
      slug: 'work',
      aliases: [],
      pathAliases: [],
      displayName: 'Work',
      status: 'active',
      lastSeen: now().toISOString(),
      createdAt: now().toISOString(),
    })
    await move(deps, 's', 'work', 'projects/work')
    expect(await deps.projects.getById(VALID_ID)).toMatchObject({
      path: 'projects/work',
      slug: 'work',
      pathAliases: ['work'], // handle untouched, path-history grew
    })
    expect(await deps.folders.listForSpace('s')).toHaveLength(0) // no parallel folder row
  })

  it('a root move (→ space rename, #100 phase 4) and an unchanged path are no-ops', async () => {
    const deps = make()
    await recordFolderRename({ ...deps, now }, { space: 's', oldPath: '', newPath: 'x' })
    await recordFolderRename({ ...deps, now }, { space: 's', oldPath: 'x', newPath: 'x' })
    expect(await deps.folders.listForSpace('s')).toHaveLength(0)
  })

  it('boot reconciles a type:"folder" marker as a folder identity, NOT a project', async () => {
    writeMarkerFile('archive', {
      id: VALID_ID,
      type: 'folder',
      pathAliases: ['old-notes', 'foo:bar'],
    })
    const { projects, folders } = make()
    const markerStore = capableMarkerStore(() => dir)
    await scanProjectsAtBoot({ projects, folders, markerStore, now }, ['s'])
    expect(await folders.listForSpace('s')).toEqual([
      expect.objectContaining({
        id: VALID_ID,
        path: 'archive',
        pathAliases: ['old-notes', 'foo:bar'],
      }),
    ])
    expect(await projects.listForSpace('s')).toHaveLength(0) // the handle layer ignores it
  })

  it('boot heals a folder path displaced by an external move into the alias history', async () => {
    const { projects, folders } = make()
    await folders.upsert({
      id: VALID_ID,
      space: 's',
      path: 'a',
      pathAliases: [],
      lastSeen: now().toISOString(),
      createdAt: now().toISOString(),
    })
    writeMarkerFile('b', { id: VALID_ID, type: 'folder' }) // marker now sits at 'b'
    const markerStore = capableMarkerStore(() => dir)
    await scanProjectsAtBoot({ projects, folders, markerStore, now }, ['s'])
    const row = (await folders.listForSpace('s'))[0]
    expect(row.path).toBe('b')
    expect(row.pathAliases).toEqual(['a']) // [[a/note]] keeps resolving
  })

  itAnchoredMarkerWrite(
    'boot recovers a crash after physical rename but before move finalization',
    async () => {
      const { projects, folders } = make()
      const markerStore = capableMarkerStore(() => dir)
      mkdirSync(join(dir, 'before'), { recursive: true })
      const id = await ensureFolderIdentity(
        { projects, folders, markerStore, now },
        { space: 's', folderPath: 'before' },
      )

      // prepare() completed, the marker travelled with the atomic directory rename,
      // then the process died before finalizeFolderMove could update derived rows.
      renameSync(join(dir, 'before'), join(dir, 'after'))
      await scanProjectsAtBoot({ projects, folders, markerStore, now }, ['s'])

      expect(await folders.getById(id)).toMatchObject({
        path: 'after',
        pathAliases: ['before'],
      })
      expect(parseMarker(readFileSync(join(dir, 'after', '.notariummeta'), 'utf8'))).toMatchObject({
        id,
        type: 'folder',
      })
    },
  )

  // Marking a folder that ALREADY has a folder-identity must ADOPT
  // its id (flip type in place), not mint a second row colliding on UNIQUE(space,path).
  it('mark-as-project ADOPTS an existing folder-identity at the path (no double row / no 500)', async () => {
    const deps = make()
    await move(deps, 's', 'docs', 'guides') // lazily mints a folder-identity at 'guides'
    const folderRow = (await deps.folders.listForSpace('s'))[0]
    const proj = await markFolderAsProject(
      { ...deps, now },
      { space: 's', folderPath: 'guides', displayName: 'Guides' },
    )
    expect(proj.id).toBe(folderRow.id) // adopted the folder id, not a fresh mint
    expect(proj.pathAliases).toEqual(['docs']) // path-history carried onto the project
    expect(await deps.folders.listForSpace('s')).toHaveLength(0) // folder row flipped to project
    expect((await deps.projects.listForSpace('s')).find((r) => r.path === 'guides')?.id).toBe(
      folderRow.id,
    )
  })

  // A rename before the registry was rebuilt must REUSE the on-disk
  // folder marker's id + history, not orphan the established identity.
  itAnchoredMarkerWrite(
    'recordFolderRename REUSES an on-disk folder marker when the registry row is lost (durability)',
    async () => {
      const { projects, folders } = make()
      const markerStore = capableMarkerStore(() => dir)
      // The marker traveled to the post-move path 'c' (fs.rename), but the registry row
      // is gone (fresh clone / lost table / boot-scan not yet run for this space).
      writeMarkerFile('c', { id: VALID_ID, type: 'folder', pathAliases: ['a'] })
      await recordFolderRename(
        { projects, folders, markerStore, now },
        { space: 's', oldPath: 'b', newPath: 'c' },
      )
      const row = (await folders.listForSpace('s'))[0]
      expect(row.id).toBe(VALID_ID) // reused the established id, not a fresh mint
      expect(row.pathAliases).toEqual(['a', 'b']) // marker history ∪ this move's old path
    },
  )

  it('recordFolderRename leaves a PROJECT marker untouched (boot reconcile owns it — no clobber)', async () => {
    const { projects, folders } = make()
    const markerStore = capableMarkerStore(() => dir)
    writeMarkerFile('c', { id: VALID_ID, slug: 'proj' }) // a project marker (no type), lost row
    await recordFolderRename(
      { projects, folders, markerStore, now },
      { space: 's', oldPath: 'b', newPath: 'c' },
    )
    expect(await folders.listForSpace('s')).toHaveLength(0) // no folder minted over it
    const raw = JSON.parse(readFileSync(join(dir, 'c', '.notariummeta'), 'utf8'))
    expect(raw).toMatchObject({ id: VALID_ID, slug: 'proj' }) // intact, not overwritten
    expect(raw.type).toBeUndefined()
  })
})

describe('InMemoryProjects.renamePrefix mirrors the SQL drivers (#13 I3 fake fidelity)', () => {
  const row = (id: string, space: string, path: string, slug: string): ProjectRecord => ({
    id,
    space,
    path,
    slug,
    aliases: [],
    pathAliases: [],
    displayName: slug,
    status: 'active',
    lastSeen: '2026-06-18T00:00:00Z',
    createdAt: '2026-06-18T00:00:00Z',
  })

  it('re-prefixes folder + descendants; segment-boundary, space-scoped, astral-safe', async () => {
    const p = new InMemoryProjects()
    await p.upsert(row('p1', 'team', 'docs', 'docs'))
    await p.upsert(row('p2', 'team', 'docs/sub', 'sub')) // descendant
    await p.upsert(row('p3', 'team', 'docsx', 'docsx')) // boundary trap
    await p.upsert(row('p4', 'ops', 'docs', 'opsdocs')) // other space
    await p.upsert(row('p5', 'team', '📁', 'emoji')) // astral folder name
    await p.upsert(row('p6', 'team', '📁/inner', 'emojisub')) // astral descendant
    await p.renamePrefix('team', 'docs', 'archive/docs')
    await p.renamePrefix('team', '📁', 'arch/📁')
    expect((await p.getById('p1'))?.path).toBe('archive/docs')
    expect((await p.getById('p2'))?.path).toBe('archive/docs/sub')
    expect((await p.getById('p3'))?.path).toBe('docsx') // `docs` never catches `docsx`
    expect((await p.getById('p4'))?.path).toBe('docs') // other space untouched
    expect((await p.getById('p5'))?.path).toBe('arch/📁')
    expect((await p.getById('p6'))?.path).toBe('arch/📁/inner') // descendant follows past the astral char
  })
})
