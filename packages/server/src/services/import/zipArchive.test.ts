// The archive layer's own contracts: what a member's timestamp is allowed to be,
// and how far a cancel reaches.
//
// These need a ZIP written BY HAND. `adm-zip` and `archiver` emit no extra fields
// at all and refuse to write a fabricated calendar, so an archive built with them
// cannot reach the extended-timestamp reader or the DOS validation below — the
// branches would look covered while never executing. Every fixture here is
// therefore assembled from raw local headers, a central directory and an EOCD.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { forEachZipMember, openZip, withExtractedMember, type ZipMember } from './zipArchive'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notarium-zip-test-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

type RawMember = {
  name: string
  data?: Buffer
  /** The DOS date/time words, written verbatim — including impossible ones. */
  dosDate?: number
  dosTime?: number
  /** Central-directory extra field bytes. */
  extra?: Buffer
}

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

/** A stored-entry ZIP with full control over the fields a library would own. */
const rawZip = (members: RawMember[]): Buffer => {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8')
    const data = member.data ?? Buffer.alloc(0)
    const extra = member.extra ?? Buffer.alloc(0)
    const crc = crc32(data)
    const local = Buffer.alloc(30)

    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(member.dosTime ?? 0, 10)
    local.writeUInt16LE(member.dosDate ?? 0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // the extra field lives in the central directory only
    const block = Buffer.concat([local, name, data])
    const central = Buffer.alloc(46)

    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(member.dosTime ?? 0, 12)
    central.writeUInt16LE(member.dosDate ?? 0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(extra.length, 30)
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(offset, 42)
    locals.push(block)
    centrals.push(Buffer.concat([central, name, extra]))
    offset += block.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)

  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(members.length, 8)
  eocd.writeUInt16LE(members.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, directory, eocd])
}

const extraField = (id: number, data: Buffer): Buffer => {
  const header = Buffer.alloc(4)

  header.writeUInt16LE(id, 0)
  header.writeUInt16LE(data.length, 2)

  return Buffer.concat([header, data])
}

/** Info-ZIP `UT`: a flags byte (bit 0 = mtime present) plus a 32-bit epoch. */
const universalTime = (epochSeconds: number): Buffer => {
  const data = Buffer.alloc(5)

  data.writeUInt8(1, 0)
  data.writeInt32LE(epochSeconds, 1)

  return extraField(0x5455, data)
}

const NTFS_EPOCH_OFFSET_MS = 11_644_473_600_000

/** NTFS timestamps: 4 reserved bytes, tag 1 / size 24, then mtime/atime/ctime as
 *  100-nanosecond ticks since 1601. */
const ntfsTime = (ms: number): Buffer => {
  const data = Buffer.alloc(32)
  const ticks = BigInt(ms + NTFS_EPOCH_OFFSET_MS) * 10_000n

  data.writeUInt16LE(1, 4)
  data.writeUInt16LE(24, 6)
  data.writeUInt32LE(Number(ticks & 0xffffffffn), 8)
  data.writeInt32LE(Number(ticks >> 32n), 12)

  return extraField(0x000a, data)
}

const dosDate = (year: number, month: number, day: number): number =>
  ((year - 1980) << 9) | (month << 5) | day
const dosTime = (hour: number, minute: number, second: number): number =>
  (hour << 11) | (minute << 5) | (second >> 1)

const membersOf = async (members: RawMember[]): Promise<ZipMember[]> => {
  const path = join(dir, 'raw.zip')

  await writeFile(path, rawZip(members))
  const seen: ZipMember[] = []

  await forEachZipMember(await openZip(path), async (member) => {
    seen.push(member)

    return 'continue'
  })

  return seen
}

const modifiedAtOf = async (member: RawMember): Promise<string | null> =>
  (await membersOf([member]))[0].modifiedAt

const NOTE = Buffer.from('# Hello\n', 'utf8')

