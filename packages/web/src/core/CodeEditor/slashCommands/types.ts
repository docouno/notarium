import { type Completion, type CompletionSection } from '@codemirror/autocomplete'

// The command set (v1). `detail` shows the literal markdown to the right of the
// label; `type` selects the menu icon (themed in styles/editor-popovers.scss).
// Snippet `${field}` placeholders become tab-stops (Tab/Shift-Tab cycles them,
// installed by @codemirror/autocomplete's snippet runner); `${}` is the final caret.
export type Item = {
  label: string
  type: string
  detail: string
  section: CompletionSection
  apply: Completion['apply']
}
