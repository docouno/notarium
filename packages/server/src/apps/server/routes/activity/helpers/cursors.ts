import type { ActivityGroupCursor } from '@notarium/core'

type EventCursor = {
  v: 1
  kind: 'event'
  after: string
  through: string
  activityVersion: string
  scope: string
  locationThrough?: string
}

type GroupCursor = {
  v: 1
  kind: 'group'
  sourceOrdinal: string
  key: string
  through: string
  activityVersion: string
  locationThrough: string
  scope: string
}

const decimal = /^[1-9]\d*$/

const encode = (value: EventCursor | GroupCursor): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

const decode = (value: string): unknown => {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new Error('invalid activity cursor')
  }
}

export const activityCursorScope = (value: Record<string, string | undefined>): string =>
  JSON.stringify(
    Object.entries(value)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  )

export const encodeEventCursor = (
  after: string,
  through: string,
  activityVersion: string,
  scope: string,
  locationThrough?: string,
): string =>
  encode({ v: 1, kind: 'event', after, through, activityVersion, scope, locationThrough })

export const decodeEventCursor = (
  cursor: string,
  expected: {
    through?: string
    activityVersion?: string
    scope: string
    locationThrough?: string
  },
): { afterId: string; through: string; activityVersion: string } => {
  const value = decode(cursor) as Partial<EventCursor>

  if (
    value.v !== 1 ||
    value.kind !== 'event' ||
    typeof value.after !== 'string' ||
    !decimal.test(value.after) ||
    typeof value.through !== 'string' ||
    !decimal.test(value.through) ||
    typeof value.activityVersion !== 'string' ||
    value.activityVersion.length === 0 ||
    value.scope !== expected.scope ||
    value.locationThrough !== expected.locationThrough ||
    (expected.through != null && value.through !== expected.through) ||
    (expected.activityVersion != null && value.activityVersion !== expected.activityVersion)
  ) {
    throw new Error('invalid activity cursor')
  }

  return {
    afterId: value.after,
    through: value.through,
    activityVersion: value.activityVersion,
  }
}

export const encodeGroupCursor = (
  cursor: ActivityGroupCursor,
  through: string,
  activityVersion: string,
  locationThrough: string,
  scope: string,
): string =>
  encode({
    v: 1,
    kind: 'group',
    sourceOrdinal: cursor.sourceOrdinal,
    key: cursor.key,
    through,
    activityVersion,
    locationThrough,
    scope,
  })

export const decodeGroupCursor = (
  cursor: string,
  expected: {
    through: string
    activityVersion: string
    locationThrough: string
    scope: string
  },
): ActivityGroupCursor => {
  const value = decode(cursor) as Partial<GroupCursor>

  if (
    value.v !== 1 ||
    value.kind !== 'group' ||
    typeof value.sourceOrdinal !== 'string' ||
    !decimal.test(value.sourceOrdinal) ||
    typeof value.key !== 'string' ||
    value.key.length === 0 ||
    value.through !== expected.through ||
    value.activityVersion !== expected.activityVersion ||
    value.locationThrough !== expected.locationThrough ||
    value.scope !== expected.scope
  ) {
    throw new Error('invalid activity cursor')
  }

  return { sourceOrdinal: value.sourceOrdinal, key: value.key }
}
