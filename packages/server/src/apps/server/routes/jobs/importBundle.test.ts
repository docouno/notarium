import fastifyMultipart from '@fastify/multipart'
import AdmZip from 'adm-zip'
import { ZipArchive } from 'archiver'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FOLDER_MTIME_COMMENT_PREFIX } from '../../../../services/import'
import {
  ImportBundleError,
  type ImportBundleOptions,
  legacyMultipartBasename,
  receiveImportUpload,
} from './importBundle'

const BOUNDARY = '----notarium-folder-bundle-test'

type FieldPart = { field: string; value: string }
type FilePart = { field: string; filename: string; body: string | Buffer; mime?: string }
type Part = FieldPart | FilePart

const multipart = (parts: Part[]) => {
  const blocks: Buffer[] = []

  for (const part of parts) {
    if ('filename' in part) {
      blocks.push(
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.field}"; filename="${part.filename}"\r\nContent-Type: ${part.mime ?? 'application/octet-stream'}\r\n\r\n`,
        ),
        Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body),
        Buffer.from('\r\n'),
      )
    } else {
      blocks.push(
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.field}"\r\n\r\n${part.value}\r\n`,
        ),
      )
    }
  }
  blocks.push(Buffer.from(`--${BOUNDARY}--\r\n`))

  return {
    payload: Buffer.concat(blocks),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  }
}

const treeParts = (...files: FilePart[]): Part[] => [
  { field: 'bundle', value: 'markdown-tree' },
  { field: 'format', value: 'markdown' },
  ...files,
]

let dir: string
let app: FastifyInstance
let options: ImportBundleOptions
let rejectStage: Error | null
let seq: number
let writeCount: number

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notarium-folder-bundle-'))
  options = {}
  rejectStage = null
  seq = 0
  writeCount = 0
  app = Fastify()
  await app.register(fastifyMultipart, {
    limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 4 },
  })
  app.post('/', async (req, reply) => {
    try {
      return await receiveImportUpload(
        req,
        {
          write: async (source) => {
            writeCount++
            if (rejectStage) {
              throw rejectStage
            }
            const base = join(dir, `upload-${++seq}`)
            const part = `${base}.part`
            const final = `${base}.import`

            try {
              await pipeline(source, createWriteStream(part))
              await rename(part, final)
              return final
            } catch (error) {
              await rm(part, { force: true })
              throw error
            }
          },
          remove: (ref) => rm(ref, { force: true }),
        },
        options,
      )
    } catch (error) {
      if (error instanceof ImportBundleError) {
        return reply.code(error.statusCode).send({ error: error.message })
      }
      throw error
    }
  })
})

