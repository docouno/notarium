import { FIELDS_BLOB_BYTE_CAP } from '@notarium/core'

import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

/** The vocabulary the small board is drawn from, one note per value. Exported for the
 *  same reason `REVIEWERS` is: the gate states the board's population against this
 *  DECLARATION, never against a count read off a run. */
export const STATUS_OPTIONS = [
  { key: 'beklog', label: 'Бэклог', color: 'slate' as const },
  { key: 'v-rabote', label: 'В работе', color: 'amber' as const },
  { key: 'gotovo', label: 'Готово', color: 'green' as const },
]
export const STATUSES = STATUS_OPTIONS.map((option) => option.key)
export const PALETTE_OPTIONS = [
  { key: 'slate', label: 'Slate', color: 'slate' as const },
  { key: 'red', label: 'Red', color: 'red' as const },
  { key: 'orange', label: 'Orange', color: 'orange' as const },
  { key: 'amber', label: 'Amber', color: 'amber' as const },
  { key: 'green', label: 'Green', color: 'green' as const },
  { key: 'teal', label: 'Teal', color: 'teal' as const },
  { key: 'blue', label: 'Blue', color: 'blue' as const },
  { key: 'violet', label: 'Violet', color: 'violet' as const },
]
/** The vocabulary the shared list key draws from. What the case DECIDES is this size;
 *  how many distinct reviewers 20 notes end up showing is a consequence of the modular
 *  arithmetic below. So nothing — not this comment, not docs/seeds.md, not the gate —
 *  writes that number down: the gate states the relations the population has to satisfy
 *  and holds the count it observes against `REVIEWERS.length`, which is a comparison
 *  between two derived things rather than a literal anyone has to keep in sync. */
export const REVIEWERS = Array.from(
  { length: 25 },
  (_, i) => `reviewer-${String(i + 1).padStart(2, '0')}`,
)
export const EXACT_REVIEWER = ' Doe, Jane '
/** The first day the metrics note reports on, as an authored key name would spell it. */
const METRICS_FROM = Date.UTC(2025, 9, 1)

const metricDay = (i: number): string =>
  new Date(METRICS_FROM + i * 86_400_000).toISOString().slice(0, 10)

/** What one kept key NAME costs inside a blob's `truncated`/`unreadable` list: the two
 *  quotes and the separating comma on top of the name itself. */
const nameBytes = (name: string): number => name.length + 3
/** Names worth twice the cap. Every size below is DERIVED from
 *  `FIELDS_BLOB_BYTE_CAP` rather than tuned against it, and that is the whole point:
 *  the three cap-overflow states used to sit on a 1.2× margin, so retuning the cap —
 *  4096 → 6144 is the value a memory pass would reach for without thinking — would
 *  have switched all three off silently, taking the seeded stand and the numbers in
 *  docs/seeds.md with it. Twice the cap is a statement the cap cannot outgrow; that
 *  the states really are reachable is asserted in test/cases/fields.test.ts. */
const namesWorthTwiceTheCap = (name: string): number =>
  Math.ceil((2 * FIELDS_BLOB_BYTE_CAP) / nameBytes(name))

/** One key per day of a machine-written report. The blob cap gives up VALUES first
 *  and the dropped keys' NAMES second, so a note only reaches the sixth key state —
 *  the name itself lost — once its names alone outweigh the cap. */
const DAILY_METRICS = namesWorthTwiceTheCap(`visits-${metricDay(0)}`)
/** Bare `key:` lines — unreadable values, whose names are the LAST thing the cap
 *  gives up (they are the only carrier of `fieldBad`), so this note is nothing but
 *  them. */
const BLANK_FORM_FIELDS = namesWorthTwiceTheCap('intake-question-001')
/** A single value the cap cannot seat at any size: one byte over the whole blob's
 *  budget, so the key is dropped to `truncated` while its NAME stays findable. */
const OVERSIZED_VALUE_BYTES = FIELDS_BLOB_BYTE_CAP + 1

/** Notes with no metadata of their own — the shape most of a real corpus has (11 keys
 *  over 344 notes, the field-zero measurement in #301). Seeded below, where what rides
 *  on them is written out. */
