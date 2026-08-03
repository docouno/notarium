// dataPaths (#101): the ONE data root and everything derived from it.
//
// The invariant under test is the task's whole point — no internal, derived path
// is a REQUIRED env var, and no default is cwd-relative. The incident this closes:
// a deploy set meta/engine, missed JOBS_DATA_DIR, booted green, and every export
// died on `EACCES: mkdir '/app/.data'` (the cwd-relative default under the image's
// root-owned WORKDIR) — after the API had already answered 202.

import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  dataPathsFromEnv,
  describeDataPaths,
  ensureDataRoot,
  legacyMetaDbAt,
  metaDbUrlFromEnv,
} from '../../packages/server/src/apps/server/dataPaths'

const env = (o: Record<string, string | undefined>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv

const roots: string[] = []
const cwdAtStart = process.cwd()

const tmpRoot = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'notarium-datapaths-'))
  roots.push(dir)

  return dir
}

afterAll(async () => {
  // The legacy-guard tests chdir into a temp host to exercise the cwd-relative
  // candidates; restore before removing those dirs out from under the runner.
  process.chdir(cwdAtStart)
  // Restore traversal before removing: a test that proved a dir unwritable left it
  // 0o500, and rm cannot descend into what it cannot enter.
  for (const r of roots) {
    await chmod(r, 0o755).catch(() => {})
    await rm(r, { recursive: true, force: true }).catch(() => {})
  }
})

describe('dataPathsFromEnv (#101)', () => {
  it('derives every path from DATA_DIR — zero data env required', () => {
    const p = dataPathsFromEnv(env({ DATA_DIR: '/data' }))
    expect(p).toEqual({
      dataDir: '/data',
      metaDbUrl: 'sqlite:/data/meta.db',
      engineDataDir: '/data/engine',
      jobsDataDir: '/data/jobs',
      importStagingDir: '/data/jobs/imports',
      defaultSpacesRoot: '/data/spaces',
    })
  })

  it('defaults to an ABSOLUTE root when DATA_DIR is unset — never cwd-relative', () => {
    // The bug class itself: a relative default resolves under whatever cwd started
    // the process (in the image: root-owned /app → EACCES on first write). Asserting
    // the EXACT root, not just isAbsolute: the home wiring has to be discriminating,
    // or reading it from the process instead of this env would pass unnoticed.
    const p = dataPathsFromEnv(env({ HOME: '/home/u' }))
    expect(p.dataDir).toBe('/home/u/.local/share/notarium')

    for (const dir of [p.dataDir, p.engineDataDir, p.jobsDataDir, p.defaultSpacesRoot]) {
      expect(isAbsolute(dir)).toBe(true)
    }
    expect(p.dataDir).not.toMatch(/(^|\/)\.data(\/|$)/)
  })

  it('honours XDG_DATA_HOME, ignoring a relative one per the XDG spec', () => {
    expect(dataPathsFromEnv(env({ XDG_DATA_HOME: '/xdg' })).dataDir).toBe('/xdg/notarium')
    // Relative → invalid → fall back to the home-dir default, NOT to `./rel`.
    expect(dataPathsFromEnv(env({ XDG_DATA_HOME: 'rel' })).dataDir).not.toBe(
      join(process.cwd(), 'rel', 'notarium'),
    )
  })

  it('resolves a relative DATA_DIR to absolute rather than carrying it through', () => {
    expect(isAbsolute(dataPathsFromEnv(env({ DATA_DIR: './x' })).dataDir)).toBe(true)
  })

  // Class-A operator knobs: each override survives, none is required (the soft
  // classification — an override is a deliberate choice, the trap was the default).
  it('META_DB_URL overrides for external Postgres while the rest still derives', () => {
    const p = dataPathsFromEnv(env({ DATA_DIR: '/data', META_DB_URL: 'postgres://h/db' }))
    expect(p.metaDbUrl).toBe('postgres://h/db')
    expect(p.engineDataDir).toBe('/data/engine')
    expect(p.jobsDataDir).toBe('/data/jobs')
  })

  it('ENGINE_DATA_DIR / JOBS_DATA_DIR override independently of the root', () => {
    const p = dataPathsFromEnv(
      env({ DATA_DIR: '/data', ENGINE_DATA_DIR: '/fast/engine', JOBS_DATA_DIR: '/big/jobs' }),
    )
    expect(p.engineDataDir).toBe('/fast/engine')
    expect(p.jobsDataDir).toBe('/big/jobs')
    expect(p.metaDbUrl).toBe('sqlite:/data/meta.db')
  })

  it('treats a blank env var as unset (a compose `FOO=` must not blank the path)', () => {
    const p = dataPathsFromEnv(env({ DATA_DIR: '/data', ENGINE_DATA_DIR: '  ' }))
    expect(p.engineDataDir).toBe('/data/engine')
  })
})

