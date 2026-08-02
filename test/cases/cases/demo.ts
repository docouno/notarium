import { getDemoBundle } from '../demo'
import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// The DEMO world (#256) — the one case whose output is a public artifact rather
// than a test bed: the screenshots on the landing page, the README and the docs
// site are taken against it. Everything here is therefore chosen to be
// photogenic AND true, in that order of difficulty.
//
// Structure lives here; every string lives in a locale bundle (`../demo`), so a
// translation pass can never move a note or reshuffle the heatmap. See
// demo/types.ts for why that split matters.
//
// What each frame needs from this world, and where it comes from:
//   reader   — `home-server`, rich but plausible (mermaid, table, callout, code,
//              task list, wikilinks) — a real overview note, not a kitchen sink
//   history  — `runbook-restore`: human revisions with ONE agent edit in the
//              chain, so the timeline reads "your agent" beside "you" (#13).
//              That is the product's core claim — one base, one set of rules,
//              for a person and for an agent — proven in one screenshot
//   graph    — the wikilink web the bodies already spell out (12 hand-authored
//              notes, densely cross-referenced; no synthetic link padding)
//   search   — the bundle's `searchQuery` hits the backup thread across an
//              architecture note, a runbook and an incident
//   dashboard— the generated tail spreads writes across ~10 months so the
//              heatmap is a lived-in base, not one spike
//
// NO ABSOLUTE DATES IN THE BUNDLE — not in a body, not in a path. The world is
// anchored to whatever `now` the caller passes (the shoot passes today; the real
// applier passes the actual today; the catalog default is a fixed past instant),
// and every date a reader sees is derived from that anchor. A literal "2026-02-19"
// in an ADR header, or a `2026-06-…` in the incident's filename, would be frozen
// while the note's real created-date moves — drifting one day per day, in the same
// frame, on a published screenshot. That is a defect this case had and shed.

/** The human's journal attribution. `sergey` is the catalog's canonical primary
 *  author token — the real applier remaps it to `SEED_USER` (#175);
 *  the fake keeps it as-is, and the viewer IS this user, so their revisions read
 *  as "you". */
const HUMAN = 'user:sergey'
/** The agent's attribution: a PAT owned by the same user, so `describeAuthor`
 *  resolves it to an agent that is MINE — "your agent" in the history and the
 *  activity feed, never a second person. */
const AGENT_PAT_ID = 'demo-agent'
const AGENT = `pat:sergey:${AGENT_PAT_ID}`

