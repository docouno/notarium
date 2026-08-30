import { join } from 'node:path'

import {
  FIELD_SCHEMA_MAX_BYTES,
  FIELD_SCHEMA_VERSION,
  type FieldDeclaration,
  type FieldSchema,
} from '@notarium/core'
import {
  createLocalFsFiles,
  type FileClaim,
  type FileResourceObservation,
  type FileResourcePublication,
} from '@notarium/engine'

import { FIELD_SCHEMA_STATUS, type FieldSchemaStatus } from './consts'
import { parseFieldSchemaFile, writeFieldSchemaFile } from './schemaFile'

const SCHEMA_DIR = '.notarium/fields'
const SCHEMA_FILE = 'schema.yaml'
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export type FieldSchemaSnapshot = {
  version: number
  fields: FieldDeclaration[]
  versionToken: string
  /** Host-internal read classification. REST schemas deliberately omit it. */
  status: FieldSchemaStatus
  readOnly?: true
  error?: string
}

export type FieldSchemaUpdate = FieldSchema & { versionToken: string }
export type FieldSchemaUpdateResult =
  | { status: 'saved'; current: FieldSchemaSnapshot }
  | { status: 'invalid'; error: string; current: FieldSchemaSnapshot }
  | {
      status: 'conflict'
      reason: 'field_schema_conflict' | 'field_schema_read_only'
      current: FieldSchemaSnapshot
    }

export type FieldSchemaStore = {
  read(space: string): Promise<FieldSchemaSnapshot>
  update(space: string, input: FieldSchemaUpdate): Promise<FieldSchemaUpdateResult>
  clear(space?: string): void
}

type AdapterEntry = {
  root: string
  observation?: FileResourceObservation
  publication?: FileResourcePublication
}
type CachedRead = { token: string; raw: string; snapshot: FieldSchemaSnapshot }
type ReadState = {
  snapshot: FieldSchemaSnapshot
  claim?: FileClaim
  raw?: string
  adapter?: AdapterEntry
}

const cloneFields = (fields: readonly FieldDeclaration[]): FieldDeclaration[] =>
  fields.map((field) => ({
    ...field,
    ...(field.values ? { values: field.values.map((value) => ({ ...value })) } : {}),
  }))

const cloneSnapshot = (snapshot: FieldSchemaSnapshot): FieldSchemaSnapshot => ({
  ...snapshot,
  fields: cloneFields(snapshot.fields),
})

const tokenOf = (claim: FileClaim): string =>
  `fc1:${Buffer.from(JSON.stringify(claim), 'utf8').toString('base64url')}`

const emptySnapshot = (versionToken: string): FieldSchemaSnapshot => ({
  version: FIELD_SCHEMA_VERSION,
  fields: [],
  versionToken,
  status: FIELD_SCHEMA_STATUS.ready,
})

const errorSnapshot = (
  message: string,
  versionToken = 'unavailable',
  status: Extract<
    FieldSchemaStatus,
    'unavailable' | 'structural-error'
  > = FIELD_SCHEMA_STATUS.unavailable,
): FieldSchemaSnapshot => ({
  version: FIELD_SCHEMA_VERSION,
  fields: [],
  versionToken,
  status,
  readOnly: true,
  error: message,
})