describe('metaDbUrlFromEnv — canonical form at the env edge (#101)', () => {
  it('canonicalises a bare path to sqlite:<absolute>', () => {
    // The desync this closes: createMetaDb accepts a bare path as sqlite, so a
    // consumer testing only for the `sqlite:` prefix silently concluded "Postgres,
    // no local dir" and skipped creating + probing the meta-DB's directory.
    expect(metaDbUrlFromEnv('/state/meta.db', '/data')).toBe('sqlite:/state/meta.db')
  })

  it('makes a relative sqlite path absolute — cwd must not decide where data lives', () => {
    expect(metaDbUrlFromEnv('sqlite:rel/meta.db', '/data')).toBe(
      `sqlite:${join(process.cwd(), 'rel/meta.db')}`,
    )
  })

  it('passes Postgres through untouched and derives from the root when unset', () => {
    expect(metaDbUrlFromEnv('postgres://h/db', '/data')).toBe('postgres://h/db')
    expect(metaDbUrlFromEnv(undefined, '/data')).toBe('sqlite:/data/meta.db')
    expect(metaDbUrlFromEnv('   ', '/data')).toBe('sqlite:/data/meta.db')
  })

  it('never turns the :memory: sentinel into a path', () => {
    // resolve(':memory:') would yield <cwd>/:memory: — a real directory probed and
    // created in whatever cwd started the process.
    expect(metaDbUrlFromEnv('sqlite::memory:', '/data')).toBe('sqlite::memory:')
  })

  it('refuses a connection string wearing a path, and only then', () => {
    // The last shape of the original defect: `host=db password=…` taken as a path is a
    // directory NAMED AFTER THE CREDENTIAL, created on disk and printed by whatever
    // reports paths. Order matters — the check runs only on a value that classified as
    // a PATH, or it would reject the very Postgres URLs it is protecting.
    expect(metaDbUrlFromEnv('postgres://u:hunter2@h/db', '/data')).toBe('postgres://u:hunter2@h/db')
    expect(metaDbUrlFromEnv('postgresql://u:p@ss@h/db?sslmode=require', '/data')).toBe(
      'postgresql://u:p@ss@h/db?sslmode=require',
    )
    for (const raw of [
      'host=db user=u password=hunter2',
      '//u:hunter2@h/db',
      'postgres//u:pw@h/db',
    ]) {
      expect(() => metaDbUrlFromEnv(raw, '/data')).toThrow(/looks like a connection string/)
    }
    // And an ordinary root still resolves, at-signs and colons included.
    expect(metaDbUrlFromEnv('/home/ann@corp.example/meta.db', '/data')).toBe(
      'sqlite:/home/ann@corp.example/meta.db',
    )
  })

  it('stops a misspelt scheme HERE rather than booting on an empty database', () => {
    // The env edge is the one place a malformed META_DB_URL can still be refused. Let
    // it through and it becomes a filename: the host creates that file, starts green
    // on a database with zero users, and a password host re-opens the PUBLIC
    // first-run screen — the takeover legacyMetaDbAt guards, except that guard stands
    // down exactly when META_DB_URL is set. The password would also land in the
    // directory name and the boot banner.
    expect(() => metaDbUrlFromEnv('postgress://u:pw@h/db', '/data')).toThrow(
      /unsupported meta-DB URL scheme/,
    )
    expect(() => dataPathsFromEnv(env({ DATA_DIR: '/data', META_DB_URL: 'mysql://h/db' }))).toThrow(
      /unsupported meta-DB URL scheme/,
    )
  })
})