export const demo: CaseSpec = {
  name: 'demo',
  description:
    'The public demo world (#256): a self-hosting developer’s knowledge base — the source for landing/README screenshots.',
  axes: ['content', 'structure', 'history', 'activity', 'graph', 'search', 'auth'],
  build: ({ now, rng, locale }) => {
    const bundle = getDemoBundle(locale)
    const b = new WorldBuilder(now)

    b.space({ slug: 'engineering', displayName: bundle.spaceName })
    // A root project over the whole space (#13/#97 auto-mark it anyway) — declared
    // so it carries the bundle's name rather than the slug, and so the dashboard's
    // Projects tile reads 1 instead of an empty 0.
    b.project({ space: 'engineering', path: '', displayName: bundle.spaceName })
    b.user({
      username: 'sergey',
      password: 'seed-pass',
      displayName: bundle.displayName,
      admin: true,
    })
    b.member({ space: 'engineering', username: 'sergey', role: 'owner' })

    // Hand-authored notes. The age spread is authored per note (not generated) so
    // the tree's "modified" ordering and the ADR dates in the bodies line up: the
    // architecture overview is the oldest and most-edited, the incident is recent.
    // One edit date per AUTHORED VERSION in the bundle — never more. An extra date
    // would re-save an identical body, which the live journal refuses as a no-op:
    // the fake would then count changes the real stand never records (measured: 63
    // rows vs 52) and print a counter-less "Edited" in the feed. A note with no
    // later version simply has no edits, which is also how ADRs behave in life.
    const AGES: Record<string, { created: number; edits: number[] }> = {
      'home-server': { created: 312, edits: [96] },
      storage: { created: 300, edits: [88] },
      networking: { created: 288, edits: [61] },
      'adr-postgres': { created: 132, edits: [] },
      'adr-containers': { created: 174, edits: [] },
      'adr-k8s': { created: 174, edits: [] },
      // The agent's edit is the last one, and it lands the day AFTER the incident
      // write-up (created 17 days ago) — the runbook is updated because of it.
      'runbook-restore': { created: 265, edits: [140, 16] },
      'runbook-postgres': { created: 129, edits: [] },
      'runbook-disk': { created: 208, edits: [26] },
      'incident-backup': { created: 17, edits: [] },
      scratch: { created: 45, edits: [] },
      reading: { created: 118, edits: [] },
    }

    // The one edit signed by the agent: step 3 of the restore runbook's chain —
    // the note the incident just changed. Ordered so a human wrote the runbook,
    // the incident happened, and the agent folded the finding back in.
    const AGENT_EDIT = { key: 'runbook-restore', step: 1 }

    // The reverse guard: an authored version with no edit date to land on would be
    // silently dropped — a translator adding a version would see nothing happen.
    for (const e of bundle.edits) {
      const age = AGES[e.key]

      if (!age || e.step >= age.edits.length) {
        throw new Error(
          `demo bundle "${bundle.locale}": note "${e.key}" authors a version at step ${e.step} that no edit date replays`,
        )
      }
    }

    const ids = new Map<string, string>()

    for (const note of bundle.notes) {
      const age = AGES[note.key]

      if (!age) {
        throw new Error(`demo bundle "${bundle.locale}": note "${note.key}" has no authored age`)
      }
      ids.set(
        note.key,
        b.note({
          space: 'engineering',
          path: note.path,
          title: note.title,
          content: note.body,
          tags: note.tags,
          created: daysBefore(now, age.created, 9, 20),
          principal: HUMAN,
        }),
      )
    }

    // Replay each note's edits by hand rather than through `note({ edits })`: the
    // builder's default appends an "_Edit N._" marker to the body, which is fine
    // for a fixture and unacceptable on a screenshot. Every edit MUST carry the
    // bundle's next version of the note — see the AGES comment for why a re-save is
    // not a revision the product would keep.
    for (const note of bundle.notes) {
      const age = AGES[note.key]
      const noteId = ids.get(note.key)!
      let body = note.body

      for (const [step, day] of age.edits.entries()) {
        const rewrite = bundle.edits.find((e) => e.key === note.key && e.step === step)

        if (!rewrite) {
          throw new Error(
            `demo bundle "${bundle.locale}": note "${note.key}" has an edit date at step ${step} with no authored version — it would re-save an identical body, which the live journal dedupes`,
          )
        }
        body = rewrite.body
        const isAgent = AGENT_EDIT.key === note.key && AGENT_EDIT.step === step
        b.event({
          op: 'edit',
          date: daysBefore(now, day, 14, 35),
          space: 'engineering',
          noteId,
          content: body,
          ...(rewrite.title ? { title: rewrite.title } : {}),
          principal: isAgent ? AGENT : HUMAN,
        })
      }
    }

    // The generated tail: enough everyday notes that the tree scrolls, the feed has
    // something to list and the heatmap looks like ten months of a real base rather
    // than a demo of twelve. Titles come from the bundle; dates and edit counts are
    // seeded RNG, so the world is byte-reproducible for a given SEED.
    for (const bucket of bundle.filler) {
      for (const [i, title] of bucket.titles.entries()) {
        // The first note of each bucket is RECENT (the dashboard's "N this week"
        // counts notes CREATED in the last seven days — a base whose newest note is
        // three weeks old photographs as abandoned); the rest spread over the year.
        const created = i === 0 ? rng.int(2, 6) : rng.int(20, 330)
        const slug = `note-${(i + 1).toString().padStart(2, '0')}`
        // Each generated note links back to its bucket's anchor. Otherwise the tail
        // is a pile of orphans, and the dashboard's Health tile — correctly — puts
        // that number on the screenshot.
        const lines = [
          `# ${title}`,
          '',
          filler(rng.int(0, FILLER.length - 1)),
          '',
          `${bundle.relatedLabel}: [[${bucket.anchor}]]`,
        ]
        const noteId = b.note({
          space: 'engineering',
          path: `${bucket.folder}/${slug}.md`,
          title,
          content: `${lines.join('\n')}\n`,
          created: daysBefore(now, created, rng.int(8, 20), rng.int(0, 59)),
          principal: HUMAN,
        })

        // Edit INSTANTS oldest first: the body only ever grows here, so replaying
        // them out of order hands the journal a shrinking chain and prints a
        // "+0 −166" on a note that never lost a line. Sorting the days alone is not
        // enough — the hour and minute are drawn per edit, so two edits landing on
        // the same day (guaranteed once `created` is small) still scramble. Sort the
        // resolved ISO instants, which order chronologically as strings. Same RNG
        // draws in the same order, so determinism is untouched.
        // A note created days ago can only be edited in those few days, so letting it
        // take four edits stacks them at the top of the feed — the dashboard frame
        // then leads with the same title three times. Recent notes get at most one.
        const editCount = created <= 7 ? rng.int(0, 1) : rng.int(0, 4)
        const dates = Array.from({ length: editCount }, () =>
          daysBefore(now, rng.int(1, Math.max(1, created - 1)), rng.int(8, 21), rng.int(0, 59)),
        ).sort()

        for (const date of dates) {
          lines.splice(lines.length - 2, 0, filler(rng.int(0, FILLER.length - 1)), '')
          b.event({
            op: 'edit',
            date,
            space: 'engineering',
            noteId,
            content: `${lines.join('\n')}\n`,
            principal: HUMAN,
          })
        }
      }
    }

    return b.build()
  },
}

// Filler bodies for the generated tail. Deliberately short, concrete and in the
// legend's voice: they are never the SUBJECT of a screenshot, but they do show up
// as feed snippets and tree rows, so "lorem ipsum" or word-salad would be visible
// exactly where the eye lands next.
const FILLER = [
  'Measured again after the swap — the numbers held, so this stays as it is.',
  'Kept failing until the config moved out of the container and into the volume.',
  'Worth re-checking in a year; the current setting was picked for hardware I no longer run.',
  'Three attempts, one of which was the documented way and the slowest.',
  'Left as a note to self: the manual step here is the reason the job is not automated yet.',
  'The default was fine. Writing that down so I stop revisiting it.',
  'Traced it to the upstream image, not the config. Pinned the tag.',
  'Took two evenings, mostly to find out the first evening was unnecessary.',
]

const filler = (i: number): string => FILLER[i % FILLER.length]
