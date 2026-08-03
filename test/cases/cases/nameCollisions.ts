import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// The create-collision surface (canon: docs/note-model.md#create-collisions). A title
// picks the file name, so "New note" typed as a title a sibling already uses is a real
// collision — the stand has to hold the states that flow FROM that rule, not just the
// rule: a folder primed for the refusal dialog, the uniquified result of duplicating
// twice, and a same-title pair in different folders proving the rule is per-folder.
//
// Deliberately NOT here: a markdown file the index has never seen (the engine-only
// refusal, where the 409 carries no occupant to open). It is not a seedable STAND
// state — the server's boot scan indexes any planted file before the first request, so
// it would arrive as an ordinary note. That path is covered where it survives: the
// filesystem leg of test/unit/cachedStoreMutations.test.ts.
export const nameCollisions: CaseSpec = {
  name: 'name-collisions',
  description:
    'Folders primed for the create-collision dialog: a taken title, an already-uniquified "… 2"/"… 3" family, and the same title living in two folders (docs/note-model.md#create-collisions).',
  axes: ['identity', 'structure'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })

    // The primed collision: type "# Plans" as a new note in `work` and the save is
    // refused, naming this note as the one to open.
    b.note({
      space: 'main',
      path: 'work/plans.md',
      title: 'Plans',
      content:
        '# Plans\n\nThe body a second "Plans" used to replace without a word.\n\nQ3 hiring, the migration window, and the two things we are deliberately not doing.',
      created: daysBefore(now, 30),
      principal: 'user:sergey',
    })

    // What "save under a free name" / duplicating twice actually leaves behind: a family
    // of near-identical titles the tree, feed and spotlight all have to stay readable in.
    b.note({
      space: 'main',
      path: 'work/retro.md',
      title: 'Retro',
      content: '# Retro\n\nThe original retro — what we shipped and what hurt.',
      created: daysBefore(now, 21),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'work/retro-2.md',
      title: 'Retro 2',
      content:
        '# Retro 2\n\nA copy taken to rework the action items without touching the original.',
      created: daysBefore(now, 20),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'work/retro-3.md',
      title: 'Retro 3',
      content: '# Retro 3\n\nAnd the copy of the copy — the third click of Duplicate.',
      created: daysBefore(now, 19),
      principal: 'user:sergey',
    })

    // Same title, different folder: legal, untouched by the rule, and the reason the
    // refusal message says "here" rather than "in this space".
    b.note({
      space: 'main',
      path: 'archive/plans.md',
      title: 'Plans',
      content: '# Plans\n\nLast year’s plans, archived. Shares a title with `work/plans.md`.',
      created: daysBefore(now, 400),
      principal: 'user:sergey',
    })

    // A folder page: its file is the reserved `index.md`, so a child note titled after
    // the folder does NOT collide with it — the one place the title→file rule bends.
    b.note({
      space: 'main',
      path: 'work/index.md',
      title: 'Work',
      content: '# Work\n\nThe cover page of the folder that holds the collision states.',
      created: daysBefore(now, 31),
      principal: 'user:sergey',
    })

    return b.build()
  },
}
