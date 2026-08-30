// Build, serialize and read back one note's fields blob. The single implementation
// both engines share, so the column they write is byte-identical.
// canon: docs/note-model.md#note-ontology

import { type FrontmatterEntry, frontmatterEntryValue, utf8Bytes } from '../markdown'
import { FIELDS_BLOB_BYTE_CAP, isProjectedFieldKey } from './consts'
import type { NoteDetailFields, NoteFields } from './types'

// A note whose frontmatter carries no author key. The engine's DDL spells the same
// string by hand — a frozen ladder step cannot import — and adoption of such a note
// stands on the two being equal. Neither package may import the other, so the two are
// held equal where package lines are already crossed: test/enumDrift.test.ts, block
// `empty fields blob drift`. What `blob.test.ts` pins is this side of it — the exact
// bytes the builder emits for such a note.
const EMPTY_FIELDS_BLOB = '{"keys":{}}'

const BASE_BYTES = EMPTY_FIELDS_BLOB.length
const UNREADABLE_BYTES = ',"unreadable":[]'.length
const UNREADABLE_MORE_BYTES = ',"unreadableMore":'.length
const TRUNCATED_BYTES = ',"truncated":[]'.length
const TRUNCATED_MORE_BYTES = ',"truncatedMore":'.length

/** Printable ASCII that JSON quotes verbatim — everything except `"`, `\` and the
 *  control range. A string made only of these costs its own length plus the quotes,
 *  so its weight is an addition rather than a serialization. */
const VERBATIM_IN_JSON = /^[\x20\x21\x23-\x5B\x5D-\x7E]*$/

const jsonScalarBytes = (value: string): number =>
  VERBATIM_IN_JSON.test(value) ? value.length + 2 : utf8Bytes(JSON.stringify(value))

const jsonBytes = (value: string | string[]): number => {
  if (typeof value === 'string') {
    return jsonScalarBytes(value)
  }
  let bytes = 2 + Math.max(0, value.length - 1)

  for (const item of value) {
    bytes += jsonScalarBytes(item)
  }

  return bytes
}

const prefixSums = (weights: readonly number[]): number[] => {
  const sums = [0]

  for (const weight of weights) {
    sums.push(sums[sums.length - 1] + weight)
  }

  return sums
}

type ValueSlot = { key: string; value: string | string[] }

/** An empty blob's parsed form. */
const emptyNoteFields = (): NoteFields => ({
  keys: Object.create(null) as Record<string, string | string[]>,
})

/** Deterministic bytes: a fixed member order, empty lists and zero counters
 *  omitted. Any wobble here would make the index re-derive notes that did not
 *  change, because adoption compares this string. */
export const serializeNoteFields = (fields: NoteFields): string => {
  const ordered: Record<string, unknown> = { keys: fields.keys }

  if (fields.unreadable?.length) {
    ordered.unreadable = fields.unreadable
  }
  if (fields.unreadableMore) {
    ordered.unreadableMore = fields.unreadableMore
  }
  if (fields.truncated?.length) {
    ordered.truncated = fields.truncated
  }
  if (fields.truncatedMore) {
    ordered.truncatedMore = fields.truncatedMore
  }

  return JSON.stringify(ordered)
}

const stringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined
  }
  const out = value.filter((item): item is string => typeof item === 'string')

  return out.length ? out : undefined
}

const counter = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined

/** Read a stored blob back. A derived column that lost its shape degrades to "this
 *  note has no author keys" and re-derives on the next pass — throwing here would
 *  take the whole space down on a poll. */
export const parseNoteFields = (json: string): NoteFields => {
  let raw: unknown

  try {
    raw = JSON.parse(json)
  } catch {
    return emptyNoteFields()
  }
  if (!raw || typeof raw !== 'object') {
    return emptyNoteFields()
  }
  const source = (raw as { keys?: unknown }).keys
  const fields = emptyNoteFields()

  if (source && typeof source === 'object') {
    for (const key of Object.getOwnPropertyNames(source)) {
      const value = (source as Record<string, unknown>)[key]

      if (typeof value === 'string') {
        fields.keys[key] = value
      } else if (Array.isArray(value)) {
        fields.keys[key] = value.filter((item): item is string => typeof item === 'string')
      }
    }
  }
  const unreadable = stringList((raw as { unreadable?: unknown }).unreadable)
  const unreadableMore = counter((raw as { unreadableMore?: unknown }).unreadableMore)
  const truncated = stringList((raw as { truncated?: unknown }).truncated)
  const truncatedMore = counter((raw as { truncatedMore?: unknown }).truncatedMore)

  if (unreadable) {
    fields.unreadable = unreadable
  }
  if (unreadableMore) {
    fields.unreadableMore = unreadableMore
  }
  if (truncated) {
    fields.truncated = truncated
  }
  if (truncatedMore) {
    fields.truncatedMore = truncatedMore
  }

  return fields
}

