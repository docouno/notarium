// The zero-write half of a Markdown-tree import: classification and the
// preflight plan. Everything asserted here happens BEFORE a store exists, which
// is the point — a structural failure must be provable without a single write.

import AdmZip from 'adm-zip'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { IMPORT_FORMAT, ImportError } from '@notarium/core'

import { serializedImportPlanBytes } from '../../libs/importStaging'
import { IMPORT_DETAIL_CAP, PLAN_SETTLED_ENTRY_BYTES } from './consts'
import {
  type ArchiveLimits,
  classifyImportArchive,
  DEFAULT_ARCHIVE_LIMITS,
  ImportPlanConflictError,
  runMarkdownTreePlan,
} from './markdownTree'
import type { MarkdownTreePlanV1 } from './types'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notarium-tree-test-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

type Member = { name: string; body?: string | Buffer; date?: Date }

/** Write a ZIP to disk and return its path. `rename` rewrites a member name in
 *  the finished bytes — adm-zip sanitises `../` away, and a traversing name is
 *  exactly what the planner has to refuse. The replacement must be the same
 *  length so every header offset stays valid. */
const zipOf = async (
  members: Member[],
  name = 'vault.zip',
  rename?: Record<string, string>,
): Promise<string> => {
  const zip = new AdmZip()

  for (const member of members) {
    if (member.name.endsWith('/')) {
      zip.addFile(member.name, Buffer.alloc(0))
      continue
    }
    const content = Buffer.isBuffer(member.body)
      ? member.body
      : Buffer.from(member.body ?? '', 'utf8')

    zip.addFile(member.name, content, '', undefined as never)
    if (member.date) {
      const entry = zip.getEntry(member.name)!

      entry.header.time = member.date
    }
  }
  let bytes = zip.toBuffer()

  for (const [from, to] of Object.entries(rename ?? {})) {
    if (Buffer.byteLength(from) !== Buffer.byteLength(to)) {
      throw new Error('rename must preserve the byte length')
    }
    bytes = Buffer.from(bytes.toString('latin1').replaceAll(from, to), 'latin1')
  }
  const path = join(dir, name)

  await writeFile(path, bytes)

  return path
}

const classify = (
  uploadPath: string,
  opts: Partial<Parameters<typeof classifyImportArchive>[0]> = {},
) =>
  classifyImportArchive({
    uploadPath,
    tempDir: dir,
    uploadRef: 'space/job.import',
    root: '',
    ...opts,
  })

const planOf = async (
  members: Member[],
  opts: Partial<Parameters<typeof classifyImportArchive>[0]> = {},
  rename?: Record<string, string>,
): Promise<MarkdownTreePlanV1> => {
  const classification = await classify(await zipOf(members, 'vault.zip', rename), opts)

  if (classification.kind !== 'markdown-tree') {
    throw new Error('expected a markdown tree')
  }

  return classification.plan
}

/** A ZIP written by hand, members STORED in the order given.
 *
 *  adm-zip sorts its central directory by name, and the order a ZIP lists its
 *  members in is exactly the variable these tests hold: the classification of a
 *  fixed set of members must not depend on it. */