describe('legacyMetaDbAt — the un-migrated-host guard (#101)', () => {
  /** A pre-#101 BARE run's layout: `.data/meta.db` beside the process's cwd. */
  const bareLegacy = async (): Promise<{
    cwd: string
    paths: ReturnType<typeof dataPathsFromEnv>
  }> => {
    const cwd = await tmpRoot()
    await mkdir(join(cwd, '.data'), { recursive: true })
    await writeFile(join(cwd, '.data/meta.db'), 'legacy')
    process.chdir(cwd)

    return { cwd, paths: dataPathsFromEnv(env({ DATA_DIR: join(cwd, 'data') })) }
  }

  it('spots a pre-#101 meta-DB when the derived root is still empty', async () => {
    // The silent upgrade: the old location is no longer read, every probe passes on
    // the empty root, and a password host reopens the PUBLIC setup screen — first
    // visitor becomes owner while the real data sits untouched.
    const { cwd, paths } = await bareLegacy()
    expect(legacyMetaDbAt(env({ DATA_DIR: join(cwd, 'data') }), paths)).toBe(
      join(cwd, '.data/meta.db'),
    )
  })

  it('ignores a docker stand in the checkout — that layout is not this process (#101)', async () => {
    // `docker/volumes/notarium-state` is a container's bind SOURCE, never a path this
    // process read: a bare run's pre-#101 default was `.data/meta.db`. Treating it as
    // ours made `npm run server` refuse to start on every checkout that had ever run
    // `make dev`, and its advice — move the stand's DB into the host profile — deleted
    // the file `make migration-check` keys on, re-opening the setup screen it guards.
    const cwd = await tmpRoot()
    await mkdir(join(cwd, 'docker/volumes/notarium-state'), { recursive: true })
    await writeFile(join(cwd, 'docker/volumes/notarium-state/meta.db'), 'a stand, not ours')
    process.chdir(cwd)
    const e = env({ DATA_DIR: join(cwd, 'data') })
    expect(legacyMetaDbAt(e, dataPathsFromEnv(e))).toBeNull()
  })

  it('ignores it on the XDG default too — the shape a dev actually runs', async () => {
    // No DATA_DIR at all: `npm run dev` in a checkout, root = ~/.local/share/notarium.
    const cwd = await tmpRoot()
    await mkdir(join(cwd, 'docker/volumes/notarium-state'), { recursive: true })
    await writeFile(join(cwd, 'docker/volumes/notarium-state/meta.db'), 'a stand, not ours')
    process.chdir(cwd)
    const e = env({ HOME: cwd })
    expect(legacyMetaDbAt(e, dataPathsFromEnv(e))).toBeNull()
  })

  it('stays silent once our own meta-DB exists — it only guards the FIRST boot', async () => {
    const { cwd, paths } = await bareLegacy()
    await mkdir(join(cwd, 'data'), { recursive: true })
    await writeFile(join(cwd, 'data/meta.db'), 'ours')
    expect(legacyMetaDbAt(env({ DATA_DIR: join(cwd, 'data') }), paths)).toBeNull()
  })

  it('stays silent when the operator named META_DB_URL — they chose the location', async () => {
    const { cwd, paths } = await bareLegacy()
    const e = env({ DATA_DIR: join(cwd, 'data'), META_DB_URL: 'postgres://h/db' })
    expect(legacyMetaDbAt(e, paths)).toBeNull()
  })

  it('stays silent on a clean host — no legacy layout, no false alarm', async () => {
    const cwd = await tmpRoot()
    process.chdir(cwd)
    const e = env({ DATA_DIR: join(cwd, 'data') })
    expect(legacyMetaDbAt(e, dataPathsFromEnv(e))).toBeNull()
  })
})