const PLAIN_NOTES: ReadonlyArray<readonly [path: string, title: string, body: string]> = [
  ['journal/kickoff.md', 'Kickoff', 'Who is on this, what we build first, what we leave out.'],
  [
    'journal/standup.md',
    'Monday standup',
    'Yesterday, today, blockers. Three lines and no metadata.',
  ],
  [
    'journal/reading-list.md',
    'Reading list',
    'Links worth a second pass, written down before they are lost.',
  ],
  [
    'journal/one-on-one.md',
    'One-on-one',
    'Notes to myself after a conversation that needed no fields.',
  ],
  [
    'journal/incident.md',
    'Incident notes',
    'What broke, what we tried, and what actually fixed it.',
  ],
  ['journal/retro.md', 'Retro', 'What went well, what did not, and the one thing we change next.'],
]

/** The field axis end to end: every key state the index encodes, and the population
 *  shapes the facet's selection rule has to tell apart. Deliberately small — a stand
 *  an operator can read — with the counts that make the rule observable. The two
 *  cap-overflow notes are the exception, and a required one: the state where a key's
 *  NAME is lost is only reachable on a note whose names alone outweigh the blob.
 *
 *  ONE axis is declared, and that is not an oversight. `search` used to be declared
 *  too, and nothing here seeds it: the one tagged note below is there for the fields
 *  column and drives no tag facet, no two bodies differ in a way a query could tell
 *  apart, and the VALUES of a field are deliberately out of `notes_fts` for this whole
 *  task. `content` went the same way — the reader states this case really does drive
 *  (the sidebar's third zone, a card's plaques) are surfaces of the `fields` axis
 *  itself, and there is not a markdown feature in the corpus below. A case is coverage
 *  for what it seeds. */