const orderedZipOf = async (members: Member[], name: string): Promise<string> => {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const member of members) {
    const nameBytes = Buffer.from(member.name, 'utf8')
    const data = Buffer.isBuffer(member.body) ? member.body : Buffer.from(member.body ?? '', 'utf8')
    const crc = crc32(data)
    const localHeader = Buffer.alloc(30)

    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed
    localHeader.writeUInt16LE(0, 8) // method: stored
    localHeader.writeUInt16LE(0x21, 12) // DOS date: 1980-01-01
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(data.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    const centralHeader = Buffer.alloc(46)

    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(0, 10) // method: stored
    centralHeader.writeUInt16LE(0x21, 14) // DOS date: 1980-01-01
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(data.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt32LE(offset, 42)
    local.push(localHeader, nameBytes, data)
    central.push(centralHeader, nameBytes)
    offset += localHeader.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)

  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(members.length, 8)
  end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  const path = join(dir, name)

  await writeFile(path, Buffer.concat([...local, directory, end]))

  return path
}

const NOTE = '# Hello\n\nBody text.\n'

/** Bytes a packer cannot shrink, so a member built from them declares an honest
 *  ratio: a fixture that must be metered by its SIZE has no business tripping the
 *  compression guard on its way there. */
const incompressible = (bytes: number, seed: number): Buffer => {
  const out = Buffer.alloc(bytes)
  let state = seed || 1

  for (let i = 0; i < bytes; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    out[i] = (state >>> 16) & 0xff
  }

  return out
}

const CONVERSATIONS = JSON.stringify([
  {
    uuid: 'c-1',
    name: 'Chat',
    created_at: '2024-01-01T00:00:00Z',
    chat_messages: [{ sender: 'human', text: 'hi', created_at: '2024-01-01T00:00:00Z' }],
  },
])

describe('classification', () => {
  it('classifies an archive of .md members as a markdown tree, keeping the wrapper folder', async () => {
    const plan = await planOf([
      { name: 'vault/' },
      { name: 'vault/a.md', body: NOTE },
      { name: 'vault/deep/nested/b.md', body: NOTE },
    ])

    expect(plan.entriesTotal).toBe(2)
    // The storage name comes from the FILE name (idempotency by file, #280), the
    // title from the heading — so the wrapper and the nesting are reproduced
    // verbatim while the note is still titled "Hello".
    expect(plan.entries.map((e) => e.destinationPath)).toEqual([
      'vault/a.md',
      'vault/deep/nested/b.md',
    ])
    // A directory record is structure, not a user file: it neither imports nor
    // counts as something ignored.
    expect(plan.ignored.count).toBe(0)
  })

  it('proves the root is safe while storing destinations relative to it', async () => {
    const plan = await planOf([{ name: 'vault/a.md', body: NOTE }], { root: 'imported/2026' })

    expect(plan.entries[0].destinationPath).toBe('vault/a.md')
    expect(plan.root).toBe('imported/2026')
  })

  it('lets a recognised foreign export win over Markdown members in the same archive', async () => {
    const conversations = JSON.stringify([
      {
        uuid: 'c-1',
        name: 'Chat',
        created_at: '2024-01-01T00:00:00Z',
        chat_messages: [{ sender: 'human', text: 'hi', created_at: '2024-01-01T00:00:00Z' }],
      },
    ])
    const classification = await classify(
      await zipOf([
        { name: 'notes/a.md', body: NOTE },
        { name: 'conversations.json', body: conversations },
      ]),
    )

    expect(classification.kind).toBe('foreign')
  })

  it('classifies unrecognised JSON beside Markdown as a tree, counting the JSON as ignored', async () => {
    const plan = await planOf([
      { name: 'notes/a.md', body: NOTE },
      { name: 'notes/settings.json', body: '{"theme":"dark"}' },
      { name: 'notes/logo.png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { name: '__MACOSX/._a.md', body: 'noise' },
    ])

    expect(plan.entriesTotal).toBe(1)
    // Container noise is not a user file; the JSON and the image are.
    expect(plan.ignored.count).toBe(2)
    expect([...plan.ignored.files].sort()).toEqual(['notes/logo.png', 'notes/settings.json'])
  })

  // The sample is bounded, so WHICH members it holds is a contract: archive order,
  // the same order every other collection an import reports uses. Sorted or
  // arrival-shuffled, the first 200 names of a 10 000-member archive would be a
  // different set of files, and the user has no second place to look.
  it('samples the ignored members in ARCHIVE order', async () => {
    const classification = await classify(
      await orderedZipOf(
        [
          { name: 'notes/a.md', body: NOTE },
          { name: 'z-last.png', body: 'x' },
          { name: 'a-first.png', body: 'x' },
        ],
        'ignored-order.zip',
      ),
    )

    if (classification.kind !== 'markdown-tree') {
      throw new Error('expected a markdown tree')
    }
    expect(classification.plan.ignored.files).toEqual(['z-last.png', 'a-first.png'])
  })

  it('honours an explicit markdown format over a recognised JSON member', async () => {
    const conversations = JSON.stringify([
      {
        uuid: 'c-1',
        name: 'Chat',
        created_at: '2024-01-01T00:00:00Z',
        chat_messages: [{ sender: 'human', text: 'hi', created_at: '2024-01-01T00:00:00Z' }],
      },
    ])
    const plan = await planOf(
      [
        { name: 'notes/a.md', body: NOTE },
        { name: 'conversations.json', body: conversations },
      ],
      { format: IMPORT_FORMAT.markdown },
    )

    expect(plan.entriesTotal).toBe(1)
    expect(plan.ignored.files).toEqual(['conversations.json'])
  })

  it('uses the shared text-extension policy only for forced Markdown trees', async () => {
    const members = ['md', 'markdown', 'mdown', 'mkd', 'txt', 'text'].map((extension) => ({
      name: `notes/a-${extension}.${extension}`,
      body: NOTE,
    }))
    const forced = await planOf(members, { format: IMPORT_FORMAT.markdown })
    const automatic = await planOf(members)

    expect(forced.entriesTotal).toBe(6)
    expect(forced.ignored.count).toBe(0)
    expect(automatic.entriesTotal).toBe(1)
    expect(automatic.ignored.count).toBe(5)
  })

  it('refuses an archive with neither a recognised export nor a Markdown member', async () => {
    await expect(classify(await zipOf([{ name: 'a.png', body: 'x' }]))).rejects.toThrow(
      /No recognised export files/,
    )
  })

  // A caller who named `markdown` was not asking about JSON exports, and advising
  // them to supply a `conversations.json` answers a question they did not ask.
  it('refuses a forced Markdown archive in terms of the format that was asked for', async () => {
    const failure = classify(await zipOf([{ name: 'a.png', body: 'x' }]), {
      format: IMPORT_FORMAT.markdown,
    })

    await expect(failure).rejects.toThrow(/No Markdown files/)
    await expect(failure).rejects.not.toThrow(/conversations\.json/)
  })

  it('does not let an "entities"-looking ordinary JSON hijack the classification', async () => {
    const plan = await planOf([
      { name: 'a.md', body: NOTE },
      { name: 'config.json', body: '{"entities": "a comma, separated, string"}' },
    ])

    expect(plan.entriesTotal).toBe(1)
    expect(plan.ignored.count).toBe(1)
  })
})

describe('structural refusals (zero writes by construction)', () => {
  it('refuses a duplicate normalized destination even when the sources differ', async () => {
    await expect(
      planOf([
        { name: 'vault/Hello.md', body: '---\ntitle: Hello\n---\nOne.\n' },
        { name: 'vault/hello.md', body: '---\ntitle: Hello\n---\nTwo.\n' },
      ]),
    ).rejects.toThrow(/destination collision/)
  })

  // The ARCHIVE READER refuses this one, not the planner: yauzl validates every
  // central-directory name and rejects a `..` component before a member is ever
  // handed over. Asserted as what it is — the two guards answer different halves
  // of the same question, and a test that credits the planner for yauzl's work
  // reports a branch as covered that never executes.
  it('refuses a traversing Markdown path at the archive reader, as deterministic bad input', async () => {
    const failure = planOf(
      [{ name: 'zz/escape.md', body: NOTE }],
      {},
      { 'zz/escape.md': '../escape.md' },
    )

    await expect(failure).rejects.toBeInstanceOf(ImportError)
    await expect(failure).rejects.toThrow(/archive is unreadable/)
    await expect(failure).rejects.toThrow(/\.\.\/escape\.md/)
  })

  // These reach `memberAddress`: yauzl accepts both names (no `..`, no backslash,
  // not absolute) and OUR guard is the one that refuses them. That guard exists
  // precisely because an engine's traversal behaviour is version behaviour, not a
  // contract we can rest a boundary on.
  it('refuses a dot-prefixed Markdown path — those segments belong to the engine', async () => {
    await expect(planOf([{ name: '.trash/old.md', body: NOTE }])).rejects.toThrow(/unsafe path/)
  })

  it('refuses a Markdown name carrying a control character', async () => {
    await expect(
      planOf([{ name: 'zz/note.md', body: NOTE }], {}, { 'zz/note.md': 'zz/no\u0001e.md' }),
    ).rejects.toThrow(/unsafe path/)
  })

  // A safe member under a hostile ROOT: the member's own address is fine, so the
  // earlier guard passes it, and only the joined destination escapes. Two
  // untrusted inputs, two checks — the second was unreachable through the first.
  it('refuses a safe member whose destination escapes once the root is joined', async () => {
    await expect(
      planOf([{ name: 'vault/a.md', body: NOTE }], { root: '../escape' }),
    ).rejects.toThrow(/unsafe destination directory/)
  })

  // Two files claiming one identity cannot both be mapped, and picking a winner
  // would silently drop the other's inbound links — the exact-link map keys on the
  // claim, so the loser's `[[...]]` targets would resolve to the winner's copy.
  it('refuses two Markdown members claiming the same identity', async () => {
    const claim = '---\nnotarium-id: abcdefghijkl\n---\nBody.\n'

    await expect(
      planOf([
        { name: 'one.md', body: claim },
        { name: 'two.md', body: claim },
      ]),
    ).rejects.toThrow(/duplicate notarium-id claim, also held by one\.md/)
  })

  it('refuses YAML anchors/aliases before any write, even when a good member came first', async () => {
    await expect(
      planOf([
        { name: 'good.md', body: NOTE },
        { name: 'bad.md', body: '---\nanchor: &a value\ncopy: *a\n---\nBody.\n' },
      ]),
    ).rejects.toThrow(/anchors or aliases/)
  })

  it('refuses a source that only overflows the frontmatter cap once our typed fields are added', async () => {
    // Just under the cap on its own; `title:`, `created:` and the identity push it over.
    const nearCap = `---\nauthor: ${'a'.repeat(64 * 1024 - 40)}\n---\nBody.\n`

    await expect(planOf([{ name: 'near.md', body: nearCap }])).rejects.toThrow(/64 KiB limit/)
  })
})

describe('resource budgets', () => {
  const limits = (over: Partial<ArchiveLimits>): ArchiveLimits => ({
    ...DEFAULT_ARCHIVE_LIMITS,
    ...over,
  })

  // Every other budget test injects its own tiny limits, which proves each
  // counter is wired to its own ceiling and nothing about the ceilings we ship.
  // Multiplying all five by a thousand left the whole suite green — so the
  // production numbers are pinned here as literals, on purpose: importing the
  // constant would make the pin travel with the value it is supposed to hold.
  it('ships the ceilings the contract names', () => {
    expect(DEFAULT_ARCHIVE_LIMITS).toEqual({
      maxEntries: 100_000,
      maxDeclaredExpandedBytes: 6 * 1024 * 1024 * 1024,
      maxExpandedBytes: 6 * 1024 * 1024 * 1024,
      maxMetadataBytes: 32 * 1024 * 1024,
      maxCompressionRatio: 10_000,
      maxMarkdownBytes: 64 * 1024 * 1024,
      maxProbeMemberBytes: 6 * 1024 * 1024 * 1024,
      maxProbeBytes: 6 * 1024 * 1024 * 1024,
    })
  })

  it('caps every detail collection of a result at 200', () => {
    expect(IMPORT_DETAIL_CAP).toBe(200)
  })

  it('refuses more central-directory entries than the ceiling allows', async () => {
    await expect(
      planOf(
        [
          { name: 'a.md', body: NOTE },
          { name: 'b.md', body: NOTE },
          { name: 'c.md', body: NOTE },
        ],
        { limits: limits({ maxEntries: 2 }) },
      ),
    ).rejects.toThrow(/more than 2 entries/)
  })

  it('refuses an archive whose DECLARED expansion crosses the ceiling', async () => {
    await expect(
      planOf([{ name: 'a.md', body: NOTE }], {
        limits: limits({ maxDeclaredExpandedBytes: 4 }),
      }),
    ).rejects.toThrow(/declares more expanded data/)
  })

  it('refuses an archive whose REAL bytes cross the ceiling even when the headers pass', async () => {
    // The two counters are separate on purpose: a header the archive author
    // writes cannot be trusted, so the bytes that actually arrive are metered
    // independently. Here the declared budget is wide open and only the actual
    // one is tight — exactly the shape a lying header would produce.
    await expect(
      planOf([{ name: 'a.md', body: NOTE }], {
        limits: limits({ maxDeclaredExpandedBytes: 1e9, maxExpandedBytes: 4 }),
      }),
    ).rejects.toThrow(/expands past the import limit/)
  })

  it('meters the bytes of IGNORED members too', async () => {
    await expect(
      planOf(
        [
          { name: 'a.md', body: NOTE },
          { name: 'big.bin', body: Buffer.alloc(4096, 7) },
        ],
        { limits: limits({ maxDeclaredExpandedBytes: 1e9, maxExpandedBytes: 1024 }) },
      ),
    ).rejects.toThrow(/expands past the import limit/)
  })

  // The probe opened it to answer the FOREIGN question and charged the tree
  // nothing for it — which is the point of that separation, and not a discount.
  // Once the archive IS a tree the member is an ignored member like any other, and
  // the drain is where its real bytes finally land.
  it('meters an unrecognised JSON member too, once the archive is a tree', async () => {
    await expect(
      planOf(
        [
          { name: 'a.md', body: NOTE },
          { name: 'blob.json', body: JSON.stringify({ pad: 'x'.repeat(4096) }) },
        ],
        { limits: limits({ maxDeclaredExpandedBytes: 1e9, maxExpandedBytes: 1024 }) },
      ),
    ).rejects.toThrow(/expands past the import limit/)
  })

  it('refuses a suspicious compression ratio on the header, before decompressing', async () => {
    // A megabyte of zeroes deflates far past the ratio ceiling.
    await expect(
      planOf(
        [
          { name: 'a.md', body: NOTE },
          { name: 'bomb.bin', body: Buffer.alloc(1024 * 1024) },
        ],
        { limits: limits({ maxCompressionRatio: 100 }) },
      ),
    ).rejects.toThrow(/suspicious compression ratio/)
  })

  it('refuses a Markdown member past the per-file cap', async () => {
    await expect(
      planOf([{ name: 'a.md', body: NOTE }], { limits: limits({ maxMarkdownBytes: 4 }) }),
    ).rejects.toThrow(/file too large/)
  })

  it('refuses a plan whose metadata representation crosses the ceiling', async () => {
    await expect(
      planOf(
        [
          { name: 'a.md', body: NOTE },
          { name: 'b.md', body: NOTE },
        ],
        { limits: limits({ maxMetadataBytes: 400 }) },
      ),
    ).rejects.toThrow(/metadata is too large/)
  })

  // What a sidecar costs is the SETTLED plan — identity settlement adds three
  // fields per entry after this pass — so the ceiling is charged the reserve for
  // them. Without it the cap guarded a document that is never written: a plan
  // that fits here and not on disk would be refused only by the filesystem.
  // (A long root is what makes this the BINDING check: the running charge counts
  // the root once per plan, so the serialized size overtakes it here.)
  it('charges the ceiling for what identity settlement will add', async () => {
    const root = ['aa', 'bb', 'cc', 'dd'].map((seg) => seg.repeat(50)).join('/')
    const members = [{ name: 'a.md', body: NOTE }]
    const bytes = serializedImportPlanBytes(await planOf(members, { root }))

    await expect(
      planOf(members, {
        root,
        limits: limits({ maxMetadataBytes: bytes + PLAN_SETTLED_ENTRY_BYTES - 1 }),
      }),
    ).rejects.toThrow(/metadata is too large/)
    await expect(
      planOf(members, {
        root,
        limits: limits({ maxMetadataBytes: bytes + PLAN_SETTLED_ENTRY_BYTES }),
      }),
    ).resolves.toBeTruthy()
  })

  // Every ceiling above is a ceiling on a MARKDOWN TREE — the constants say so and
  // so does the canon. Charged before the walk knows what the archive is, they
  // decided the classification instead: the SAME members with the export listed
  // first came back `foreign`, and with the export listed last came back refused.
  // A foreign export paid none of this before #302 and pays none now.
  describe('a ceiling is a TREE ceiling', () => {
    const mixed = (order: 'export-first' | 'export-last'): Member[] => {
      const markdown = [
        { name: 'a.md', body: NOTE },
        { name: 'b.md', body: NOTE },
        { name: 'c.md', body: NOTE },
      ]
      const conversations = { name: 'conversations.json', body: CONVERSATIONS }

      return order === 'export-first' ? [conversations, ...markdown] : [...markdown, conversations]
    }

    it.each([
      ['entries', { maxEntries: 2 }],
      ['declared bytes', { maxDeclaredExpandedBytes: 8 }],
      ['actual bytes', { maxDeclaredExpandedBytes: 1e9, maxExpandedBytes: 8 }],
      ['the per-member cap', { maxMarkdownBytes: 8 }],
    ])(
      'holds the %s ceiling: one set of members, one verdict, either order',
      async (label, over) => {
        const first = await classify(await orderedZipOf(mixed('export-first'), `${label}-1.zip`), {
          limits: limits(over),
        })
        const last = await classify(await orderedZipOf(mixed('export-last'), `${label}-2.zip`), {
          limits: limits(over),
        })

        expect(first.kind).toBe('foreign')
        expect(last.kind).toBe('foreign')
      },
    )

    // The probe's per-member cap is the one ceiling allowed to ANSWER the foreign
    // question rather than hold a refusal, and being per MEMBER is what earns it
    // that: the same member is read to the same cap wherever the central directory
    // lists it, so the answer cannot turn on the listing.
    it('holds the probe cap: one set of members, one verdict, either order', async () => {
      const first = await classify(await orderedZipOf(mixed('export-first'), 'probe-cap-1.zip'), {
        limits: limits({ maxProbeMemberBytes: 8 }),
      })
      const last = await classify(await orderedZipOf(mixed('export-last'), 'probe-cap-2.zip'), {
        limits: limits({ maxProbeMemberBytes: 8 }),
      })

      expect(first.kind).toBe('markdown-tree')
      expect(last.kind).toBe('markdown-tree')
    })

    // Held is not dropped: once the walk has answered "no recognised export", the
    // ceiling is the answer — and the members after it are still probed, or the
    // deferral would trade one order-dependence for another.
    it('raises the held ceiling once the archive turns out to be a tree after all', async () => {
      const failure = classify(
        await orderedZipOf(
          [
            { name: 'a.md', body: NOTE },
            { name: 'b.md', body: NOTE },
            { name: 'c.md', body: NOTE },
            { name: 'settings.json', body: '{"theme":"dark"}' },
          ],
          'held.zip',
        ),
        { limits: limits({ maxEntries: 2 }) },
      )

      await expect(failure).rejects.toBeInstanceOf(ImportError)
      await expect(failure).rejects.toThrow(/more than 2 entries/)
    })
  })

  // A held ceiling stops the PLAN from growing. It used to stop the archive's own
  // counters with it, and the two are not the same thing: the plan was over, the
  // upload was not, and every member after the first refusal was walked — and read —
  // against no ceiling at all.
  describe('the archive is still metered after a ceiling has fired', () => {
    const manyMembers = (count: number, make: (i: number) => Member): Member[] =>
      Array.from({ length: count }, (_unused, i) => make(i))

    // The scan counter is the visible half of "still walking, still counting": with
    // it frozen at the ceiling there is no heartbeat left for the rest of the
    // archive, and a cancel arriving in that stretch has nothing to arrive AT.
    it('keeps beating for the members walked after the ceiling', async () => {
      const path = await zipOf([
        { name: 'a.md', body: NOTE },
        { name: 'b.md', body: NOTE },
        ...manyMembers(300, (i) => ({ name: `pad${i}.png`, body: 'x' })),
      ])
      const controller = new AbortController()

      await expect(
        classify(path, {
          signal: controller.signal,
          limits: limits({ maxEntries: 2 }),
          onScanProgress: () => controller.abort(),
        }),
      ).rejects.toThrow(/canceled/)
    })

    // The one ceiling that can act where it fires, because its answer about a member
    // is the same wherever the member is listed. Held-and-then-probed, a declared
    // bomb was inflated to temp anyway — by the walk that a ceiling had just
    // narrowed, to answer a question the guard was never about.
    it('decompresses a declared bomb for nobody, in either order', async () => {
      const bomb = JSON.stringify([
        {
          uuid: 'c-1',
          name: 'Chat',
          created_at: '2024-01-01T00:00:00Z',
          chat_messages: [
            { sender: 'human', text: 'x'.repeat(512 * 1024), created_at: '2024-01-01T00:00:00Z' },
          ],
        },
      ])
      const bombFirst = classify(
        await zipOf(
          [
            { name: 'aa-conversations.json', body: bomb },
            { name: 'zz.md', body: NOTE },
          ],
          'bomb-first.zip',
        ),
        { limits: limits({ maxCompressionRatio: 100 }) },
      )
      const bombLast = classify(
        await zipOf(
          [
            { name: 'aa.md', body: NOTE },
            { name: 'zz-conversations.json', body: bomb },
          ],
          'bomb-last.zip',
        ),
        { limits: limits({ maxCompressionRatio: 100 }) },
      )

      // Never `foreign`: reaching that verdict means the bomb was inflated to read.
      await expect(bombFirst).rejects.toThrow(/suspicious compression ratio/)
      await expect(bombLast).rejects.toThrow(/suspicious compression ratio/)
    })
  })

  // The tree budget stops being spent the moment a tree ceiling is held. The probes
  // do not stop — the foreign question outlives every held ceiling — so "charged to
  // no tree budget" has to mean "charged to its own", or a refused archive gets its
  // every JSON member inflated into temp on the way to the refusal.
  describe('what answering the foreign question inflates', () => {
    const blobs = (count: number, bytes: number): Member[] =>
      Array.from({ length: count }, (_unused, i) => ({
        name: `blob${i}.json`,
        body: incompressible(bytes, i + 1),
      }))

    it('is metered across the whole archive, not once per member', async () => {
      await expect(
        classify(await zipOf([{ name: 'a.md', body: NOTE }, ...blobs(5, 200_000)]), {
          limits: limits({ maxProbeBytes: 100_000 }),
        }),
      ).rejects.toThrow(/classifying this archive expands past the import limit/)
    })

    it('is still metered after a tree ceiling has narrowed the walk', async () => {
      const failure = classify(
        await zipOf(
          [
            { name: 'aa.md', body: NOTE },
            { name: 'bb-pad.bin', body: incompressible(8192, 99) },
            ...blobs(5, 200_000).map((blob) => ({ ...blob, name: `cc-${blob.name}` })),
          ],
          'narrowed.zip',
        ),
        { limits: limits({ maxDeclaredExpandedBytes: 4096, maxProbeBytes: 100_000 }) },
      )

      // The declared-bytes ceiling fired on `bb-pad.bin` and is being HELD; the five
      // JSON members after it are still probed, and the probing is still paid for.
      await expect(failure).rejects.toThrow(
        /classifying this archive expands past the import limit/,
      )
    })

    // A member too large to read whole is not an export we could parse either, so
    // the per-member cap answers the question instead of refusing the archive — and
    // it is answered by the identity of the error the counter raised, which only
    // holds if the pipeline hands back the very object it was thrown.
    it('answers "not an export" for a member past the per-member cap', async () => {
      const plan = await planOf(
        [
          { name: 'a.md', body: NOTE },
          { name: 'conversations.json', body: CONVERSATIONS },
        ],
        { limits: limits({ maxProbeMemberBytes: 8 }) },
      )

      expect(plan.entriesTotal).toBe(1)
      expect(plan.ignored.files).toEqual(['conversations.json'])
    })
  })

  // Draining an ignored member is how a dishonest `uncompressedSize` is caught,
  // and a TREE still pays it (the test above). A foreign export does not: those
  // members are never read on that path at all, so inflating 40 MB before the
  // `conversations.json` that decides the archive is pure cost.
  it('never inflates the ignored members of an archive that turns out to be foreign', async () => {
    const conversations = JSON.stringify([
      {
        uuid: 'c-1',
        name: 'Chat',
        created_at: '2024-01-01T00:00:00Z',
        chat_messages: [{ sender: 'human', text: 'hi', created_at: '2024-01-01T00:00:00Z' }],
      },
    ])
    const classification = await classify(
      await zipOf([
        { name: 'blob.bin', body: Buffer.alloc(8192, 7) },
        { name: 'conversations.json', body: conversations },
      ]),
      // A ceiling the blob alone would blow through the moment anything read it.
      { limits: limits({ maxDeclaredExpandedBytes: 1e9, maxExpandedBytes: 2048 }) },
    )

    expect(classification.kind).toBe('foreign')
  })
})

describe('cancellation before the first write', () => {
  const manyMembers = (count: number, make: (i: number) => Member): Member[] =>
    Array.from({ length: count }, (_unused, i) => make(i))

  // The planning pass reads every Markdown member. A cancel arriving inside it
  // must destroy the active stream and close the archive, not wait for a walk of
  // 10 000 members to finish first.
  it('stops the planning pass at the member the cancel arrived on', async () => {
    const path = await zipOf(manyMembers(250, (i) => ({ name: `n${i}.md`, body: NOTE })))
    const controller = new AbortController()

    await expect(
      classify(path, {
        signal: controller.signal,
        onScanProgress: () => controller.abort(),
      }),
    ).rejects.toThrow(/canceled/)
  })

  // The counting drain is the other long stretch of a preflight, and the one a
  // cancel is most likely to land in: it is pure I/O over attachments nobody
  // wants. It heartbeats for the same reason, which is what makes this precise.
  it('stops the counting drain at the member the cancel arrived on', async () => {
    const path = await zipOf([
      { name: 'a.md', body: NOTE },
      ...manyMembers(250, (i) => ({ name: `blob${i}.bin`, body: Buffer.alloc(64, 7) })),
    ])
    const controller = new AbortController()
    let beats = 0

    await expect(
      classify(path, {
        signal: controller.signal,
        // The first beat belongs to the classification walk; the second is the
        // drain pass, which is where this cancel has to land.
        onScanProgress: () => {
          if (++beats === 2) {
            controller.abort()
          }
        },
      }),
    ).rejects.toThrow(/canceled/)
    expect(beats).toBe(2)
  })
})

describe('dates', () => {
  it('prefers the frontmatter date over the archive entry mtime', async () => {
    const plan = await planOf([
      {
        name: 'a.md',
        body: '---\ncreated: 2019-05-04T10:00:00Z\n---\nBody.\n',
        date: new Date('2024-01-02T03:04:00Z'),
      },
    ])

    // The plan carries the entry mtime; precedence stays with the parser, which
    // only falls back to it.
    expect(plan.entries[0].sourceCreatedAt).toBeTruthy()
  })

  it('uses a valid entry mtime as the creation-date fallback', async () => {
    const plan = await planOf([
      { name: 'a.md', body: NOTE, date: new Date('2021-07-08T09:10:00Z') },
    ])

    expect(plan.entries[0].sourceCreatedAt?.slice(0, 10)).toBe('2021-07-08')
  })

  it('treats a zero DOS timestamp as "unknown" rather than 1979', async () => {
    const path = await zipOf([{ name: 'a.md', body: NOTE }])
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(path))

    // Blank every DOS date/time field (local headers and central directory) the
    // way a stream-built archive does when it knows no timestamp.
    for (let i = 0; i + 4 <= raw.length; i++) {
      const sig = raw.readUInt32LE(i)

      if (sig === 0x04034b50) {
        raw.writeUInt16LE(0, i + 10)
        raw.writeUInt16LE(0, i + 12)
      } else if (sig === 0x02014b50) {
        raw.writeUInt16LE(0, i + 12)
        raw.writeUInt16LE(0, i + 14)
      }
    }
    const blanked = join(dir, 'blanked.zip')

    await writeFile(blanked, raw)
    const classification = await classify(blanked)

    if (classification.kind !== 'markdown-tree') {
      throw new Error('expected a markdown tree')
    }
    expect(classification.plan.entries[0].sourceCreatedAt).toBeUndefined()
  })
})

describe('executing pass', () => {
  it('replays exactly the planned members, in archive order', async () => {
    const path = await zipOf([
      { name: 'vault/a.md', body: '# A\n\nAlpha.\n' },
      { name: 'vault/notes.json', body: '{}' },
      { name: 'vault/b.md', body: '# B\n\nBeta.\n' },
    ])
    const classification = await classify(path)

    if (classification.kind !== 'markdown-tree') {
      throw new Error('expected a markdown tree')
    }
    const seen: string[] = []

    await runMarkdownTreePlan({
      uploadPath: path,
      plan: classification.plan,
      onEntry: async (note, entry) => {
        seen.push(`${entry.destinationPath}:${note.title}`)
      },
    })
    expect(seen).toEqual(['vault/a.md:A', 'vault/b.md:B'])
  })

  it('fails terminally when the archive no longer matches the frozen plan', async () => {
    const plan = await planOf([{ name: 'a.md', body: NOTE }])
    const other = await zipOf(
      [{ name: 'a.md', body: '# Different\n\nA longer body.\n' }],
      'other.zip',
    )

    await expect(
      runMarkdownTreePlan({ uploadPath: other, plan, onEntry: async () => {} }),
    ).rejects.toBeInstanceOf(ImportPlanConflictError)
  })

  it('fails terminally when a planned member has vanished', async () => {
    const plan = await planOf([
      { name: 'a.md', body: NOTE },
      { name: 'b.md', body: NOTE },
    ])
    const shrunk = await zipOf([{ name: 'a.md', body: NOTE }], 'shrunk.zip')

    await expect(
      runMarkdownTreePlan({ uploadPath: shrunk, plan, onEntry: async () => {} }),
    ).rejects.toThrow(/planned archive member is missing/)
  })

  it('stops the active member stream on cancel instead of waiting for the next boundary', async () => {
    const path = await zipOf([
      { name: 'a.md', body: NOTE },
      { name: 'b.md', body: NOTE },
    ])
    const classification = await classify(path)

    if (classification.kind !== 'markdown-tree') {
      throw new Error('expected a markdown tree')
    }
    const controller = new AbortController()
    const seen: string[] = []

    await expect(
      runMarkdownTreePlan({
        uploadPath: path,
        plan: classification.plan,
        signal: controller.signal,
        onEntry: async (_note, entry) => {
          seen.push(entry.archivePath)
          controller.abort()
        },
      }),
    ).rejects.toThrow(/canceled/)
    expect(seen).toEqual(['a.md'])
  })

  it('refuses to keep more than one member body at a time', async () => {
    const path = await zipOf([
      { name: 'a.md', body: NOTE },
      { name: 'b.md', body: NOTE },
      { name: 'c.md', body: NOTE },
    ])
    const classification = await classify(path)

    if (classification.kind !== 'markdown-tree') {
      throw new Error('expected a markdown tree')
    }
    let concurrent = 0
    let peak = 0

    await runMarkdownTreePlan({
      uploadPath: path,
      plan: classification.plan,
      onEntry: async () => {
        peak = Math.max(peak, ++concurrent)
        await new Promise((resolve) => setImmediate(resolve))
        concurrent--
      },
    })
    expect(peak).toBe(1)
  })
})

describe('the plan itself', () => {
  it('stores the root once rather than per entry', async () => {
    const plan = await planOf(
      [
        { name: 'a.md', body: NOTE },
        { name: 'b.md', body: '# B\n\nBeta.\n' },
      ],
      { root: 'a-very-long-destination-root/with/several/segments' },
    )

    // The metadata ceiling is about the plan's SHAPE: a long root repeated per
    // entry is what turns 10 000 addresses into megabytes.
    expect(plan.root).toBe('a-very-long-destination-root/with/several/segments')
    expect(JSON.stringify(plan.entries)).not.toContain('a-very-long-destination-root')
  })

  it('stores one canonical root spelling for writer replay', async () => {
    const plan = await planOf([{ name: 'vault/a.md', body: NOTE }], {
      root: 'imported//./2026/',
    })

    expect(plan.root).toBe('imported/2026')
  })

  it('carries no body bytes', async () => {
    const plan = await planOf([{ name: 'a.md', body: '# A\n\nSECRET-BODY-MARKER\n' }])

    expect(JSON.stringify(plan)).not.toContain('SECRET-BODY-MARKER')
  })
})
