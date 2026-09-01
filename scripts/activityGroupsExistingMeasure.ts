import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

import type { RevisionInput, RevisionPersistence } from '@notarium/core'

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=')
    return [key!, value.join('=')]
  }),
)
const dialect = args.get('dialect') as 'sqlite' | 'postgres'
const target = args.get('target')
const output = args.get('output')
const sourceRoot = resolve(args.get('source-root') ?? '.')
const samples = Number(args.get('samples') ?? 20)
const phase = args.get('phase') as 'baseline' | 'candidate'
const space = args.get('space') ?? 'activity-groups'

if (
  !target ||
  !output ||
  !['sqlite', 'postgres'].includes(dialect) ||
  !['baseline', 'candidate'].includes(phase) ||
  !Number.isInteger(samples) ||
  samples <= 0
) {
  throw new Error(
    'usage: --phase=baseline|candidate --dialect=sqlite|postgres --target=<db> --output=<json> [--source-root=<tree>] [--samples=20]',
  )
}

type MetaDb = {
  revisions: RevisionPersistence
  close(): Promise<void>
}

const moduleAt = (relative: string): string => pathToFileURL(resolve(sourceRoot, relative)).href
const db: MetaDb =
  dialect === 'sqlite'
    ? new (
        await import(moduleAt('packages/server/src/services/metaDb/sqliteMetaDb.ts'))
      ).SqliteMetaDb(target)
    : new (await import(moduleAt('packages/server/src/services/metaDb/pgMetaDb.ts'))).PgMetaDb(
        target,
      )
await db.revisions.init()

const range = {
  from: '2019-01-01T00:00:00.000Z',
  to: '2035-01-01T00:00:00.000Z',
}
const values = {
  activity: [] as number[],
  events: [] as number[],
  note: [] as number[],
  append: [] as number[],
}

const timed = async (run: () => Promise<unknown>): Promise<number> => {
  const started = performance.now()
  await run()
  return performance.now() - started
}
let appendIndex = 0

const append = (): Promise<unknown> => {
  const index = ++appendIndex
  const revision: RevisionInput = {
    noteId: `activity-existing-${phase}-${randomUUID()}-${index}`,
    space,
    baseRevisionId: null,
    theirRevisionId: null,
    sourceRevisionId: null,
    kind: 'external',
    entryRole: 'origin',
    principal: 'user:viewer',
    contentHash: null,
    title: `Activity existing ${phase} ${index}`,
    class: 'user-doc',
    slug: null,
    tags: [],
    createdAt: new Date(Date.UTC(2031, 0, 1, 0, 0, index)).toISOString(),
    charsAdded: null,
    charsRemoved: null,
  }
  return db.revisions.append(revision, null)
}
const operations = {
  activity: () =>
    db.revisions.activityByDay(space, { ...range, tzOffsetMinutes: 0, excludeClasses: [] }),
  events: () =>
    db.revisions.activityEvents(space, { ...range, offset: 0, limit: 12, excludeClasses: [] }),
  note: () => db.revisions.get(space, '1'),
  append,
}

try {
  for (const run of Object.values(operations)) {
    for (let warmup = 0; warmup < 3; warmup++) {
      await run()
    }
  }
  for (let sample = 0; sample < samples; sample++) {
    for (const name of ['activity', 'events', 'note', 'append'] as const) {
      values[name].push(await timed(operations[name]))
    }
  }
} finally {
  await db.close()
}

await import('node:fs').then(({ mkdirSync, writeFileSync }) => {
  mkdirSync(resolve(output, '..'), { recursive: true })
  writeFileSync(
    output,
    `${JSON.stringify({ phase, dialect, sourceRoot, target, samples, values }, null, 2)}\n`,
  )
})
