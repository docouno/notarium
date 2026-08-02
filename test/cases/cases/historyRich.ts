import { daysBefore, WorldBuilder } from '../generators'
import type { CaseEvent, CaseSpec } from '../types'

// A note with a DEEP revision chain — the history panel + the Changes diff (#203
// reading-size diff, #160 title/meta history). Edits by two authors, growing body,
// a mid-life rename, and varied +N/−M so the timeline reads like a real document's
// life, not one commit.

const body = (lines: string[]) => `# Release Notes\n\n${lines.join('\n')}\n`

export const historyRich: CaseSpec = {
  name: 'history-rich',
  description:
    'One note with a deep, multi-author revision chain and a rename — the history timeline + Changes diff (#203/#160).',
  axes: ['history', 'identity'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    b.user({ username: 'sergey', password: 'seed-pass', displayName: 'Sergey', admin: true })
    b.user({ username: 'alex', password: 'seed-pass', displayName: 'Alex' })
    b.member({ space: 'main', username: 'sergey', role: 'owner' })
    b.member({ space: 'main', username: 'alex', role: 'writer' })

    const lines: string[] = ['## 1.0', '- Initial cut of the release notes.']
    const id = b.note({
      space: 'main',
      path: 'releases/release-notes.md',
      title: 'Release Notes',
      content: body(lines),
      tags: ['release'],
      created: daysBefore(now, 42, 9),
      principal: 'user:sergey',
    })

    // A sequence of chained edits: each appends/rewrites, by alternating authors,
    // one of them a title change (a rename in the history).
    const steps: Array<{ day: number; who: string; mutate: () => void; title?: string }> = [
      { day: 38, who: 'alex', mutate: () => lines.push('- Fixed a typo in the intro.') },
      {
        day: 33,
        who: 'sergey',
        mutate: () => lines.push('', '## 1.1', '- Added the seed catalog section.'),
      },
      { day: 28, who: 'alex', mutate: () => lines.push('- Documented `make seed`.') },
      {
        day: 22,
        who: 'sergey',
        mutate: () =>
          (lines[1] = '- A polished cut of the release notes, expanded and reorganised.'),
      },
      {
        day: 16,
        who: 'alex',
        mutate: () => lines.push('', '## 1.2', '- Combining cases (`CASE=a,b,c`).'),
        title: 'Release Notes — 1.2',
      },
      { day: 9, who: 'sergey', mutate: () => lines.push('- Backdated journal, honest heatmap.') },
      { day: 3, who: 'alex', mutate: () => lines.push('- Reader showcase + long document cases.') },
    ]

    for (const s of steps) {
      s.mutate()
      const ev: CaseEvent = {
        op: 'edit',
        date: daysBefore(now, s.day, 11),
        space: 'main',
        noteId: id,
        content: body(lines),
        principal: `user:${s.who}`,
      }
      b.event(s.title ? { ...ev, title: s.title } : ev)
    }

    return b.build()
  },
}