describe('describeDataPaths (#101)', () => {
  it('reports one line when everything derives from the root', () => {
    const p = dataPathsFromEnv(env({ DATA_DIR: '/data' }))
    expect(describeDataPaths(p, p.defaultSpacesRoot)).toEqual(['data:   /data'])
  })

  it('names the REAL paths when overrides scatter data off the root', () => {
    // The boot banner must not claim a root the data does not live under — a
    // pre-#101 deployment stores nothing in /data, and saying "data: /data" there
    // sends the operator to an empty directory.
    const p = dataPathsFromEnv(
      env({
        DATA_DIR: '/data',
        META_DB_URL: 'sqlite:/state/meta.db',
        ENGINE_DATA_DIR: '/state/engine',
        JOBS_DATA_DIR: '/state/jobs',
      }),
    )
    const out = describeDataPaths(p, '/spaces').join('\n')
    expect(out).not.toContain('data:   /data')
    expect(out).toContain('/state')
    expect(out).toContain('/spaces')
  })

  it('keeps the root line when only SOME paths are moved off it', () => {
    const p = dataPathsFromEnv(env({ DATA_DIR: '/data', JOBS_DATA_DIR: '/big/jobs' }))
    const out = describeDataPaths(p, p.defaultSpacesRoot).join('\n')
    expect(out).toContain('data:   /data')
    expect(out).toContain('/big/jobs')
  })
})

