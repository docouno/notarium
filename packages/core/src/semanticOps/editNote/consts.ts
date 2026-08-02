// Domain constants for the edit_note semantic op.

/** The splice operation an edit_note intent performs on the note body. */
export const EDIT_OPERATION = {
  append: 'append',
  prepend: 'prepend',
  replace: 'replace',
  replaceSection: 'replaceSection',
  findReplace: 'findReplace',
} as const

export type EditOperation = (typeof EDIT_OPERATION)[keyof typeof EDIT_OPERATION]
