import { CONTEXT_SCOPE_SPACE_KEY } from '../../consts'

export const rememberContextScopeSpace = (scope: string, space: string) => {
  try {
    localStorage.setItem(`${CONTEXT_SCOPE_SPACE_KEY}${scope}`, space)
  } catch {
    // Storage is a convenience for restoring the project axis after note opens.
  }
}

export const rememberedContextScopeSpace = (scope: string): string | null => {
  try {
    return localStorage.getItem(`${CONTEXT_SCOPE_SPACE_KEY}${scope}`)
  } catch {
    return null
  }
}