describe('ensureDataRoot (#101)', () => {
  it('creates and write-probes every data dir up front, before any store needs one', async () => {
    const root = await tmpRoot()
    const paths = dataPathsFromEnv(env({ DATA_DIR: root }))
    await ensureDataRoot(paths, paths.defaultSpacesRoot)

    expect((await readdir(root)).sort()).toEqual(['engine', 'jobs', 'spaces'])
    // Staging is a subtree of jobs and is exactly where import died — probed too.
    expect(await readdir(paths.jobsDataDir)).toEqual([basename(paths.importStagingDir)])
  })

  it('leaves no probe marker behind', async () => {
    const root = await tmpRoot()
    const paths = dataPathsFromEnv(env({ DATA_DIR: root }))
    await ensureDataRoot(paths, undefined)
    const stray = (await readdir(root)).filter((f) => f.startsWith('.notarium-write-probe'))
    expect(stray).toEqual([])
  })

  it('skips the spaces root on an operator-static host (those dirs are not ours)', async () => {
    const root = await tmpRoot()
    const paths = dataPathsFromEnv(env({ DATA_DIR: root }))
    await ensureDataRoot(paths, undefined)
    expect(await readdir(root)).not.toContain('spaces')
  })

  it('fails on boot with an actionable message when the root is not writable', async () => {
    const parent = await tmpRoot()
    const root = join(parent, 'ro')
    await mkdir(root)
    await chmod(root, 0o500) // r-x: mkdir -p SUCCEEDS on an existing dir, writes do not

    const paths = dataPathsFromEnv(env({ DATA_DIR: root }))
    await expect(ensureDataRoot(paths, undefined)).rejects.toThrow(/is not writable/)
    // Names the path and the fix — the boot error must not need our source to read.
    await expect(ensureDataRoot(paths, undefined)).rejects.toThrow(/DATA_DIR=/)
    await chmod(root, 0o755)
  })

  it('catches an UNWRITABLE OVERRIDE even when the root itself is fine', async () => {
    // Exactly the soft-classification risk: overrides can land on another mount, so
    // a writable root proves nothing about the rest. This is the incident's shape —
    // meta/engine fine, the jobs path not — turned into a boot error.
    const root = await tmpRoot()
    const badParent = await tmpRoot()
    const badJobs = join(badParent, 'ro', 'jobs')
    await mkdir(join(badParent, 'ro'))
    await chmod(join(badParent, 'ro'), 0o500)

    const paths = dataPathsFromEnv(env({ DATA_DIR: root, JOBS_DATA_DIR: badJobs }))
    await expect(ensureDataRoot(paths, paths.defaultSpacesRoot)).rejects.toThrow(
      /job artifact dir is not writable/,
    )
    await chmod(join(badParent, 'ro'), 0o755)
  })

  it('does NOT create the root when every path is overridden away from it', async () => {
    // A pre-#101 deployment overrides all four onto /state + /spaces and never touches
    // the data root. Creating it there would invent an empty directory (and, in the
    // image, an empty anonymous volume) for a root that holds nothing.
    const elsewhere = await tmpRoot()
    const root = join(await tmpRoot(), 'never-used')
    const paths = dataPathsFromEnv(
      env({
        DATA_DIR: root,
        META_DB_URL: `sqlite:${join(elsewhere, 'meta.db')}`,
        ENGINE_DATA_DIR: join(elsewhere, 'engine'),
        JOBS_DATA_DIR: join(elsewhere, 'jobs'),
      }),
    )
    await ensureDataRoot(paths, join(elsewhere, 'spaces'))
    expect(existsSync(root)).toBe(false)
    expect((await readdir(elsewhere)).sort()).toEqual(['engine', 'jobs', 'spaces'])
  })

  it('creates and probes the meta-DB dir for a BARE-path META_DB_URL', async () => {
    // The regression this pins: a bare path is a supported sqlite input, but a
    // prefix-only classifier read it as Postgres and skipped the directory — so the
    // meta-DB fell back to SqliteMetaDb's lazy mkdir and failed at first use, long
    // after a green boot. That is the exact shape #101 exists to remove.
    const root = await tmpRoot()
    const elsewhere = await tmpRoot()
    const bare = join(elsewhere, 'bare', 'meta.db')
    const paths = dataPathsFromEnv(env({ DATA_DIR: root, META_DB_URL: bare }))

    expect(paths.metaDbUrl).toBe(`sqlite:${bare}`)
    await ensureDataRoot(paths, undefined)
    expect(existsSync(join(elsewhere, 'bare'))).toBe(true)
    // …and the banner must name it, not claim it lives under the root.
    expect(describeDataPaths(paths, undefined).join('\n')).toContain(join(elsewhere, 'bare'))
  })

  it('does not create a directory for an in-memory meta-DB', async () => {
    const root = await tmpRoot()
    const paths = dataPathsFromEnv(env({ DATA_DIR: root, META_DB_URL: 'sqlite::memory:' }))
    await ensureDataRoot(paths, undefined)
    expect(existsSync(join(process.cwd(), ':memory:'))).toBe(false)
  })

  it('probes the staging dir the store ACTUALLY roots at, not a rebuilt literal', async () => {
    // importStagingDir is one field read by both the probe and createFsImportStagingStore
    // (server.ts). Pinning the field — rather than re-deriving `join(jobs,'imports')`
    // here — is what makes this test able to fail: a test that rebuilds the literal
    // only proves the literal agrees with itself.
    const root = await tmpRoot()
    const paths = dataPathsFromEnv(env({ DATA_DIR: root }))
    await ensureDataRoot(paths, undefined)
    expect(existsSync(paths.importStagingDir)).toBe(true)
    expect(paths.importStagingDir.startsWith(paths.jobsDataDir + '/')).toBe(true)
  })

  it('probes the meta-DB dir for sqlite and skips it for postgres', async () => {
    const root = await tmpRoot()
    const pg = dataPathsFromEnv(env({ DATA_DIR: root, META_DB_URL: 'postgres://h/db' }))
    // No local file to create — must not try, and must not fail.
    await expect(ensureDataRoot(pg, undefined)).resolves.toBeUndefined()

    const parent = await tmpRoot()
    await mkdir(join(parent, 'ro'))
    await writeFile(join(parent, 'ro', 'meta.db'), '')
    await chmod(join(parent, 'ro'), 0o500)
    const sqlite = dataPathsFromEnv(
      env({ DATA_DIR: root, META_DB_URL: `sqlite:${join(parent, 'ro', 'meta.db')}` }),
    )
    await expect(ensureDataRoot(sqlite, undefined)).rejects.toThrow(/meta-DB dir is not writable/)
    await chmod(join(parent, 'ro'), 0o755)
  })
})
