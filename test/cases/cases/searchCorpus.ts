import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// A corpus tuned for SEARCH / Spotlight / tags (#188/#193/#109/#204): four notes that
// all share the title "Meeting notes" but differ in folder / date / type (the Spotlight
// meta-line disambiguation, incl. a years-old one for the year-format edge); distinct-
// term notes for title / path / content matching and ranking; and three tag-case-fold
// notes (`Element` / `Metal` / `element` fold to the same filter key). Grounded in the
// #188 spotlight corpus + #204 tag chips.
export const searchCorpus: CaseSpec = {
  name: 'search-corpus',
  description:
    'A search/Spotlight corpus — four same-title "Meeting notes" disambiguated by path/date/type, title/path/content-match notes, and tag case-folding (#188/#109/#204).',
  axes: ['search', 'content'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    const note = (
      path: string,
      title: string,
      opts: { type?: string; tags?: string[]; body?: string; day: number },
    ): void => {
      b.note({
        space: 'main',
        path,
        title,
        content: `# ${title}\n\n${opts.body ?? 'A note in the search corpus.'}`,
        noteType: opts.type,
        tags: opts.tags,
        created: daysBefore(now, opts.day, 10),
        principal: 'user:sergey',
      })
    }

    // Four "Meeting notes" — same title, different folder / date / type: the Spotlight
    // meta-line must disambiguate them (path + date + type badge). The last is years old
    // (year-format date edge).
    note('projects/acme/meeting-notes.md', 'Meeting notes', {
      type: 'meeting',
      day: 25,
      body: 'Acme project sync.',
    })
    note('conversations/chatgpt/meeting-notes.md', 'Meeting notes', {
      type: 'conversation',
      day: 63,
      body: 'An imported ChatGPT thread.',
    })
    note('team/standups/meeting-notes.md', 'Meeting notes', {
      type: 'meeting',
      day: 5,
      body: 'Daily standup.',
    })
    note('archive/2020/meeting-notes.md', 'Meeting notes', {
      type: 'meeting',
      day: 2360,
      body: 'An old meeting from the archive — year-format date.',
    })

    // Distinct-term notes for title / path / content matching and ranking.
    note('ops/oncall/checklist.md', 'Checklist', {
      type: 'runbook',
      day: 40,
      body: 'On-call runbook checklist.',
    })
    note('team/notes/sprint-retro.md', 'Sprint retro', {
      day: 35,
      body: 'Retro of the nebula handoff — a distinctive content-match term.',
    })
    note('clients/acme/launch-plan.md', 'Launch plan', {
      type: 'project',
      day: 50,
      body: 'Acme launch plan.',
    })
    note('projects/zenith/roadmap-draft.md', 'Roadmap draft', {
      type: 'project',
      day: 45,
      body: 'The zenith roadmap — a path-match term.',
    })
    note('labs/semantic/research-brief.md', 'Research brief', {
      type: 'research',
      day: 30,
      body: 'Hybrid search research brief.',
    })
    note('welcome-aboard.md', 'Welcome aboard', { day: 70, body: 'A root-level welcome note.' })

    // Tag case-folding (#204): the authored label is preserved, but the filter key folds
    // — `Element`, `Metal` and `element` all land on the same `?tag=` feed.
    note('elements/titanium.md', 'Titanium', {
      day: 20,
      tags: ['Element', 'Metal'],
      body: 'A strong, light metal.',
    })
    note('elements/carbon.md', 'Carbon', {
      day: 18,
      tags: ['Element'],
      body: 'The basis of organic chemistry.',
    })
    note('elements/element-notes.md', 'Element notes', {
      day: 15,
      tags: ['element'],
      body: 'Lower-case tag — folds with the capitalised one.',
    })

    return b.build()
  },
}
