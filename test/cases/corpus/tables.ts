import type { Fragment } from './types'

// GFM tables (#235): wrapped in `.md-table > .md-table-wrap > table` so a wide
// table scrolls horizontally instead of stretching the --doc-width column, with
// scroll-edge fades toggled by the post-render pass. Alignment, inline markup in
// cells, and an escaped pipe in a cell (harvest gap).
export const tablesFragments: Fragment[] = [
  {
    id: 'table-basic',
    feature: 'tables',
    exercises: 'a small GFM table is wrapped in the scroll container',
    md: '| Feature | Status |\n|---|---|\n| Tables | done |\n| Callouts | done |',
    refs: ['#235', 'markdown.test.ts'],
    expect: { contains: ['<div class="md-table">', '<div class="md-table-wrap">', '<table>'] },
  },
  {
    id: 'table-wide',
    feature: 'tables',
    exercises: 'a wide table (many columns) overflows the column → horizontal scroll',
    md: [
      '| Feature | Status | Owner | Ticket | Notes about the feature that make this column wide enough to scroll |',
      '|---|:--:|---|---|---|',
      '| Tables | done | sergey | #235 | Overflow-x scroll wrapper keeps the page from stretching horizontally |',
      '| Task lists | done | alex | #235 | Native checkbox skinned, single marker, no doubled bullet |',
      '| Callouts | done | sergey | #117 | Obsidian syntax, twelve looks, foldable via <details> |',
      '| Math | done | alex | #237 | KaTeX at the string layer, four delimiters, price-safe |',
    ].join('\n'),
    refs: ['#235', 'readerShowcase'],
    expect: { contains: ['md-table-wrap'] },
  },
  {
    id: 'table-alignment',
    feature: 'tables',
    exercises: 'left / center / right column alignment in one table',
    md: '| Left | Center | Right |\n|:---|:---:|---:|\n| a | b | c |\n| longer | mid | 42 |',
    refs: ['#235'],
    // `align` matches marked's alignment output (`align="center"` / `text-align:center`),
    // so a lost-alignment regression fails — a bare `<table>` marker wouldn't notice.
    expect: { contains: ['<table>', 'align'] },
  },
  {
    id: 'table-inline-markup',
    feature: 'tables',
    exercises: 'cells carry inline code, bold and a link',
    md: '| Kind | Example |\n|---|---|\n| code | `store.write` |\n| bold | **awaited** |\n| link | [note-history](https://example.com) |',
    refs: ['#235'],
    expect: { contains: ['<code>store.write</code>', '<strong>awaited</strong>'] },
  },
  {
    id: 'table-escaped-pipe',
    feature: 'tables',
    exercises: 'an escaped pipe stays inside a cell instead of splitting it',
    md: '| Expr | Meaning |\n|---|---|\n| `a \\| b` | bitwise or |\n| `x \\|\\| y` | logical or |',
    refs: ['harvest-gap'],
    // The escaped `\|` must stay INSIDE the cell — a split would tear `a | b` apart.
    expect: { contains: ['<code>a | b</code>'] },
  },
  {
    id: 'table-super-wide',
    feature: 'tables',
    exercises: 'a super-wide table (12 columns) → strong horizontal scroll',
    md: [
      '| # | Feature | Owner | Ticket | Status | Priority | Area | Since | Notes | Risk | ETA | Reviewer |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
      '| 1 | Tables | sergey | #235 | done | high | reader | v0.1 | horizontal scroll wrapper | low | — | alex |',
      '| 2 | Math | alex | #237 | done | high | reader | v0.2 | four delimiters, price-safe | low | — | sergey |',
      '| 3 | Mermaid | sergey | #236 | done | med | reader | v0.2 | lazy SVG, honest error card | med | — | alex |',
    ].join('\n'),
    refs: ['#235', 'feedback'],
    expect: { contains: ['md-table-wrap'] },
  },
  {
    id: 'table-super-tall',
    feature: 'tables',
    exercises: 'a super-tall table (30 rows) → vertical length, no sticky header',
    md: [
      '| Row | Value |',
      '|---:|---|',
      ...Array.from(
        { length: 30 },
        (_, i) => `| ${i + 1} | item number ${i + 1} in a long table |`,
      ),
    ].join('\n'),
    refs: ['#235', 'feedback'],
    expect: { contains: ['<table>', 'item number 30'] },
  },
  {
    id: 'table-nested-in-callout',
    feature: 'tables',
    exercises: 'a table nested INSIDE a callout (a table within another block)',
    md: '> [!info] The two appliers at a glance\n> One case, two projections:\n>\n> | Applier | Consumes | Backdated? |\n> |---|---|---|\n> | fake | snapshot + activity rows | seeded journal |\n> | real | replays the timeline | injected clock |',
    refs: ['feedback', '#117'],
    expect: { contains: ['callout-info', 'md-table-wrap'] },
  },
]