/** Split the file's entries into the two states the column encodes, last-wins per
 *  key at the key's FIRST authored position (the same last-wins the frontmatter
 *  reader applies), with the keys the note projects onto its own metadata left out. */
const collect = (entries: readonly FrontmatterEntry[]) => {
  const order: string[] = []
  const seen = new Map<string, string | string[] | null>()

  for (const entry of entries) {
    if (!entry.key || isProjectedFieldKey(entry.key)) {
      continue
    }
    if (!seen.has(entry.key)) {
      order.push(entry.key)
    }
    seen.set(entry.key, frontmatterEntryValue(entry))
  }
  const values: ValueSlot[] = []
  const unreadable: string[] = []

  for (const key of order) {
    const value = seen.get(key)

    if (value == null) {
      unreadable.push(key)
    } else {
      values.push({ key, value })
    }
  }

  return { values, unreadable }
}

/** A blob before the cap has spoken: keys that still carry a value (authored order),
 *  names already known dropped or unreadable, and the two counters. `build` starts
 *  from a file's entries with nothing carried; a patch starts from a merge that may
 *  carry all five. Both go through `applyCap` — the cap has exactly one home. */
type UncappedFields = {
  values: readonly ValueSlot[]
  truncated: readonly string[]
  unreadable: readonly string[]
  truncatedMore: number
  unreadableMore: number
}

/** Enforce the byte cap and produce the blob and its bytes in one pass.
 *
 *  The cap is an invariant over the SERIALIZED object — `utf8Bytes(json) <= CAP` —
 *  never a per-part budget, and it is checked, not assumed: the sacrifice sequence
 *  is walked by analytic weights and the configuration that walk settles on is then
 *  measured for real. The weights are what keeps the walk affordable, and that is
 *  the reason every byte count in this module is computed rather than serialized:
 *  the inputs the cap exists for carry thousands of keys, so serializing the whole
 *  object once per dropped element is quadratic and turns one upsert into seconds.
 *
 *  Byte size is not monotone along that sequence (the first drop introduces a list
 *  wrapper), so progress is counted in ELEMENTS, which strictly decrease down to a
 *  configuration that is provably under the cap.
 *
 *  `undercount` exists for the gate alone — see `measureCappedNoteFields`. */
