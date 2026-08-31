import { rebalanceBoardRanks } from '@notarium/core'

import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

const source = [
  'source:',
  '  kind: notes',
  '  scope: project',
  '  filter:',
  '    op: and',
  '    nodes:',
  '      - op: or',
  '        ns: note',
  '        key: kind',
  '        values: [{ kind: eq, value: task }]',
].join('\n')

const boardCarrier = ({
  name = 'Tasks',
  groupBy = 'note.status',
  ranks,
  second = false,
  eol = '\n',
}: {
  name?: string
  groupBy?: string
  ranks?: string
  second?: boolean
  eol?: '\n' | '\r\n'
} = {}): string =>
  [
    '```nota',
    'version: 1',
    source,
    'views:',
    `  - name: ${name}`,
    '    type: board',
    '    fields: [note.owner, note.priority]',
    '    options:',
    `      groupBy: ${groupBy}`,
    '      foreignOption: keep-seed-witness',
    '      order:',
    '        kind: manual',
    ...(ranks
      ? ['        ranks: |-', ...ranks.split('\n').map((line) => `          ${line}`)]
      : []),
    ...(second
      ? [
          '  - name: Later reader',
          '    type: unknown-reader',
          '    options: { futureOption: keep }',
        ]
      : []),
    '```',
  ].join(eol)

const exactSource = (title: string, view: string | null, body: string, eol = '\n'): string =>
  [
    '---',
    `title: ${title}`,
    'notarium-id: {{noteId}}',
    ...(view === null ? [] : [`view: ${view}`]),
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  ].join(eol)

/** Human-sized view lab: the states a browser/MCP/manual QA pass needs without
 * manufacturing them in a hermetic component fixture. */
