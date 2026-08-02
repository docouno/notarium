import { LS_KEY } from '../../consts'

export const remembered = (): string | null => {
  try {
    return localStorage.getItem(LS_KEY)
  } catch {
    return null
  }
}

export const remember = (slug: string) => {
  try {
    localStorage.setItem(LS_KEY, slug)
  } catch {
    // private mode etc. — the personal/first-space fallback covers it (#99)
  }
}