describe('a member’s modification time', () => {
  it('prefers a trustworthy extended timestamp over the DOS pair beside it', async () => {
    const modifiedAt = await modifiedAtOf({
      name: 'a.md',
      data: NOTE,
      // The DOS pair says 2001; the UT field — the only one carrying a real epoch
      // rather than a zone-less triple — says 2021, and it wins.
      dosDate: dosDate(2001, 1, 1),
      dosTime: dosTime(12, 0, 0),
      extra: universalTime(Math.floor(Date.parse('2021-07-08T09:10:00Z') / 1000)),
    })

    expect(modifiedAt).toBe('2021-07-08T09:10:00.000Z')
  })

  it('reads the NTFS extra field the Windows packers write', async () => {
    const modifiedAt = await modifiedAtOf({
      name: 'a.md',
      data: NOTE,
      extra: ntfsTime(Date.parse('2019-05-04T10:00:00Z')),
    })

    expect(modifiedAt?.slice(0, 19)).toBe('2019-05-04T10:00:00')
  })

  // A packer with a broken clock must cost the archive its extra field, not its
  // dates: `extended ?? dos` handed the vote to whichever field was PRESENT, so
  // one bad epoch stripped the creation date from every member of the upload.
  it('falls back to a valid DOS pair when the extended timestamp is not trustworthy', async () => {
    const future = Math.floor((Date.now() + 24 * 60 * 60_000) / 1000)
    const withFutureUt = await modifiedAtOf({
      name: 'a.md',
      data: NOTE,
      dosDate: dosDate(2021, 7, 8),
      dosTime: dosTime(9, 10, 0),
      extra: universalTime(future),
    })
    const withEpochZeroUt = await modifiedAtOf({
      name: 'a.md',
      data: NOTE,
      dosDate: dosDate(2021, 7, 8),
      dosTime: dosTime(9, 10, 0),
      extra: universalTime(0),
    })

    expect(withFutureUt).toBe('2021-07-08T09:10:00.000Z')
    expect(withEpochZeroUt).toBe('2021-07-08T09:10:00.000Z')
  })

  it('refuses a DOS pair that names no real calendar instant', async () => {
    // Date.UTC rolls each of these into a real instant instead of failing, which
    // is how a fabricated header became an authored-looking date downstream.
    const febThirty = await modifiedAtOf({
      name: 'a.md',
      data: NOTE,
      dosDate: dosDate(2021, 2, 30),
      dosTime: dosTime(9, 10, 0),
    })
    const thirteenthMonth = await modifiedAtOf({
      name: 'a.md',
      data: NOTE,
      dosDate: dosDate(2021, 13, 1),
      dosTime: dosTime(9, 10, 0),
    })
    const zerothDay = await modifiedAtOf({
      name: 'a.md',
      data: NOTE,
      dosDate: dosDate(2021, 6, 0),
      dosTime: dosTime(9, 10, 0),
    })

    expect(febThirty).toBeNull()
    expect(thirteenthMonth).toBeNull()
    expect(zerothDay).toBeNull()
  })

  // The DOS time word packs hour into 5 bits, minute into 6 and second into 5 (in
  // two-second steps), so every one of these is reachable by writing the header —
  // there is no encoding that forbids a 63rd minute. The calendar roll-over guard
  // does not answer them: a minute past 59 moves the HOUR and a second past 59 moves
  // the minute, and neither touches the day the other guard compares.
  it('refuses a DOS time whose fields are outside the clock', async () => {
    const twentyFifthHour = await modifiedAtOf({
      name: 'a.md',
      data: NOTE,
      dosDate: dosDate(2021, 7, 8),
      dosTime: dosTime(24, 10, 0),
    })
    const sixtyThirdMinute = await modifiedAtOf({
      name: 'a.md',
      data: NOTE,
      dosDate: dosDate(2021, 7, 8),
      dosTime: dosTime(9, 63, 0),
    })
    const sixtySecondSecond = await modifiedAtOf({
      name: 'a.md',
      data: NOTE,
      dosDate: dosDate(2021, 7, 8),
      dosTime: dosTime(9, 10, 62),
    })

    expect(twentyFifthHour).toBeNull()
    expect(sixtyThirdMinute).toBeNull()
    expect(sixtySecondSecond).toBeNull()
  })

  it('refuses a timestamp implausibly in the future, whichever field states it', async () => {
    const nextCentury = await modifiedAtOf({
      name: 'a.md',
      data: NOTE,
      dosDate: dosDate(2099, 6, 1),
      dosTime: dosTime(9, 10, 0),
    })
    const futureUtAlone = await modifiedAtOf({
      name: 'a.md',
      data: NOTE,
      extra: universalTime(Math.floor((Date.now() + 24 * 60 * 60_000) / 1000)),
    })

    expect(nextCentury).toBeNull()
    expect(futureUtAlone).toBeNull()
  })

  it('treats a zero DOS pair as "unknown" rather than as 1979', async () => {
    expect(await modifiedAtOf({ name: 'a.md', data: NOTE })).toBeNull()
  })
})

describe('withExtractedMember', () => {
  const useMember = async <T>(
    zipPath: string,
    use: (path: string, signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const zipfile = await openZip(zipPath)
    let out!: T

    await forEachZipMember(zipfile, async (_member, entry) => {
      out = await withExtractedMember(zipfile, entry, dir, () => {}, use, signal)

      return 'stop'
    })

    return out
  }

  // The expensive half of a probe is what it does to the extracted file, not the
  // extraction: a reader handed no signal keeps reading (and parsing) hundreds of
  // megabytes after the archive it came from was released on cancel.
  it('hands the reader the same signal the extraction was given', async () => {
    const path = join(dir, 'probe.zip')

    await writeFile(path, rawZip([{ name: 'data.json', data: Buffer.from('{"a":1}') }]))
    const controller = new AbortController()
    const seen = await useMember(path, async (_path, signal) => signal, controller.signal)

    expect(seen).toBe(controller.signal)
  })

  it('never reaches the reader when the import was already canceled', async () => {
    const path = join(dir, 'probe.zip')

    await writeFile(path, rawZip([{ name: 'data.json', data: Buffer.from('{"a":1}') }]))
    const controller = new AbortController()
    let used = false

    controller.abort()
    await expect(
      useMember(
        path,
        async () => {
          used = true
        },
        controller.signal,
      ),
    ).rejects.toThrow(/canceled/)
    expect(used).toBe(false)
  })
})
