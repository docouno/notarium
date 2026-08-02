import type { Fragment } from './types'

// GFM task lists (#235): marked emits a disabled checkbox per item; the reader
// skins it and drops the `li::marker` bullet so there's no double marker. Checked
// and unchecked, plus a nested task list.
export const tasklistsFragments: Fragment[] = [
  {
    id: 'tasklist-mixed',
    feature: 'tasklists',
    exercises: 'checked and unchecked task items render disabled checkboxes',
    md: '- [x] Render tables with a scroll wrapper\n- [x] Skin task-list checkboxes\n- [ ] Ship mermaid diagrams\n- [ ] Ship KaTeX math',
    refs: ['#235', 'readerShowcase'],
    expect: { contains: ['type="checkbox"', 'checked'] },
  },
  {
    id: 'tasklist-nested',
    feature: 'tasklists',
    exercises: 'a nested task list under a task item',
    md: '- [ ] Parent task\n  - [x] Done subtask\n  - [ ] Pending subtask',
    refs: ['#235'],
    // 3 checkboxes (parent + 2 subtasks) prove the nested list; `checked` pins the [x].
    expect: { contains: ['checked'], containsCount: { 'type="checkbox"': 3 } },
  },
]