export const createFieldSchemaStore = (
  notesDirFor: (space: string) => string | null,
): FieldSchemaStore => {
  const adapters = new Map<string, AdapterEntry>()
  const reads = new Map<string, CachedRead>()

  const adapterFor = (space: string): AdapterEntry | null => {
    const notesDir = notesDirFor(space)

    if (!notesDir) {
      return null
    }
    const root = join(notesDir, SCHEMA_DIR)
    const cached = adapters.get(space)

    if (cached?.root === root) {
      return cached
    }
    const assembly = createLocalFsFiles(root)
    const entry: AdapterEntry = {
      root,
      observation: assembly.capabilities.resourceObservation,
      publication: assembly.capabilities.resourcePublication,
    }
    adapters.set(space, entry)
    reads.delete(space)
    return entry
  }

  const readState = async (space: string): Promise<ReadState> => {
    const adapter = adapterFor(space)

    if (!adapter?.observation) {
      reads.delete(space)
      return { snapshot: errorSnapshot(`field schema storage is unavailable for space ${space}`) }
    }
    try {
      const observation = await adapter.observation.observe(SCHEMA_FILE, {
        maxBytes: FIELD_SCHEMA_MAX_BYTES,
      })

      if (observation.kind === 'absent') {
        reads.delete(space)
        return {
          snapshot: emptySnapshot(tokenOf(observation.claim)),
          claim: observation.claim,
          adapter,
        }
      }
      if (observation.kind === 'occupied') {
        adapters.delete(space)
        reads.delete(space)
        return {
          snapshot: errorSnapshot(
            `schema.yaml is occupied by a ${observation.entryType}`,
            tokenOf(observation.claim),
          ),
          claim: observation.claim,
          adapter,
        }
      }
      if (observation.kind === 'unavailable') {
        adapters.delete(space)
        reads.delete(space)
        return {
          snapshot: errorSnapshot(
            observation.reason === 'too-large'
              ? `schema.yaml is too large (maximum ${FIELD_SCHEMA_MAX_BYTES} bytes)`
              : `schema.yaml is unavailable: ${observation.reason}`,
          ),
        }
      }
      const token = tokenOf(observation.claim)
      const cached = reads.get(space)

      if (cached?.token === token) {
        return {
          snapshot: cloneSnapshot(cached.snapshot),
          claim: observation.claim,
          raw: cached.raw,
          adapter,
        }
      }
      let raw: string

      try {
        raw = decoder.decode(observation.bytes)
      } catch {
        reads.delete(space)
        return {
          snapshot: errorSnapshot(
            'schema.yaml is not valid UTF-8',
            token,
            FIELD_SCHEMA_STATUS.structuralError,
          ),
          claim: observation.claim,
          adapter,
        }
      }
      const parsed = parseFieldSchemaFile(raw)
      const snapshot: FieldSchemaSnapshot = {
        version: parsed.schema.version,
        fields: parsed.schema.fields,
        versionToken: token,
        status: parsed.status,
        ...(parsed.readOnly ? { readOnly: true as const } : {}),
        ...(parsed.issues.length ? { error: parsed.issues.join('; ') } : {}),
      }
      reads.set(space, { token, raw, snapshot: cloneSnapshot(snapshot) })
      return { snapshot, claim: observation.claim, raw, adapter }
    } catch (error) {
      // localFs memoises a failed recovery promise. Drop this adapter so the next
      // call, after a transient host error is fixed, creates a fresh one.
      adapters.delete(space)
      reads.delete(space)
      return {
        snapshot: errorSnapshot(`schema.yaml could not be read: ${(error as Error).message}`),
      }
    }
  }

  return {
    read: async (space) => cloneSnapshot((await readState(space)).snapshot),

    update: async (space, input) => {
      const current = await readState(space)

      if (current.snapshot.readOnly || !current.claim || !current.adapter?.publication) {
        return {
          status: 'conflict',
          reason: 'field_schema_read_only',
          current: cloneSnapshot(current.snapshot),
        }
      }
      if (input.versionToken !== current.snapshot.versionToken) {
        return {
          status: 'conflict',
          reason: 'field_schema_conflict',
          current: cloneSnapshot(current.snapshot),
        }
      }
      const raw = writeFieldSchemaFile(current.raw, {
        version: input.version,
        fields: input.fields,
      })
      const candidate = parseFieldSchemaFile(raw)

      if (candidate.status !== FIELD_SCHEMA_STATUS.ready || candidate.issues.length > 0) {
        return {
          status: 'invalid',
          error: candidate.issues.join('; ') || 'field schema is invalid',
          current: cloneSnapshot(current.snapshot),
        }
      }
      const bytes = encoder.encode(raw)

      if (bytes.byteLength > FIELD_SCHEMA_MAX_BYTES) {
        return {
          status: 'invalid',
          error: `serialized field schema exceeds ${FIELD_SCHEMA_MAX_BYTES} bytes`,
          current: cloneSnapshot(current.snapshot),
        }
      }
      const publication = await current.adapter.publication.publish({
        kind: 'put',
        path: SCHEMA_FILE,
        content: bytes,
        expected: current.claim,
      })

      if (publication.status === 'conflict') {
        const latest = await readState(space)
        return {
          status: 'conflict',
          reason: 'field_schema_conflict',
          current: cloneSnapshot(latest.snapshot),
        }
      }
      const transition = publication.transitions.find((item) => item.path === SCHEMA_FILE)

      if (!transition) {
        throw new Error('field schema publication returned no file transition')
      }
      const snapshot: FieldSchemaSnapshot = {
        version: candidate.schema.version,
        fields: cloneFields(candidate.schema.fields),
        versionToken: tokenOf(transition.after),
        status: FIELD_SCHEMA_STATUS.ready,
      }
      reads.set(space, { token: snapshot.versionToken, raw, snapshot: cloneSnapshot(snapshot) })
      return { status: 'saved', current: snapshot }
    },

    clear: (space) => {
      if (space === undefined) {
        adapters.clear()
        reads.clear()
      } else {
        adapters.delete(space)
        reads.delete(space)
      }
    },
  }
}