afterEach(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

const post = async (parts: Part[]) =>
  await app.inject({
    method: 'POST',
    url: '/',
    ...multipart(parts),
  })

const stagedFiles = async () => await readdir(dir)

describe('folder multipart bridge', () => {
  it('streams one encoded tree into one store-mode ZIP with exact private mtimes', async () => {
    const res = await post(
      treeParts(
        {
          field: 'entry:0',
          filename: 'vault%2Fasset.png',
          body: '',
        },
        {
          field: 'entry:1234',
          filename: 'vault%2F%C3%A9%2Fnote.txt',
          body: 'hello',
        },
      ),
    )

    expect(res.statusCode).toBe(200)
    const received = res.json<{ uploadRef: string; filename: string; sourceKind: string }>()

    expect(received).toMatchObject({ filename: 'folder-tree.zip', sourceKind: 'folder-tree' })
    expect(await stagedFiles()).toEqual(['upload-1.import'])
    const zip = new AdmZip(received.uploadRef)
    const entries = zip.getEntries()

    expect(entries.map((entry) => entry.entryName)).toEqual(['vault/asset.png', 'vault/é/note.txt'])
    expect(entries[0]!.getData()).toHaveLength(0)
    expect(entries[0]!.comment).toBe(`${FOLDER_MTIME_COMMENT_PREFIX}unknown`)
    expect(entries[1]!.getData().toString()).toBe('hello')
    expect(entries[1]!.comment).toBe(`${FOLDER_MTIME_COMMENT_PREFIX}1234`)
  })

  it('preserves the ordinary one-file wire and Busboy basename contract', async () => {
    const res = await post([
      { field: 'format', value: 'markdown' },
      {
        field: 'file',
        filename: String.raw`C:\fakepath\vault.md`,
        body: '# Vault',
      },
    ])

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ filename: 'vault.md', fields: { format: 'markdown' } })
  })

  it.each([
    ['/', ''],
    ['\\', ''],
    ['.', ''],
    ['..', ''],
    ['/vault.md', 'vault.md'],
    [String.raw`C:\fakepath\vault.md`, 'vault.md'],
  ])('matches the legacy basename for %j', (filename, expected) => {
    expect(legacyMultipartBasename(filename)).toBe(expected)
  })

  it.each([
    {
      name: 'a second file',
      parts: [
        { field: 'file', filename: 'a.md', body: 'a' },
        { field: 'file', filename: 'b.md', body: 'b' },
      ] as Part[],
    },
    {
      name: 'a late field',
      parts: [
        { field: 'file', filename: 'a.md', body: 'a' },
        { field: 'root', value: 'late' },
      ] as Part[],
    },
  ])('atomically refuses ordinary multipart with $name', async ({ parts }) => {
    const res = await post(parts)

    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toMatch(/exactly one file part/)
    expect(await stagedFiles()).toEqual([])
  })

  it.each([
    {
      name: 'ordinary upload',
      parts: [
        { field: 'root', value: '../unsafe' },
        { field: 'file', filename: 'a.md', body: 'a' },
      ] as Part[],
    },
    {
      name: 'folder upload',
      parts: [
        { field: 'bundle', value: 'markdown-tree' },
        { field: 'format', value: 'markdown' },
        { field: 'root', value: '../unsafe' },
        { field: 'entry:0', filename: 'a.md', body: 'a' },
      ] as Part[],
    },
  ])('validates prefix fields before staging an $name', async ({ parts }) => {
    options = {
      validateFields: (fields) => {
        if (fields.root === '../unsafe') {
          throw new ImportBundleError('bad import root')
        }
      },
    }
    const res = await post(parts)

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'bad import root' })
    expect(writeCount).toBe(0)
    expect(await stagedFiles()).toEqual([])
  })

  it('refuses a non-empty unsupported body and removes every staging artifact', async () => {
    const res = await post(
      treeParts({ field: 'entry:0', filename: 'vault%2Fasset.png', body: 'not empty' }),
    )

    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toMatch(/must have an empty body/)
    expect(await stagedFiles()).toEqual([])
  })

  it.each([
    ['bad percent encoding', 'vault%2', /percent-encoding/],
    ['normalizing path', 'vault%2F.%2Fa.md', /canonical and portable/],
    ['traversal', 'vault%2F..%2Fa.md', /canonical and portable/],
  ])('atomically refuses %s', async (_label, filename, message) => {
    const res = await post(treeParts({ field: 'entry:0', filename, body: 'x' }))

    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toMatch(message)
    expect(await stagedFiles()).toEqual([])
  })

  it('refuses decoded duplicate paths before producing a final bundle', async () => {
    const res = await post(
      treeParts(
        { field: 'entry:0', filename: 'vault%2Fa.md', body: 'a' },
        { field: 'entry:0', filename: 'vault%2Fa.md', body: 'b' },
      ),
    )

    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toMatch(/duplicate/)
    expect(await stagedFiles()).toEqual([])
  })

  it.each([
    {
      name: 'entry count',
      limits: { maxEntries: 1 },
      files: [
        { field: 'entry:0', filename: 'a.md', body: 'a' },
        { field: 'entry:0', filename: 'b.md', body: 'b' },
      ],
    },
    {
      name: 'one member',
      limits: { maxMemberBytes: 3 },
      files: [{ field: 'entry:0', filename: 'a.md', body: '1234' }],
    },
    {
      name: 'accepted aggregate',
      limits: { maxAggregateBytes: 5 },
      files: [
        { field: 'entry:0', filename: 'a.md', body: '123' },
        { field: 'entry:0', filename: 'b.md', body: '456' },
      ],
    },
  ])('enforces the independent $name ceiling', async ({ limits, files }) => {
    options = { limits }
    const res = await post(treeParts(...files))

    expect(res.statusCode).toBe(413)
    expect(await stagedFiles()).toEqual([])
  })

  it('enforces the metadata ceiling independently at the exact charge boundary', async () => {
    const path = 'a.md'
    const comment = `${FOLDER_MTIME_COMMENT_PREFIX}unknown`
    const charged = 2 * Buffer.byteLength(path) + Buffer.byteLength(path) + comment.length + 256

    options = { limits: { maxMetadataBytes: charged } }
    expect(
      (await post(treeParts({ field: 'entry:0', filename: path, body: 'a' }))).statusCode,
    ).toBe(200)
    options = { limits: { maxMetadataBytes: charged - 1 } }
    const refused = await post(treeParts({ field: 'entry:0', filename: path, body: 'a' }))

    expect(refused.statusCode).toBe(413)
  })

  it('accepts 65535 path bytes and refuses 65536 before ZIP truncation', async () => {
    const accepted = `${'a/'.repeat(32_765)}aa.md`
    const refused = `${'a/'.repeat(32_765)}aaa.md`

    expect(Buffer.byteLength(accepted)).toBe(65_535)
    const acceptedResult = await post(
      treeParts({ field: 'entry:0', filename: encodeURIComponent(accepted), body: 'a' }),
    )

    expect(acceptedResult.statusCode, acceptedResult.payload).toBe(200)
    const result = await post(
      treeParts({ field: 'entry:0', filename: encodeURIComponent(refused), body: 'a' }),
    )

    expect(result.statusCode).toBe(400)
    expect(result.json<{ error: string }>().error).toMatch(/too long for ZIP/)
  })

  it('accepts 65535 comment bytes and refuses 65536 before ZIP truncation', async () => {
    options = {
      commentForEntry: () => 'x'.repeat(65_535),
      limits: { maxMetadataBytes: 70_000 },
    }
    expect(
      (await post(treeParts({ field: 'entry:0', filename: 'a.md', body: 'a' }))).statusCode,
    ).toBe(200)
    options = {
      commentForEntry: () => 'x'.repeat(65_536),
      limits: { maxMetadataBytes: 70_000 },
    }
    const refused = await post(treeParts({ field: 'entry:0', filename: 'a.md', body: 'a' }))

    expect(refused.statusCode).toBe(400)
    expect(refused.json<{ error: string }>().error).toMatch(/metadata is too long for ZIP/)
  })

  it('observes stage rejection immediately without leaving a part or final file', async () => {
    rejectStage = Object.assign(new Error('staging EIO'), { code: 'EIO' })
    const res = await post(treeParts({ field: 'entry:0', filename: 'a.md', body: 'a' }))

    expect(res.statusCode).toBe(500)
    expect(await stagedFiles()).toEqual([])
  })

  it('removes the part when packer finalization rejects', async () => {
    options = {
      archiveFactory: () => {
        const archive = new ZipArchive({ store: true })

        archive.finalize = async () => {
          throw new Error('finalize failed')
        }

        return archive
      },
    }
    const res = await post(treeParts({ field: 'entry:0', filename: 'a.md', body: 'a' }))

    expect(res.statusCode).toBe(500)
    expect(await stagedFiles()).toEqual([])
  })

  it('removes staging when the packer rejects one entry before finalize', async () => {
    options = {
      archiveFactory: () => {
        const archive = new ZipArchive({ store: true })

        archive.append = (() => {
          throw new Error('append failed')
        }) as typeof archive.append

        return archive
      },
    }
    const res = await post(treeParts({ field: 'entry:0', filename: 'a.md', body: 'a' }))

    expect(res.statusCode).toBe(500)
    expect(await stagedFiles()).toEqual([])
  })

  it('aborts the active part and removes staging on a premature request', async () => {
    const raw = new PassThrough()
    const body = new PassThrough()
    const field = (fieldname: string, value: string) => ({
      type: 'field' as const,
      fieldname,
      value,
      fieldnameTruncated: false,
      valueTruncated: false,
    })
    const iterator = (async function* () {
      yield field('bundle', 'markdown-tree')
      yield field('format', 'markdown')
      yield {
        type: 'file' as const,
        fieldname: 'entry:0',
        filename: 'a.md',
        file: body,
      }
    })()
    const req = { raw, parts: () => iterator } as unknown as FastifyRequest
    const received = receiveImportUpload(req, {
      write: async (source) => {
        const part = join(dir, 'aborted.part')
        const final = join(dir, 'aborted.import')

        try {
          await pipeline(source, createWriteStream(part))
          await rename(part, final)
          return final
        } catch (error) {
          await rm(part, { force: true })
          throw error
        }
      },
      remove: (ref) => rm(ref, { force: true }),
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    body.write('partial body')
    raw.emit('aborted')
    await expect(received).rejects.toThrow(/aborted/)
    expect(await stagedFiles()).toEqual([])
  })
})
