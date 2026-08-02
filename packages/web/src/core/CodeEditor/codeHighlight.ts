import type { TagStyle } from '@codemirror/language'
// Code-token highlight, shared by BOTH editor modes (#178/#177).
//
// The bridge: a CM6 HighlightStyle can take a CSS variable as its `color`, so we
// route the nested code parser's lezer tags (keyword/string/comment/number/…) at
// the SAME `--hl-*` role tokens that styles/code-themes.scss defines per preset
// for the reading-view highlighter (highlight.js `.hljs-*` classes). One flip of
// `data-code-theme` (+ the light/dark `data-theme`) then recolours the editor AND
// the preview from a single palette — no second theme system, and no Compartment
// reconfigure on a preset change: the spans already say `color: var(--hl-keyword)`,
// so the browser recomputes them when the custom property changes on :root — the same
// way any `color: var(--…)` token already tracks the light/dark theme today (pure CSS,
// no JS, no re-highlight).
//
// This list is spread into mdHighlight (Source mode, CodeEditor.tsx) and
// richHighlight (WYSIWYM mode, wysiwymSource.ts) so both surfaces colour fenced code
// identically. It carries ONLY code-content tags — the markdown-structural tags
// (heading/strong/emphasis/link/url/monospace/processingInstruction/quote/list) stay
// owned by each mode's own style, so there's no tag tug-of-war. Tokens we don't map
// (operators, brackets, punctuation) inherit the editor's base text colour, which is
// what highlight.js does too (it leaves them at `--hl-text`).
//
// The role mapping mirrors code-themes.scss's class→role table so a token lands on
// the same colour in Edit as in Preview:
//   comment  ← comments               keyword  ← keywords + literals (bool/null/atom)
//   builtin  ← types / namespaces     string   ← strings / regexp / escapes / attr values
//   number   ← numbers / units        function ← function & class names
//   variable ← vars / props / attrs / params / meta
//   tag      ← HTML/CSS tag & selector names
//   addition/deletion ← diff lines
import { tags as t } from '@lezer/highlight'

export const codeTokenStyles: TagStyle[] = [
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: 'var(--hl-comment)',
    fontStyle: 'italic',
  },
  // Keywords plus the literal atoms hljs paints with the keyword colour
  // (`.hljs-literal` → --hl-keyword): true/false/null/self/this and control words.
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.moduleKeyword,
      t.modifier,
      t.self,
      t.atom,
      t.bool,
      t.null,
    ],
    color: 'var(--hl-keyword)',
  },
  // Built-in types / namespaces (hljs `.hljs-type`/`.hljs-built_in` → --hl-builtin).
  { tag: [t.typeName, t.standard(t.typeName), t.namespace], color: 'var(--hl-builtin)' },
  // Strings, regexps, escapes, and HTML attribute values (string-like in hljs).
  {
    tag: [t.string, t.special(t.string), t.character, t.regexp, t.escape, t.attributeValue],
    color: 'var(--hl-string)',
  },
  { tag: [t.number, t.integer, t.float, t.unit], color: 'var(--hl-number)' },
  // Function and class/title names (hljs `.hljs-title.function_`/`.class_` → --hl-function).
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.function(t.definition(t.variableName)),
      t.macroName,
      t.className,
      t.definition(t.className),
    ],
    color: 'var(--hl-function)',
  },
  // Variables, properties, attribute names, params, decorators/meta
  // (hljs `.hljs-variable`/`.hljs-property`/`.hljs-attr`/`.hljs-params`/`.hljs-meta`).
  {
    tag: [
      t.variableName,
      t.definition(t.variableName),
      t.local(t.variableName),
      t.special(t.variableName),
      t.propertyName,
      t.definition(t.propertyName),
      t.attributeName,
      t.labelName,
      t.meta,
      t.annotation,
    ],
    color: 'var(--hl-variable)',
  },
  // HTML/XML/CSS tag & selector names (hljs `.hljs-tag`/`.hljs-name`/`.hljs-selector-*`).
  { tag: [t.tagName, t.standard(t.tagName)], color: 'var(--hl-tag)' },
  // Diff blocks, matching the reading view's addition/deletion roles.
  { tag: t.inserted, color: 'var(--hl-addition)' },
  { tag: t.deleted, color: 'var(--hl-deletion)' },
]