export const views: CaseSpec = {
  name: 'views',
  description:
    'A writer/reader project with board cards, independent manual ranks, open-world columns, marker mismatch states, malformed/future/read-only/resource-limited carriers, and exact CRLF/comment witnesses.',
  axes: ['views', 'fields', 'auth', 'search'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)

    b.space({
      slug: 'views-lab',
      displayName: 'Views lab',
      fieldSchema: {
        version: 1,
        fields: [
          {
            key: 'status',
            type: 'enum',
            label: 'Status',
            card: true,
            values: [
              { key: 'backlog', label: 'Backlog', color: 'slate' },
              { key: 'doing', label: 'Doing', color: 'amber' },
              { key: 'done', label: 'Done', color: 'green' },
            ],
          },
          { key: 'owner', type: 'text', label: 'Owner', card: true },
          { key: 'priority', type: 'number', label: 'Priority', card: true },
          { key: 'team', type: 'text', label: 'Team' },
          {
            key: 'risk',
            type: 'enum',
            label: 'Risk',
            card: true,
            values: [
              { key: 'high', label: 'High', color: 'red' },
              { key: 'low', label: 'Low', color: 'green' },
            ],
          },
        ],
      },
    })
    b.user({ username: 'view-writer', password: 'seed-pass', displayName: 'View Writer' })
    b.user({ username: 'view-reader', password: 'seed-pass', displayName: 'View Reader' })
    b.member({ space: 'views-lab', username: 'view-writer', role: 'owner' })
    b.member({ space: 'views-lab', username: 'view-reader', role: 'reader' })
    b.project({
      space: 'views-lab',
      path: 'project',
      slug: 'views',
      displayName: 'Views project',
    })
    const task = (
      id: string,
      title: string,
      fields: string,
      day: number,
      body = 'A task card in the seeded view corpus.',
    ) =>
      b.note({
        id,
        space: 'views-lab',
        path: `project/tasks/${title.toLowerCase().replaceAll(' ', '-')}.md`,
        title,
        content: `# ${title}\n\n${body}`,
        frontmatter: `kind: task\n${fields}`,
        created: daysBefore(now, day, 9),
        principal: 'user:view-writer',
      })

    task(
      'vtask0000001',
      'Alpha task',
      'status: backlog\nowner: Ann\npriority: 1\nteam: core\nrisk: high',
      9,
    )
    task(
      'vtask0000002',
      'Beta task',
      'status: doing\nowner: Bob\npriority: 2\nteam: web\nrisk: low',
      8,
    )
    task('vtask0000003', 'Catalog outsider', 'status: blocked\nowner: Cy\nteam: core', 7)
    task('vtask0000004', 'Absent status', 'owner: Dee\nteam: ops', 6)
    task('vtask0000005', 'Empty status', 'status: ""\nowner: Eli\nteam: ops', 5)
    task('vtask0000006', 'Unreadable status', 'status:\nowner: Fox\nteam: web', 4)
    task('vtask0000007', 'Rankless newcomer', 'status: backlog\nowner: Gia\nteam: core', 1)

    const firstRanks = ['["vtask0000001","a0"]', '["vtask0000002","a1"]'].join('\n')
    const secondRanks = ['["vtask0000002","a0"]', '["vtask0000001","a1"]'].join('\n')

    b.note({
      id: 'vboard000001',
      space: 'views-lab',
      path: 'project/boards/sprint.md',
      title: 'Sprint board',
      content: `# Sprint board\n\nProse search marker: aurora-view-prose.\n\n${boardCarrier({ ranks: firstRanks, second: true })}`,
      frontmatter: 'view: board',
      created: daysBefore(now, 3, 9),
      principal: 'user:view-writer',
    })
    b.note({
      id: 'vboard000002',
      space: 'views-lab',
      path: 'project/boards/team.md',
      title: 'Team board',
      content: `# Team board\n\n${boardCarrier({ name: 'By team', groupBy: 'note.team', ranks: secondRanks })}`,
      frontmatter: 'view: board',
      created: daysBefore(now, 2, 9),
      principal: 'user:view-writer',
    })

    const duplicateViews = Array.from({ length: 65 }, (_, index) =>
      index < 2
        ? `  - { name: Duplicate, type: board, options: { groupBy: note.status } }`
        : `  - { name: View ${index + 1}, type: board, options: { groupBy: note.status } }`,
    ).join('\n')
    b.note({
      space: 'views-lab',
      path: 'project/boards/resource-limit.md',
      title: 'Resource-limited views',
      content: `# Resource-limited views\n\n\`\`\`nota\nversion: 1\n${source}\nviews:\n${duplicateViews}\n\`\`\`\n\n\`\`\`nota\nversion: 1\n${source}\nviews: [{ name: Second block, type: board, options: { groupBy: note.team } }]\n\`\`\``,
      frontmatter: 'view: board',
      created: daysBefore(now, 2, 10),
      principal: 'user:view-writer',
    })
    for (const [path, title, payload] of [
      ['malformed.md', 'Malformed view', 'version: ['],
      [
        'future.md',
        'Future view',
        'version: 2\nsource: { kind: notes, scope: project }\nviews: [{ name: Future, type: board }]',
      ],
      [
        'anchor.md',
        'Anchored view',
        'version: 1\nsource: &source { kind: notes, scope: project }\nviews: [{ name: Anchored, type: board, options: { groupBy: note.status } }]',
      ],
      [
        'duplicate-key.md',
        'Duplicate-key view',
        'version: 1\nsource: { kind: notes, scope: project }\nviews: [{ name: First, name: Second, type: board, options: { groupBy: note.status } }]',
      ],
    ] as const) {
      b.note({
        space: 'views-lab',
        path: `project/states/${path}`,
        title,
        content: `# ${title}\n\n\`\`\`nota\n${payload}\n\`\`\``,
        frontmatter: 'view: board',
        created: daysBefore(now, 2, 11),
        principal: 'user:view-writer',
      })
    }
    b.note({
      space: 'views-lab',
      path: 'project/states/oversize.md',
      title: 'Oversize view',
      content: `# Oversize view\n\n\`\`\`nota\nversion: 1\npadding: ${'x'.repeat(1024 * 1024)}\n${source}\nviews: [{ name: Oversize, type: board, options: { groupBy: note.status } }]\n\`\`\``,
      frontmatter: 'view: board',
      created: daysBefore(now, 2, 12),
      principal: 'user:view-writer',
    })

    const mismatch = b.note({
      space: 'views-lab',
      path: 'project/states/marker-mismatch.md',
      title: 'Marker mismatch',
      content: `# Marker mismatch\n\n${boardCarrier()}`,
      frontmatter: 'view: table',
      created: daysBefore(now, 1, 9),
      principal: 'user:view-writer',
    })
    b.externalSource({
      note: mismatch,
      source: {
        encoding: 'utf8',
        data: exactSource('Marker mismatch', 'table', boardCarrier()),
      },
    })
    const missing = b.note({
      space: 'views-lab',
      path: 'project/states/marker-missing.md',
      title: 'Marker missing',
      content: `# Marker missing\n\n${boardCarrier()}`,
      created: daysBefore(now, 1, 10),
      principal: 'user:view-writer',
    })
    b.externalSource({
      note: missing,
      source: {
        encoding: 'utf8',
        data: exactSource('Marker missing', null, boardCarrier()),
      },
    })
    const stale = b.note({
      space: 'views-lab',
      path: 'project/states/stale-marker.md',
      title: 'Stale marker',
      content: '# Stale marker\n\nOrdinary prose.',
      frontmatter: 'view: board',
      created: daysBefore(now, 1, 11),
      principal: 'user:view-writer',
    })
    b.externalSource({
      note: stale,
      source: {
        encoding: 'utf8',
        data: exactSource('Stale marker', 'board', 'Ordinary prose.'),
      },
    })
    const crlf = b.note({
      space: 'views-lab',
      path: 'project/states/crlf-witness.md',
      title: 'CRLF witness',
      content: `# CRLF witness\n\n${boardCarrier({ ranks: firstRanks }).replace('keep-seed-witness', 'nebula-config-only')}`,
      frontmatter: 'view: board\nauthor-note: keep-comment-witness',
      created: daysBefore(now, 1, 12),
      principal: 'user:view-writer',
    })
    b.externalSource({
      note: crlf,
      source: {
        encoding: 'utf8',
        data: exactSource(
          'CRLF witness',
          'board',
          `<!-- keep comment -->\r\n\r\n${boardCarrier({ ranks: firstRanks, eol: '\r\n' }).replace('keep-seed-witness', 'nebula-config-only')}`,
          '\r\n',
        ),
      },
    })

    return b.build()
  },
}