const applyCap = (
  input: UncappedFields,
  undercount = 0,
): { fields: NoteFields; json: string; analyticBytes: number } => {
  const { values, unreadable } = input
  const valueWeights = values.map((slot) => jsonBytes(slot.key) + 1 + jsonBytes(slot.value))
  const nameWeights = values.map((slot) => jsonBytes(slot.key))
  const carriedWeights = input.truncated.map((key) => jsonBytes(key))
  const unreadableWeights = unreadable.map((key) => jsonBytes(key))
  const valueSums = prefixSums(valueWeights)
  const nameSums = prefixSums(nameWeights)
  const carriedSums = prefixSums(carriedWeights)
  const unreadableSums = prefixSums(unreadableWeights)
  const carried = input.truncated.length

  let kept = values.length
  let truncatedShown = carried
  let unreadableShown = unreadable.length

  const truncatedMore = () =>
    input.truncatedMore + carried + (values.length - kept) - truncatedShown
  const unreadableMore = () => input.unreadableMore + unreadable.length - unreadableShown
  // Names carried in come first, names the cap just demoted follow — one list, so the
  // shown prefix and its weight are read the same way whichever side they fall on.
  const truncatedNameBytes = () =>
    truncatedShown <= carried
      ? carriedSums[truncatedShown]
      : carriedSums[carried] + nameSums[kept + truncatedShown - carried] - nameSums[kept]

  const analyticBytes = (): number => {
    let bytes = BASE_BYTES

    if (kept) {
      bytes += valueSums[kept] + kept - 1
    }
    if (unreadableShown) {
      bytes += UNREADABLE_BYTES + unreadableSums[unreadableShown] + unreadableShown - 1
    }
    if (unreadableMore()) {
      bytes += UNREADABLE_MORE_BYTES + String(unreadableMore()).length
    }
    if (truncatedShown) {
      bytes += TRUNCATED_BYTES + truncatedNameBytes() + truncatedShown - 1
    }
    if (truncatedMore()) {
      bytes += TRUNCATED_MORE_BYTES + String(truncatedMore()).length
    }

    return bytes
  }

  // Values first (a reader re-reads them from the file), then names the cap
  // dropped, then names that were unreadable — the only carrier of `fieldBad`.
  const sacrifice = (): boolean => {
    if (kept > 0) {
      kept--
      truncatedShown++
      return true
    }
    if (truncatedShown > 0) {
      truncatedShown--
      return true
    }
    if (unreadableShown > 0) {
      unreadableShown--
      return true
    }

    return false
  }

  const assemble = (): NoteFields => {
    const fields = emptyNoteFields()

    for (let i = 0; i < kept; i++) {
      fields.keys[values[i].key] = values[i].value
    }
    if (unreadableShown) {
      fields.unreadable = unreadable.slice(0, unreadableShown)
    }
    if (unreadableMore()) {
      fields.unreadableMore = unreadableMore()
    }
    if (truncatedShown) {
      fields.truncated =
        truncatedShown <= carried
          ? input.truncated.slice(0, truncatedShown)
          : [
              ...input.truncated,
              ...values.slice(kept, kept + truncatedShown - carried).map((slot) => slot.key),
            ]
    }
    if (truncatedMore()) {
      fields.truncatedMore = truncatedMore()
    }

    return fields
  }

  while (analyticBytes() - undercount > FIELDS_BLOB_BYTE_CAP && sacrifice()) {
    // walk the sequence by weights; the measurement below is the actual gate
  }
  let fields = assemble()
  let json = serializeNoteFields(fields)

  while (utf8Bytes(json) > FIELDS_BLOB_BYTE_CAP && sacrifice()) {
    fields = assemble()
    json = serializeNoteFields(fields)
  }

  return { fields, json, analyticBytes: analyticBytes() }
}

const NOTHING_CARRIED: readonly string[] = []

const collected = (entries: readonly FrontmatterEntry[]): UncappedFields => {
  const { values, unreadable } = collect(entries)

  return { values, unreadable, truncated: NOTHING_CARRIED, truncatedMore: 0, unreadableMore: 0 }
}

/** One note's author frontmatter as the index carries it, under the byte cap. */
export const buildNoteFields = (entries: readonly FrontmatterEntry[]): NoteFields =>
  applyCap(collected(entries)).fields

/** Build the note-detail projection from the same collection and cap pass as the
 * index blob. Detail values stay complete; the cap result is retained only as
 * metadata explaining which field queries cannot be answered from the index. */
export const buildNoteDetailFields = (entries: readonly FrontmatterEntry[]): NoteDetailFields => {
  const input = collected(entries)
  const capped = applyCap(input).fields
  const keys = Object.create(null) as Record<string, string | string[]>
  const order: string[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    if (entry.key && !seen.has(entry.key)) {
      seen.add(entry.key)
      order.push(entry.key)
    }
  }
  for (const slot of input.values) {
    keys[slot.key] = slot.value
  }

  return {
    keys,
    ...(input.unreadable.length ? { unreadable: [...input.unreadable] } : {}),
    ...(capped.unreadableMore ? { unreadableMore: capped.unreadableMore } : {}),
    ...(capped.truncated?.length ? { truncated: [...capped.truncated] } : {}),
    ...(capped.truncatedMore ? { truncatedMore: capped.truncatedMore } : {}),
    order,
  }
}

/** The same thing already serialized — what the column stores and what row
 *  adoption compares against. */
export const buildNoteFieldsBlob = (entries: readonly FrontmatterEntry[]): string =>
  applyCap(collected(entries)).json

