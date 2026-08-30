import {
  type Document,
  isMap,
  isSeq,
  type Node,
  parseDocument,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml'

import {
  FIELD_COLOR,
  FIELD_SCHEMA_MAX_FIELDS,
  FIELD_SCHEMA_MAX_VALUES,
  FIELD_SCHEMA_VERSION,
  FIELD_TYPE,
  type FieldDeclaration,
  fieldDisplayName,
  type FieldEnumOption,
  fieldEnumOptionDisplayName,
  type FieldSchema,
  isDurableScalar,
  isWritableFieldKey,
  normalizeFieldDisplayName,
  PROTECTED_FIELD_KEYS,
} from '@notarium/core'

import { FIELD_SCHEMA_STATUS, type FieldSchemaStatus } from './consts'

export type ParsedFieldSchemaFile = {
  schema: FieldSchema
  issues: string[]
  readOnly: boolean
  status: Exclude<FieldSchemaStatus, 'unavailable'>
}

const EMPTY_SCHEMA = (): FieldSchema => ({ version: FIELD_SCHEMA_VERSION, fields: [] })
const protectedKeys = new Set<string>(PROTECTED_FIELD_KEYS)
const fieldTypes = new Set<string>(Object.values(FIELD_TYPE))
const fieldColors = new Set<string>(Object.values(FIELD_COLOR))

type MapNode = YAMLMap<unknown, unknown>
type SeqNode = YAMLSeq<unknown>

const nodeAt = (map: MapNode, key: string): unknown => map.get(key, true)
const valueAt = (map: MapNode, key: string): unknown => map.get(key)

const structuralError = (message: string): ParsedFieldSchemaFile => ({
  schema: EMPTY_SCHEMA(),
  issues: [message],
  readOnly: true,
  status: FIELD_SCHEMA_STATUS.structuralError,
})

const fieldOf = (node: MapNode, index: number, issues: string[]): FieldDeclaration | null => {
  const key = valueAt(node, 'key')
  const type = valueAt(node, 'type')

  if (typeof key !== 'string') {
    return null
  }
  if (!isWritableFieldKey(key)) {
    issues.push(`fields[${index}].key is not a safe plain YAML mapping key: ${key}`)
    return null
  }
  if (protectedKeys.has(key)) {
    issues.push(`fields[${index}].key is protected: ${key}`)
    return null
  }
  if (typeof type !== 'string' || !fieldTypes.has(type)) {
    issues.push(`fields[${index}].type is unknown for ${key}`)
    return null
  }
  const label = valueAt(node, 'label')
  const card = valueAt(node, 'card')

  if (label !== undefined && (typeof label !== 'string' || !isDurableScalar(label))) {
    issues.push(`fields[${index}].label must be a single-line durable string for ${key}`)
    return null
  }
  if (card !== undefined && typeof card !== 'boolean') {
    issues.push(`fields[${index}].card must be a boolean for ${key}`)
    return null
  }
  const declaration: FieldDeclaration = {
    key,
    type: type as FieldDeclaration['type'],
    ...(label !== undefined ? { label } : {}),
    ...(card !== undefined ? { card } : {}),
  }
  const valuesNode = nodeAt(node, 'values')

  if (type !== FIELD_TYPE.enum) {
    if (valuesNode !== undefined) {
      issues.push(`fields[${index}].values are supported only for enum field ${key}`)
      return null
    }

    return declaration
  }
  if (valuesNode === undefined) {
    return declaration
  }
  if (!isSeq(valuesNode)) {
    issues.push(`fields[${index}].values must be a sequence for ${key}`)
    return null
  }
  const values: FieldEnumOption[] = []
  const seen = new Set<string>()
  const names = new Set<string>()
  const valueCount = Math.min(valuesNode.items.length, FIELD_SCHEMA_MAX_VALUES)

  if (valuesNode.items.length > FIELD_SCHEMA_MAX_VALUES) {
    issues.push(`fields[${index}].values exceeds the ${FIELD_SCHEMA_MAX_VALUES}-value limit`)
  }

  for (let valueIndex = 0; valueIndex < valueCount; valueIndex++) {
    const item = valuesNode.items[valueIndex]

    if (!isMap(item)) {
      issues.push(`fields[${index}].values[${valueIndex}] must be a mapping`)
      continue
    }
    const optionKey = valueAt(item, 'key')
    const optionLabel = valueAt(item, 'label')
    const color = valueAt(item, 'color')

    if (typeof optionKey !== 'string' || !isDurableScalar(optionKey)) {
      issues.push(`fields[${index}].values[${valueIndex}].key must be a single-line durable string`)
      continue
    }
    if (seen.has(optionKey)) {
      issues.push(`fields[${index}] has duplicate enum key: ${optionKey}`)
      continue
    }
    seen.add(optionKey)
    if (
      optionLabel !== undefined &&
      (typeof optionLabel !== 'string' || !isDurableScalar(optionLabel))
    ) {
      issues.push(
        `fields[${index}].values[${valueIndex}].label must be a single-line durable string`,
      )
      continue
    }
    if (color !== undefined && (typeof color !== 'string' || !fieldColors.has(color))) {
      issues.push(`fields[${index}].values[${valueIndex}].color is unknown for ${optionKey}`)
      continue
    }
    const option: FieldEnumOption = {
      key: optionKey,
      ...(optionLabel !== undefined ? { label: optionLabel } : {}),
      ...(color !== undefined ? { color: color as FieldEnumOption['color'] } : {}),
    }
    const name = normalizeFieldDisplayName(fieldEnumOptionDisplayName(option))

    if (names.has(name)) {
      issues.push(
        `fields[${index}].values[${valueIndex}] has duplicate enum value name: ${fieldEnumOptionDisplayName(option)}`,
      )
      continue
    }
    names.add(name)
    values.push(option)
  }
  declaration.values = values
  return declaration
}

export const parseFieldSchemaFile = (raw: string): ParsedFieldSchemaFile => {
  const doc = parseDocument(raw, { prettyErrors: false })

  if (doc.errors.length) {
    return structuralError('schema.yaml is not valid YAML')
  }
  if (!isMap(doc.contents)) {
    return structuralError('schema.yaml root must be a mapping')
  }
  const version = valueAt(doc.contents, 'version')

  if (typeof version !== 'number' || !Number.isInteger(version) || version <= 0) {
    return structuralError('schema.yaml version must be a positive integer')
  }
  const fieldsNode = nodeAt(doc.contents, 'fields')

  if (!isSeq(fieldsNode)) {
    return structuralError('schema.yaml fields must be a sequence')
  }
  // A missing key makes the document unaddressable for the node-diff writer. It
  // is structural, not one declaration that can be skipped safely.
  for (let index = 0; index < fieldsNode.items.length; index++) {
    const item = fieldsNode.items[index]

    if (!isMap(item) || typeof valueAt(item, 'key') !== 'string') {
      return structuralError(`schema.yaml fields[${index}] must be a mapping with a string key`)
    }
  }
  const fieldCount = Math.min(fieldsNode.items.length, FIELD_SCHEMA_MAX_FIELDS)
  const issues: string[] = []
  const fields: FieldDeclaration[] = []
  const seen = new Set<string>()
  const names = new Set<string>()

  if (fieldsNode.items.length > FIELD_SCHEMA_MAX_FIELDS) {
    issues.push(`fields exceeds the ${FIELD_SCHEMA_MAX_FIELDS}-field limit`)
  }

  for (let index = 0; index < fieldCount; index++) {
    const declaration = fieldOf(fieldsNode.items[index] as MapNode, index, issues)

    if (!declaration) {
      continue
    }
    if (seen.has(declaration.key)) {
      issues.push(`fields[${index}] has duplicate field key: ${declaration.key}`)
      continue
    }
    seen.add(declaration.key)
    const name = normalizeFieldDisplayName(fieldDisplayName(declaration))

    if (names.has(name)) {
      issues.push(`fields[${index}] has duplicate field name: ${fieldDisplayName(declaration)}`)
      continue
    }
    names.add(name)
    fields.push(declaration)
  }
  if (version > FIELD_SCHEMA_VERSION) {
    issues.unshift(
      `schema.yaml version ${version} is newer than supported version ${FIELD_SCHEMA_VERSION}`,
    )
  }

  return {
    schema: { version, fields },
    issues,
    readOnly: issues.length > 0,
    status:
      version > FIELD_SCHEMA_VERSION
        ? FIELD_SCHEMA_STATUS.futureVersion
        : issues.length
          ? FIELD_SCHEMA_STATUS.formError
          : FIELD_SCHEMA_STATUS.ready,
  }
}

const asMap = (node: Node | null | undefined, label: string): MapNode => {
  if (!isMap(node)) {
    throw new Error(`${label} must be a mapping`)
  }

  return node
}

const asSeq = (node: Node | null | undefined, label: string): SeqNode => {
  if (!isSeq(node)) {
    throw new Error(`${label} must be a sequence`)
  }

  return node
}

/** yaml keeps the comment immediately before the first item on the sequence,
 * not on the item. Lower it before changing the head, then lift the new head's
 * comment back so comments move (or disappear) with their owner. */
const changingSequenceHead = (seq: SeqNode, change: () => void): void => {
  const oldFirst = seq.items[0]

  if (seq.commentBefore && oldFirst && typeof oldFirst === 'object') {
    const node = oldFirst as Node
    node.commentBefore = [seq.commentBefore, node.commentBefore].filter(Boolean).join('\n')
  }
  seq.commentBefore = null
  change()
  const newFirst = seq.items[0]

  if (newFirst && typeof newFirst === 'object') {
    const node = newFirst as Node
    seq.commentBefore = node.commentBefore ?? null
    node.commentBefore = null
  }
}

const reconcileSequence = <T>(
  seq: SeqNode,
  wanted: readonly T[],
  identityOfNode: (node: MapNode) => string | null,
  identityOfValue: (value: T) => string,
  create: (value: T) => MapNode,
  update: (node: MapNode, value: T) => void,
): void => {
  const byIdentity = new Map<string, MapNode>()

  for (const item of seq.items) {
    if (isMap(item)) {
      const identity = identityOfNode(item)

      if (identity !== null && !byIdentity.has(identity)) {
        byIdentity.set(identity, item)
      }
    }
  }
  const next = wanted.map((value) => {
    const identity = identityOfValue(value)
    const node = byIdentity.get(identity) ?? create(value)

    update(node, value)
    return node
  })

  changingSequenceHead(seq, () => {
    seq.items = next
    seq.flow = false
  })
}

const setOptional = (map: MapNode, key: string, value: unknown): void => {
  if (value === undefined) {
    map.delete(key)
  } else {
    map.set(key, value)
  }
}

const reconcileValues = (
  doc: Document,
  field: MapNode,
  values: readonly FieldEnumOption[] | undefined,
): void => {
  if (values === undefined) {
    field.delete('values')
    return
  }
  let seq = nodeAt(field, 'values')

  if (!isSeq(seq)) {
    seq = doc.createNode([])
    field.set('values', seq)
  }
  const valuesSeq = asSeq(seq as Node, 'field values')

  reconcileSequence(
    valuesSeq,
    values,
    (node) => {
      const key = valueAt(node, 'key')
      return typeof key === 'string' ? key : null
    },
    (value) => value.key,
    (value) => asMap(doc.createNode({ key: value.key }) as Node, 'enum value'),
    (node, value) => {
      node.set('key', value.key)
      setOptional(node, 'label', value.label)
      setOptional(node, 'color', value.color)
    },
  )
}

const reconcileField = (doc: Document, node: MapNode, field: FieldDeclaration): void => {
  node.set('key', field.key)
  node.set('type', field.type)
  setOptional(node, 'label', field.label)
  setOptional(node, 'card', field.card || undefined)
  if (field.type === FIELD_TYPE.enum) {
    reconcileValues(doc, node, field.values)
  } else {
    node.delete('values')
  }
}

export const writeFieldSchemaFile = (raw: string | undefined, schema: FieldSchema): string => {
  const doc = raw
    ? parseDocument(raw, { prettyErrors: false })
    : parseDocument('version: 1\nfields: []\n', { prettyErrors: false })

  if (doc.errors.length || !isMap(doc.contents)) {
    throw new Error('cannot update an invalid field schema document')
  }
  const root = doc.contents as MapNode
  root.set('version', schema.version)
  let fieldsNode = nodeAt(root, 'fields')

  if (!isSeq(fieldsNode)) {
    fieldsNode = doc.createNode([])
    root.set('fields', fieldsNode)
  }
  const fields = asSeq(fieldsNode as Node, 'fields')

  reconcileSequence(
    fields,
    schema.fields,
    (node) => {
      const key = valueAt(node, 'key')
      return typeof key === 'string' ? key : null
    },
    (field) => field.key,
    (field) => asMap(doc.createNode({ key: field.key, type: field.type }) as Node, 'field'),
    (node, field) => reconcileField(doc, node, field),
  )

  return doc.toString({ lineWidth: 0 })
}