export const fields: CaseSpec = {
  name: 'fields',
  description:
    'A writer/reader field lab plus a corpus authored with its own frontmatter: a three-value status, a shared list key, a per-note unique key, a journal of notes carrying no authored frontmatter at all, every unreadable/empty/oversized state the index encodes, two notes whose key names are past the blob cap, and the protected keys the column carries anyway.',
  axes: ['fields', 'auth'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)

    b.space({
      slug: 'fields-lab',
      displayName: 'Field axis lab',
      fieldSchema: {
        version: 1,
        fields: [
          {
            key: 'status',
            type: 'enum',
            label: 'Status',
            card: true,
            values: STATUS_OPTIONS,
          },
          { key: 'priority', type: 'number', label: 'Priority', card: true },
          { key: 'due', type: 'date', label: 'Due', card: true },
          { key: 'reviewers', type: 'list', label: 'Reviewers' },
          { key: 'approved', type: 'checkbox', label: 'Approved' },
          { key: 'client', type: 'text', label: 'Client' },
          {
            key: 'palette',
            type: 'enum',
            label: 'Palette',
            card: true,
            values: PALETTE_OPTIONS,
          },
          {
            key: 'card-state',
            type: 'enum',
            label: 'Card state',
            card: true,
            values: [{ key: 'healthy', label: 'Healthy', color: 'green' }],
          },
        ],
      },
    })
    b.space({
      slug: 'fields-future',
      displayName: 'Future field schema',
      fieldSchemaRaw: 'version: 2\nfields:\n  - key: probe\n    type: text\n    label: Probe\n',
    })
    b.space({
      slug: 'fields-form-error',
      displayName: 'Recoverable field schema',
      fieldSchemaRaw:
        'version: 1\nfields:\n  - key: probe\n    type: text\n    label: Probe\n  - key: phase\n    type: text\n    label: " probe "\n',
    })
    b.space({
      slug: 'fields-structural-error',
      displayName: 'Structural field schema error',
      fieldSchemaRaw: 'version: 1\nfields: not-a-sequence\n',
    })
    b.user({
      username: 'sergey',
      password: 'seed-pass',
      displayName: 'Sergey',
      admin: true,
    })
    b.user({
      username: 'field-reader',
      password: 'seed-pass',
      displayName: 'Field Reader',
    })
    b.member({ space: 'fields-lab', username: 'sergey', role: 'owner' })
    b.member({ space: 'fields-lab', username: 'field-reader', role: 'reader' })
    for (const schemaSpace of ['fields-future', 'fields-form-error', 'fields-structural-error']) {
      b.member({ space: schemaSpace, username: 'sergey', role: 'owner' })
      b.note({
        space: schemaSpace,
        path: 'sample.md',
        title: 'Schema state sample',
        content: '# Schema state sample\n\nA durable note beside this schema state.',
        frontmatter: 'schema_probe: visible',
        created: daysBefore(now, 2, 9),
        principal: 'user:sergey',
      })
    }

    // `typed` is the second channel on purpose: `type`, `summary` and `muted` are
    // protected keys that still ride the fields column, and the product writes them
    // through the serializer's typed arguments — never as raw carry. Declaring them
    // the raw way would seed a file shape no write produces. It would NOT change the
    // derived blob, and the earlier claim that it would is retracted here so it does
    // not come back: the fake drops a raw duplicate only for a key the snapshot
    // itself carries typed, so a case that declares them raw and types nothing keeps
    // its carry whole — both channels were run on both engines and agreed. The reason
    // to pick this one is the fidelity of the seeded FILE, not the column.
    const note = (
      path: string,
      title: string,
      frontmatter: string,
      day: number,
      body = '',
      typed: { noteType?: string; summary?: string; muted?: boolean; tags?: string[] } = {},
    ) =>
      b.note({
        space: 'fields-lab',
        path,
        title,
        content: `# ${title}\n\n${body || 'A note carrying its own metadata.'}`,
        // Omitted rather than passed empty: a note with NO authored frontmatter is a
        // seeded state here (see the journal below), and `frontmatter: ''` would hand
        // both appliers an empty authored block to reproduce instead of none.
        ...(frontmatter ? { frontmatter } : {}),
        created: daysBefore(now, day, 9),
        principal: 'user:sergey',
        ...typed,
      })

    // Three notes, three values: below any plausible corpus threshold, and still the
    // demo the whole axis exists for — a status that groups a small project.
    STATUSES.forEach((status, i) => {
      note(
        `board/task-${i + 1}.md`,
        `Task ${i + 1}`,
        `status: ${status}\npriority: ${i + 1}\ndue: 2026-09-0${i + 1}`,
        30 - i,
        '',
        // `type` is protected — undeclarable as a field — and still filterable,
        // because it has no note metadata of its own to be read from instead.
        {
          noteType: 'task',
          ...(i === 0 ? { tags: ['planning', 'delivery', 'team', 'urgent', 'weekly'] } : {}),
        },
      )
    })

    // A list key shared across many notes, three values per note. Two properties make
    // it the third population, and both are relations rather than counts: its distinct
    // values OUTNUMBER the notes carrying them (so a rule reading `distinct < notes`
    // throws the key away), while no single value is alone on a note (so the corrected
    // denominator — (note, value) entries, design/00 — keeps it). The numbers those
    // relations come to are a consequence of the modular arithmetic below; the gate
    // reads them off the seeded notes instead of restating them here.
    for (let i = 0; i < 20; i++) {
      const exactListValue = `\n- "${EXACT_REVIEWER}"`
      note(
        `reviews/review-${String(i + 1).padStart(2, '0')}.md`,
        `Review ${i + 1}`,
        `reviewers:\n- ${REVIEWERS[i % REVIEWERS.length]}\n- ${REVIEWERS[(i + 7) % REVIEWERS.length]}\n- ${REVIEWERS[(i + 13) % REVIEWERS.length]}${exactListValue}`,
        25 - (i % 20),
      )
    }

    // The opposite shape: a key that is unique on every note it appears on, so it
    // identifies rather than groups.
    for (let i = 0; i < 40; i++) {
      note(
        `contacts/contact-${String(i + 1).padStart(2, '0')}.md`,
        `Contact ${i + 1}`,
        `telegram_id: ${100_000 + i}`,
        20 - (i % 18),
      )
    }

    // The shape MOST of a real corpus has, and the one this case used to have none of:
    // a note with no metadata of its own. Two things ride on it. The backfill re-derives
    // a row only when its blob differs from the column DEFAULT, so on a corpus where
    // every note carries author keys `rowsRederived` equals `filesRead` and stops
    // discriminating — the path where a row is ADOPTED, which is the whole reason the
    // counters are two numbers, never runs (test/integration/fieldsBackfill.test.ts,
    // `FIELDS_BACKFILL_CASE=fields`). And the field surfaces have a zero state — a
    // sidebar third zone with nothing in it, a card with no plaques — that a stand where
    // every note carries keys cannot show at all.
    PLAIN_NOTES.forEach(([path, title, body], i) => note(path, title, '', 18 - i, body))
    PALETTE_OPTIONS.forEach((option, index) =>
      note(
        `palette/${option.key}.md`,
        `Palette ${option.label}`,
        `palette: ${option.key}`,
        17 - index,
        `A live ${option.label.toLowerCase()} tone on the same field surface.`,
      ),
    )
    // The OTHER way to an empty blob, and the reason "has no frontmatter" and "the
    // column carries nothing" have to stay two different populations: authored
    // frontmatter the column deliberately drops, because the note projects it onto
    // metadata of its own. Written through the typed channel the product writes tags
    // with, so the seeded FILE has the `tags:` block a real one would.
    note(
      'journal/quarter-plan.md',
      'Quarter plan',
      '',
      11,
      'Its frontmatter is nothing but tags, and tags are projected onto the note itself — so the fields column stays empty here too.',
      { tags: ['planning', 'roadmap'] },
    )

    // One note per remaining key state, so a stand shows each without arithmetic.
    note('states/unreadable.md', 'Unreadable value', 'shape:\n  nested: 1\nkeeper: visible', 10)
    note('states/empty.md', 'Empty value', "note: ''\nkeeper: visible", 9)
    note('states/reader-marker.md', 'Reader marker', 'view: board\nkeeper: visible', 8)
    note(
      'states/display-mismatch.md',
      'Display mismatch states',
      [
        'card-state: Unknown',
        'priority: high',
        'due: 2026-09-01T10:00:00Z',
        'approved: true',
        "client: ''",
        'palette: violet',
        'slug: display-mismatch',
        'aliases:',
        '- Former display mismatch',
      ].join('\n'),
      8,
      'Declared controls can show valid moments, booleans, explicit empties and mismatches without coercion.',
    )
    note('states/colon-key.md', 'Key with a colon', 'https://example: linked\nkeeper: visible', 7)
    note(
      'states/oversized.md',
      'Oversized value',
      `keeper: visible\nblob: ${'x'.repeat(OVERSIZED_VALUE_BYTES)}`,
      6,
      'The blob key overflows the index blob cap; its name stays findable, its value does not.',
    )
    // The sixth state, which no smaller shape can produce: enough keys that the cap
    // cannot hold even their NAMES. The values all go first, so `report` and the early
    // days keep only their NAMES — enough to stay findable by `fieldAny`; the tail is a
    // count, which `fieldAny` and `fieldBad` both answer FALSE for and the sidebar
    // shows as a number rather than a name.
    note(
      'states/names-lost.md',
      'Names lost to the cap',
      [
        'report: daily visits',
        ...Array.from(
          { length: DAILY_METRICS },
          (_, i) => `visits-${metricDay(i)}: ${100 + ((i * 7) % 90)}`,
        ),
      ].join('\n'),
      5,
      'One key per day of a machine-written report: the index keeps the first names it can fit and counts the rest.',
      { noteType: 'task' },
    )
    // The same overflow on the other list. Unreadable names are the last thing the
    // cap gives up, so reaching THIS counter takes a note that is nothing but them —
    // and it is the shape where a key stops answering `fieldBad` while still sitting
    // in the file for the sidebar to read.
    note(
      'states/unreadable-names-lost.md',
      'Unreadable names lost to the cap',
      Array.from(
        { length: BLANK_FORM_FIELDS },
        (_, i) => `intake-question-${String(i + 1).padStart(3, '0')}:`,
      ).join('\n'),
      4,
      'An intake template nobody filled in: every value is unreadable, and past the cap the names are a count too.',
    )
    // The protected keys that DO ride the column — the note projects no metadata field
    // of its own for `type`, `summary` and `muted`, so the column is the only place a
    // filter could read them from. Authored through the typed channels the product
    // writes them with, beside a plain author key that is not protected at all.
    note(
      'states/typed-protected.md',
      'Typed protected keys',
      'keeper: visible',
      3,
      'Its type, summary and muted flag ride the fields column: filterable, never offered as a field to declare, never in the facet.',
      {
        noteType: 'task',
        summary: 'Typed metadata with no note field of its own.',
        muted: true,
      },
    )

    return b.build()
  },
}
