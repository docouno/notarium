import { describe, expect, it } from 'vitest'

import {
  assertNotConnectionString,
  describeMetaDbUrl,
  META_DB_TARGET_KIND,
  metaDbFlavourOf,
  metaDbTargetOf,
} from './metaDbUrl'

describe('metaDbTargetOf — the ONE meta-DB URL classifier', () => {
  it('reads the three forms the driver accepts', () => {
    expect(metaDbTargetOf('postgres://h/db')).toEqual({
      kind: META_DB_TARGET_KIND.postgres,
      url: 'postgres://h/db',
    })
    expect(metaDbTargetOf('postgresql://h/db')).toEqual({
      kind: META_DB_TARGET_KIND.postgres,
      url: 'postgresql://h/db',
    })
    expect(metaDbTargetOf('sqlite:/data/meta.db')).toEqual({
      kind: META_DB_TARGET_KIND.file,
      path: '/data/meta.db',
    })
    // A bare value is a sqlite FILE, so anything deciding "is there a directory to
    // create and probe" must read it the same way.
    expect(metaDbTargetOf('/state/meta.db')).toEqual({
      kind: META_DB_TARGET_KIND.file,
      path: '/state/meta.db',
    })
  })

  it('keeps :memory: a sentinel, never a path', () => {
    // resolve(':memory:') would yield <cwd>/:memory: — a real directory, created and
    // probed in whatever cwd started the process.
    expect(metaDbTargetOf('sqlite::memory:')).toEqual({ kind: META_DB_TARGET_KIND.memory })
    expect(metaDbTargetOf(':memory:')).toEqual({ kind: META_DB_TARGET_KIND.memory })
  })

  it('classifies schemes case-insensitively (RFC 3986)', () => {
    // The trap this closes: a case-sensitive test demoted POSTGRES:// to a filename,
    // so the host opened an empty SQLite file named after the connection string —
    // password and all — instead of connecting.
    expect(metaDbTargetOf('POSTGRES://h/db').kind).toBe(META_DB_TARGET_KIND.postgres)
    expect(metaDbTargetOf('PostgreSQL://h/db').kind).toBe(META_DB_TARGET_KIND.postgres)
    expect(metaDbTargetOf('SQLITE:/data/meta.db')).toEqual({
      kind: META_DB_TARGET_KIND.file,
      path: '/data/meta.db',
    })
  })

  it('refuses an unknown scheme instead of demoting it to a filename', () => {
    // The whole class this classifier exists to kill: a typo that becomes a path is a
    // FRESH EMPTY database — recovery reads "no users", a password host re-opens the
    // public first-run screen, and nothing anywhere errors.
    for (const url of ['postgress://u:pw@h/db', 'mysql://h/db', 'sqlite3:/data/meta.db']) {
      expect(() => metaDbTargetOf(url)).toThrow(/unsupported meta-DB URL scheme/)
    }
  })

  it('hands a malformed but RECOGNISED Postgres URL to the Postgres driver', () => {
    // Only the scheme is ours to judge. A missing `//` is a connection string the
    // driver must reject out loud — turning it into a file path is the silent
    // failure this classifier exists to prevent.
    expect(metaDbTargetOf('postgres:/var/run/postgresql/notarium').kind).toBe(
      META_DB_TARGET_KIND.postgres,
    )
  })

  it('names the scheme in that error, and nothing else from the URL', () => {
    // The URL is not quoted back at all: it may hold a credential, and the scheme is
    // the whole diagnosis anyway.
    expect(() => metaDbTargetOf('postgress://u:hunter2@h/db')).toThrow(/"postgress:"/)
    expect(() => metaDbTargetOf('postgress://u:hunter2@h/db')).not.toThrow(/hunter2/)
    expect(() => metaDbTargetOf('postgress://u:hunter2@h/db')).not.toThrow(/h\/db/)
  })

  it('keeps a path that merely LOOKS like a Postgres URL a path', () => {
    // The admin-CLI defect: `startsWith('postgres')` called this Postgres, so it
    // slipped past the "file must exist" guard and createMetaDb then opened it as a
    // brand-new SQLite file.
    expect(metaDbTargetOf('postgres-backup/meta.db')).toEqual({
      kind: META_DB_TARGET_KIND.file,
      path: 'postgres-backup/meta.db',
    })
    expect(metaDbTargetOf('postgres.db')).toEqual({
      kind: META_DB_TARGET_KIND.file,
      path: 'postgres.db',
    })
  })

  it('refuses a URL that names no database at all', () => {
    // `sqlite:` used to yield an empty path, which the env edge then resolved to the
    // process cwd — a directory opened as a database, from the same family as the
    // scheme typo: a value nobody meant, accepted in silence.
    for (const url of ['sqlite:', '', '   ', 'sqlite:   ']) {
      expect(() => metaDbTargetOf(url)).toThrow(/names no database/)
    }
  })

  it('leaves a plain path alone even when it carries a colon or a drive letter', () => {
    // A single-letter scheme is a Windows drive; a colon deeper in the path is not a
    // scheme at all. Both must stay paths — refusing them would break real roots.
    expect(metaDbTargetOf('C:/data/meta.db').kind).toBe(META_DB_TARGET_KIND.file)
    expect(metaDbTargetOf('./data/2026:07/meta.db').kind).toBe(META_DB_TARGET_KIND.file)
    expect(metaDbTargetOf('/srv/notarium/meta.db').kind).toBe(META_DB_TARGET_KIND.file)
  })
})