/** Stateful fake counterpart: the transport and providers exercise the same
 * service contract without inventing a fake route or a fake filesystem. */
export const createInMemoryFieldSchemaStore = (): FieldSchemaStore & {
  seed(space: string, schema?: FieldSchema): void
  seedRaw(space: string, raw: string): void
} => {
  const entries = new Map<string, { revision: number; schema: FieldSchema }>()
  const rawEntries = new Map<string, { revision: number; raw: string }>()

  const snapshotOf = (space: string): FieldSchemaSnapshot => {
    const rawEntry = rawEntries.get(space)

    if (rawEntry) {
      const parsed = parseFieldSchemaFile(rawEntry.raw)
      return {
        version: parsed.schema.version,
        fields: cloneFields(parsed.schema.fields),
        versionToken: `memory:${space}:${rawEntry.revision}`,
        status: parsed.status,
        ...(parsed.readOnly ? { readOnly: true as const } : {}),
        ...(parsed.issues.length ? { error: parsed.issues.join('; ') } : {}),
      }
    }
    const entry = entries.get(space) ?? {
      revision: 0,
      schema: { version: FIELD_SCHEMA_VERSION, fields: [] },
    }
    const future = entry.schema.version > FIELD_SCHEMA_VERSION
    return {
      version: entry.schema.version,
      fields: cloneFields(entry.schema.fields),
      versionToken: `memory:${space}:${entry.revision}`,
      status: future ? FIELD_SCHEMA_STATUS.futureVersion : FIELD_SCHEMA_STATUS.ready,
      ...(future
        ? {
            readOnly: true as const,
            error: `schema version ${entry.schema.version} is newer than supported version ${FIELD_SCHEMA_VERSION}`,
          }
        : {}),
    }
  }

  return {
    read: async (space) => snapshotOf(space),
    update: async (space, input) => {
      const current = snapshotOf(space)

      if (current.readOnly) {
        return { status: 'conflict', reason: 'field_schema_read_only', current }
      }
      if (input.versionToken !== current.versionToken) {
        return { status: 'conflict', reason: 'field_schema_conflict', current }
      }
      const raw = writeFieldSchemaFile(undefined, {
        version: input.version,
        fields: input.fields,
      })
      const candidate = parseFieldSchemaFile(raw)

      if (candidate.status !== FIELD_SCHEMA_STATUS.ready || candidate.issues.length > 0) {
        return {
          status: 'invalid',
          error: candidate.issues.join('; ') || 'field schema is invalid',
          current,
        }
      }

      if (encoder.encode(raw).byteLength > FIELD_SCHEMA_MAX_BYTES) {
        return {
          status: 'invalid',
          error: `serialized field schema exceeds ${FIELD_SCHEMA_MAX_BYTES} bytes`,
          current,
        }
      }
      const previousRevision = entries.get(space)?.revision ?? rawEntries.get(space)?.revision ?? 0
      rawEntries.delete(space)
      entries.set(space, {
        revision: previousRevision + 1,
        schema: {
          version: candidate.schema.version,
          fields: cloneFields(candidate.schema.fields),
        },
      })
      return { status: 'saved', current: snapshotOf(space) }
    },
    clear: (space) => {
      if (space === undefined) {
        entries.clear()
        rawEntries.clear()
      } else {
        entries.delete(space)
        rawEntries.delete(space)
      }
    },
    seed: (space, schema) => {
      if (!schema) {
        entries.delete(space)
        rawEntries.delete(space)
        return
      }
      rawEntries.delete(space)
      entries.set(space, { revision: 1, schema: { ...schema, fields: cloneFields(schema.fields) } })
    },
    seedRaw: (space, raw) => {
      entries.delete(space)
      rawEntries.set(space, { revision: 1, raw })
    },
  }
}
