import { countWords } from '@notarium/core/markdown'

// Editor status-bar metrics (#115). `countWords` is reused from core (the same
// prose count the graph's "Size by → Words" uses — frontmatter and code stripped)
// so a note reads the same word count wherever it's shown. Characters are the raw
// length of the body the editor holds; reading time is words at an average pace.
export type TextStats = { words: number; chars: number; minutes: number }

// Average adult silent-reading speed (~200–250 wpm); 200 is the conventional,
// slightly conservative choice (Medium/iA Writer-era convention).
const WORDS_PER_MINUTE = 200

export const textStats = (text: string): TextStats => {
  const words = countWords(text)
  return {
    words,
    chars: text.length,
    // Whole minutes, rounded up so any prose reads as "≥ 1 min"; empty stays 0.
    minutes: words === 0 ? 0 : Math.ceil(words / WORDS_PER_MINUTE),
  }
}