describe('assertNotConnectionString — the env edge refuses a typed credential', () => {
  it('refuses a connection string that lost its scheme, rather than making it a filename', () => {
    // The original defect's last shape: taken as a path, `host=db password=…` becomes a
    // DIRECTORY NAMED AFTER THE CREDENTIAL — created on disk, holding a fresh empty
    // database, and printed by whatever reports paths, including fs errors nothing
    // here formats.
    for (const raw of [
      'host=db user=u password=hunter2',
      'password = hunter2 host=db',
      'sslpassword=hunter2 host=db',
      '//user:hunter2@dbhost/notarium',
      'user:hunter2@dbhost/notarium',
    ]) {
      expect(() => assertNotConnectionString(raw)).toThrow(/looks like a connection string/)
    }
  })

  it('lets an ordinary path through, colons and at-signs included', () => {
    // It runs on what the OPERATOR typed, and a data root is allowed to look like this.
    // Anchoring the userinfo test at the start is what keeps a dated directory holding a
    // mail-shaped folder from reading as a credential.
    for (const raw of [
      '/home/ann@corp.example/notarium/meta.db',
      '/data/2026:07/team@corp/meta.db',
      'sqlite:/data/2026:07/team@corp/meta.db',
      './data/meta.db',
      '/srv/pass-through/meta.db',
      '//nas/share/notarium/meta.db',
    ]) {
      expect(() => assertNotConnectionString(raw)).not.toThrow()
    }
    // A recognised scheme never reaches this gate — its callers run it only on a value
    // that classified as a PATH, so a real `postgres://user:pw@host/db` is untouched.
    // dataPaths.test.ts pins that ordering end to end.
  })
})

describe('metaDbFlavourOf — the deployment shape /api/about publishes', () => {
  it('names the driver behind each URL form, and `none` without one', () => {
    // The drift this replaces: a prefix test read a bare-path meta-DB as 'none', so
    // an admin's diagnostics said "no database" about a host that had one.
    expect(metaDbFlavourOf(undefined)).toBe('none')
    expect(metaDbFlavourOf('postgres://h/db')).toBe('postgres')
    expect(metaDbFlavourOf('postgresql://h/db')).toBe('postgres')
    expect(metaDbFlavourOf('sqlite:/data/meta.db')).toBe('sqlite')
    expect(metaDbFlavourOf('/state/meta.db')).toBe('sqlite')
    expect(metaDbFlavourOf('sqlite::memory:')).toBe('sqlite')
  })

  it('refuses to label a URL it cannot classify', () => {
    expect(() => metaDbFlavourOf('mysql://h/db')).toThrow(/unsupported meta-DB URL scheme/)
  })
})

describe('describeMetaDbUrl — how the meta-DB is NAMED in output', () => {
  it('names a path in full — it is the branch that matters and holds no credential', () => {
    // The empty-database footgun this classifier exists for is a SQLite one, so
    // "which meta.db did admin just read?" must be answerable from the banner alone.
    expect(describeMetaDbUrl('sqlite:/data/meta.db')).toBe('sqlite:/data/meta.db')
    expect(describeMetaDbUrl('/data/meta.db')).toBe('/data/meta.db')
    expect(describeMetaDbUrl('postgres-backup/meta.db')).toBe('postgres-backup/meta.db')
    expect(describeMetaDbUrl('sqlite::memory:')).toBe('sqlite::memory:')
  })

  it('keeps naming a path that contains an @ — a home directory is not a credential', () => {
    // Both call sites pass the CANONICAL `sqlite:<abs>` form, so testing the whole
    // string for `…:…@` paired OUR scheme colon with any '@' in the path and hid
    // ordinary directories behind a marker that reads as "a secret was here".
    expect(describeMetaDbUrl('sqlite:/home/ann@corp.example/notarium/meta.db')).toBe(
      'sqlite:/home/ann@corp.example/notarium/meta.db',
    )
    expect(describeMetaDbUrl('/var/lib/notarium@prod/meta.db')).toBe(
      '/var/lib/notarium@prod/meta.db',
    )
  })

  it('names any other scheme by its scheme alone', () => {
    // Nine review rounds went into printing a Postgres address without its password;
    // every rule for where a credential ENDS was beaten by a password containing that
    // character, and the last one still produced a WRONG address 4.5% of the time on
    // punctuation-bearing passwords. The driver names host, database and user in its
    // own connection error, so nothing is lost that was ever reliable here.
    expect(describeMetaDbUrl('postgres://user:hunter2@db:5432/notarium')).toBe('postgres://…')
    expect(describeMetaDbUrl('postgres://db/notarium')).toBe('postgres://…')
    expect(describeMetaDbUrl('POSTGRESQL://u:pw@h/db')).toBe('postgresql://…')
    // Including a scheme this host does not support — the message that quotes it back
    // must not quote the credential with it.
    expect(describeMetaDbUrl('postgress://u:hunter2@h/db')).toBe('postgress://…')
  })

  it('never echoes a value that carries a credential, however it is spelled', () => {
    // A connection URL whose scheme was left off; a password holding a space, a '/',
    // a '#'; a libpq keyword string. None of these parse into an address, and every
    // earlier attempt to print them safely leaked.
    expect(describeMetaDbUrl('user:hunter2@host/db')).toBe('user://…')
    expect(describeMetaDbUrl(':hunter2@host/db')).toBe('… (hidden)')
    expect(describeMetaDbUrl('postgres://notarium:0/hunter2#@db/n')).toBe('postgres://…')
    // A keyword string is hidden whole rather than part-masked: where the password
    // ENDS is the guess that failed review nine times over.
    expect(describeMetaDbUrl('host=db user=u password=hunter2')).toBe('… (hidden)')
    expect(describeMetaDbUrl('pwd=hunter2 host=db')).toBe('… (hidden)')
  })
})
