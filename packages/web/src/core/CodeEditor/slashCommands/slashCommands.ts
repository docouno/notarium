// Slash-command menu (#119) — `/` opens a palette that inserts a CLEAN markdown
// snippet (table, code block, callout, footnote, heading, date…). This is NOT a
// block-object editor: a slash command is just smart text insertion, so the body
// stays raw markdown and the round-trip is byte-exact like every other edit. It
// rides @codemirror/autocomplete (fuzzy filter + keyboard nav + snippet tab-stops
// for free) and works in BOTH modes (source + wysiwym) — the inserted text is the
// same raw markdown either way; the mode's decorations just restyle it.
import {
  acceptCompletion,
  autocompletion,
  type Completion,
  type CompletionContext,
  completionKeymap,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { type Extension } from '@codemirror/state'
import { SEC } from './consts'
import { blockApply, dateApply, footnoteApply, inlineApply } from './helpers/apply'
import { type Item } from './types'

const ITEMS: Item[] = [
  {
    label: 'Heading 1',
    type: 'h1',
    detail: '#',
    section: SEC.headings,
    apply: blockApply('# ${}'),
  },
  {
    label: 'Heading 2',
    type: 'h2',
    detail: '##',
    section: SEC.headings,
    apply: blockApply('## ${}'),
  },
  {
    label: 'Heading 3',
    type: 'h3',
    detail: '###',
    section: SEC.headings,
    apply: blockApply('### ${}'),
  },
  {
    label: 'Bullet list',
    type: 'bullet',
    detail: '-',
    section: SEC.lists,
    apply: blockApply('- ${}'),
  },
  {
    label: 'Numbered list',
    type: 'ordered',
    detail: '1.',
    section: SEC.lists,
    apply: blockApply('1. ${}'),
  },
  {
    label: 'Task list',
    type: 'task',
    detail: '- [ ]',
    section: SEC.lists,
    apply: blockApply('- [ ] ${}'),
  },
  { label: 'Quote', type: 'quote', detail: '>', section: SEC.blocks, apply: blockApply('> ${}') },
  // Callouts (#117): 12 looks (note/info/abstract/tip/success/question/warning/danger/
  // bug/example/quote/important + aliases) share one widget. We surface the five most
  // common as presets; the TYPE is a tab-stop (`${2:note}`) so any of the 12 is one
  // overtype away. The caret starts in the BODY (`${1}`) — write the callout right
  // away; Tab reaches the type only if you want to change it (so picking a preset and
  // typing can't clobber its type). The marker stays raw (WYSIWYM keeps the source).
  {
    label: 'Callout',
    type: 'callout',
    detail: '[!note]',
    section: SEC.blocks,
    apply: blockApply('> [!${2:note}]\n> ${1}'),
  },
  {
    label: 'Callout: info',
    type: 'callout',
    detail: '[!info]',
    section: SEC.blocks,
    apply: blockApply('> [!${2:info}]\n> ${1}'),
  },
  {
    label: 'Callout: tip',
    type: 'callout',
    detail: '[!tip]',
    section: SEC.blocks,
    apply: blockApply('> [!${2:tip}]\n> ${1}'),
  },
  {
    label: 'Callout: warning',
    type: 'callout',
    detail: '[!warning]',
    section: SEC.blocks,
    apply: blockApply('> [!${2:warning}]\n> ${1}'),
  },
  {
    label: 'Callout: danger',
    type: 'callout',
    detail: '[!danger]',
    section: SEC.blocks,
    apply: blockApply('> [!${2:danger}]\n> ${1}'),
  },
  // Code block: caret starts on the (empty) language slot, Tab → body. The slots are
  // empty numbered fields (not a `${lang}` placeholder) so an un-replaced language
  // can't leave a literal `lang` in the fence info-string.
  {
    label: 'Code block',
    type: 'code',
    detail: '```',
    section: SEC.blocks,
    apply: blockApply('```${1}\n${2}\n```'),
  },
  // Table: a 2×2 GFM starter; Tab cycles header cells → first data cell. The header
  // placeholders ("Column"/"Column 2") double as labels and as valid header text.
  {
    label: 'Table',
    type: 'table',
    detail: '| |',
    section: SEC.blocks,
    apply: blockApply('| ${Column} | ${Column 2} |\n| --- | --- |\n| ${} |  |'),
  },
  {
    label: 'Divider',
    type: 'divider',
    detail: '---',
    section: SEC.blocks,
    apply: blockApply('---\n${}'),
  },
  // Inline inserts — image + links land AT the caret (inlineApply), not on their own
  // line. `[[…]]` (internal/wiki link) is the graph-native one: it links to another note.
  {
    label: 'Image',
    type: 'image',
    detail: '![]()',
    section: SEC.insert,
    apply: inlineApply('![${alt}](${url})'),
  },
  {
    label: 'Link',
    type: 'link',
    detail: '[]()',
    section: SEC.insert,
    apply: inlineApply('[${text}](${url})'),
  },
  {
    label: 'Internal link',
    type: 'wikilink',
    detail: '[[ ]]',
    section: SEC.insert,
    apply: inlineApply('[[${}]]'),
  },
  // Footnote (#117): inline ref at the caret + a definition grouped with the others
  // (custom apply — it's a split inline/block construct, see footnoteApply).
  {
    label: 'Footnote',
    type: 'footnote',
    detail: '[^1]',
    section: SEC.insert,
    apply: footnoteApply,
  },
  {
    label: "Today's date",
    type: 'date',
    detail: 'YYYY-MM-DD',
    section: SEC.insert,
    apply: dateApply,
  },
]

// Build the completion list once. `boost` descends with declared order so the menu
// keeps that order within a section when the query is empty (fuzzy-match rank only
// reorders within a section; sections stay ordered by their `rank`).
const OPTIONS: Completion[] = ITEMS.map((it, i) => ({
  label: it.label,
  type: it.type,
  detail: it.detail,
  section: it.section,
  apply: it.apply,
  boost: ITEMS.length - i,
}))

// Trigger only when `/` sits at the line start OR right after whitespace — so it
// never fires inside `http://`, `and/or` or a file path. `from + 1` (after the
// slash) is where the typed query begins, so the fuzzy filter matches on `table`,
// not `/table`; the apply functions delete the slash via `from - 1`.
const slashSource = (context: CompletionContext): CompletionResult | null => {
  const before = context.matchBefore(/\/\w*/)

  if (!before) {
    return null
  }
  const line = context.state.doc.lineAt(before.from)

  if (before.from > line.from) {
    const prevChar = context.state.sliceDoc(before.from - 1, before.from)

    if (!/\s/.test(prevChar)) {
      return null
    }
  }

  return { from: before.from + 1, options: OPTIONS, validFor: /^\w*$/ }
}

/** The `/`-menu extension. `override` makes this the ONLY completion source, so the
 *  editor never pops generic word-completion — only the slash palette. `tooltipClass`
 *  gives the popup the app's shared glass-menu look (`cm-pop glass`, styled in
 *  styles/editor-popovers.scss like core/ContextMenu), not CM's default light chrome. */
export const slashCommands: Extension = autocompletion({
  override: [slashSource],
  icons: true,
  activateOnTyping: true,
  tooltipClass: () => 'cm-pop glass',
})

/** Completion keymap — added to CodeEditor's keymap before `indentWithTab`. Enter/
 *  Esc/arrows come from `completionKeymap`; **Tab accepts** the selected command
 *  (when the menu is open). All these bindings no-op (return false) while the popup
 *  is closed, so plain Enter still inserts a newline and Tab still indents. Once a
 *  snippet is inserted, its OWN Tab keymap (Prec.highest) takes over for field
 *  navigation, so Tab does the right thing at every stage: accept → next field → indent. */
export const slashKeymap = [...completionKeymap, { key: 'Tab', run: acceptCompletion }]