/** Production-shaped scale branch for the shared-snapshot summary and rank scalar gates. */
export const viewsScale: CaseSpec = {
  name: 'views-scale',
  description:
    '10000 task notes, 10 columns, 50 view documents over one snapshot, one 9900-line rank scalar and a deterministic rankless tail.',
  axes: ['views', 'scale'],
  build: ({ now, scale }) => {
    const b = new WorldBuilder(now)
    const count = Math.max(1, Math.round(10_000 * scale))
    const ids: string[] = []

    b.space({ slug: 'views-scale', displayName: 'Views at scale' })
    for (let index = 0; index < count; index++) {
      const serial = String(index).padStart(10, '0')
      const id = `vt${serial}`

      ids.push(id)
      b.note({
        id,
        space: 'views-scale',
        path: `tasks/${serial.slice(0, 2)}/task-${serial}.md`,
        title: `Scale task ${serial}`,
        content: `# Scale task ${serial}\n\nOne card in the board window corpus.`,
        frontmatter: `kind: task\nstatus: status-${index % 10}`,
        created: daysBefore(now, index % 365, 9),
        principal: 'user:sergey',
      })
    }
    const ranked = ids.slice(0, Math.max(0, count - Math.ceil(count / 100)))
    const ranks = [...rebalanceBoardRanks(ranked)].map((tuple) => JSON.stringify(tuple)).join('\n')

    for (let index = 0; index < 50; index++) {
      const serial = String(index).padStart(10, '0')

      b.note({
        id: `vv${serial}`,
        space: 'views-scale',
        path: `boards/view-${serial}.md`,
        title: `Scale board ${serial}`,
        content: `# Scale board ${serial}\n\n${boardCarrier({
          name: `Board ${index + 1}`,
          ...(index === 0 ? { ranks } : {}),
        }).replace('scope: project', 'scope: space')}`,
        frontmatter: 'view: board',
        created: daysBefore(now, 1, 9),
        principal: 'user:sergey',
      })
    }

    return b.build()
  },
}
