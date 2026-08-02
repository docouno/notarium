/** A zod-free dict's values as a `z.enum`-ready non-empty tuple, so a wire schema derives
 *  its allowed set from the const dict (`z.enum(enumValues(NOTE_CLASS))`) instead of a second
 *  inline literal list. canon: docs/architecture.md#literals */
export const enumValues = <T extends Record<string, string>>(
  dict: T,
): [T[keyof T], ...T[keyof T][]] => Object.values(dict) as [T[keyof T], ...T[keyof T][]]