/** Overlay incoming authored entries on a previous projection, KEY BY KEY — the
 *  optimistic mirror of how the serializer merges: a key the write does not mention
 *  stays on disk, so it must stay in the snapshot too. A key the write does mention
 *  takes its new state — value, unreadable or dropped by the cap — and stops being
 *  reported in whichever list it used to sit in.
 *
 *  What a projection cannot carry, it cannot mirror: `unreadable` and `truncated` are
 *  lists of NAMES with no positions, so a key that leaves or enters one of them lands
 *  wherever this merge can put it rather than where the file has it. Below the cap
 *  that is the ONLY thing that separates these bytes from a fresh derivation; at the
 *  cap the whole composition is the file's to decide, at the next poll. */
const mergedOnto = (previous: NoteFields, entries: readonly FrontmatterEntry[]): UncappedFields => {
  const incoming = buildNoteFields(entries)
  const incomingKeys = Object.getOwnPropertyNames(incoming.keys)
  const restated = new Set<string>([
    ...incomingKeys,
    ...(incoming.unreadable ?? []),
    ...(incoming.truncated ?? []),
  ])
  // A restated key keeps the SLOT it already held, exactly as the serializer's `put`
  // replaces a key at its first live occurrence and appends only a genuinely new one.
  // The slot is not cosmetic: the cap sacrifices from the tail of this order, so
  // appending a restated key would truncate a different key here than on disk.
  const taken = new Set<string>()
  const values: ValueSlot[] = []

  const carry = (key: string) => {
    if (taken.has(key)) {
      return
    }
    taken.add(key)
    if (Object.hasOwn(incoming.keys, key)) {
      values.push({ key, value: incoming.keys[key] })
    } else if (!restated.has(key) && Object.hasOwn(previous.keys, key)) {
      values.push({ key, value: previous.keys[key] })
    }
  }

  for (const key of Object.getOwnPropertyNames(previous.keys)) {
    carry(key)
  }
  for (const key of incomingKeys) {
    carry(key)
  }

  return {
    values,
    unreadable: [
      ...(previous.unreadable ?? []).filter((key) => !restated.has(key)),
      ...(incoming.unreadable ?? []),
    ],
    truncated: [
      ...(previous.truncated ?? []).filter((key) => !restated.has(key)),
      ...(incoming.truncated ?? []),
    ],
    truncatedMore: (previous.truncatedMore ?? 0) + (incoming.truncatedMore ?? 0),
    unreadableMore: (previous.unreadableMore ?? 0) + (incoming.unreadableMore ?? 0),
  }
}

/** The snapshot a write leaves behind before the next poll re-derives one from the
 *  file: the previous projection with the written entries merged onto it.
 *
 *  The merge can only grow the blob, so it ends where a build does: at the cap, with
 *  the same sacrifice order. Returning the merge unmeasured would let a series of
 *  writes walk the snapshot past the per-note memory ceiling the cap exists to be. */
export const patchNoteFields = (
  previous: NoteFields | undefined,
  entries: readonly FrontmatterEntry[],
): NoteFields =>
  previous ? applyCap(mergedOnto(previous, entries)).fields : buildNoteFields(entries)

/** The cap walk laid open for the one gate that can pin it: the bytes its analytic
 *  weights claimed for the configuration it settled on, next to the configuration
 *  itself. Those two numbers must be EQUAL, and no caller of the functions above can
 *  see whether they are — the measuring pass inside `applyCap` silently repairs a
 *  weight that lies, so a wrong weight and an exact one produce the same blob.
 *
 *  `undercount` makes the walk stop that many bytes early, which is the only way to
 *  reach that measuring pass: weights this exact make it unreachable on real input,
 *  and code no test can enter is indistinguishable from code that was deleted.
 *
 *  Host-internal test seam. Production calls `buildNoteFieldsBlob`/`patchNoteFields`,
 *  which is this same path with `undercount` at zero. */
export const measureCappedNoteFields = (
  previous: NoteFields | undefined,
  entries: readonly FrontmatterEntry[],
  undercount = 0,
): { json: string; analyticBytes: number } =>
  applyCap(previous ? mergedOnto(previous, entries) : collected(entries), undercount)
