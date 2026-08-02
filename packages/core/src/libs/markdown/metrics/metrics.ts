import { stripFrontmatter } from '../frontmatter'
import { TOKEN_ESTIMATE } from './consts'

/**
 * Rough word count over a note body (frontmatter and code stripped) — the
 * "content mass" signal behind the graph's "Size by → Words" and the editor's
 * status bar. Approximate by design: it sizes things *relatively*, so a
 * stable monotonic measure of how much prose a note carries is enough — no need
 * for a precise statistic. A pure libs function (depends only on stripFrontmatter
 * here) so any layer, including the web editor, can reuse it.
 */
export const countWords = (content: string): number => {
  const text = stripFrontmatter(content)
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/<[^>]+>/g, ' ') // html tags
  const m = text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)
  return m ? m.length : 0
}

/**
 * A model-agnostic token estimate for a piece of note content — the
 * "context weight" the constructor's token scale reads. NOT a real BPE tokenizer
 * (the estimate must be encoder-free and stable across models): it buckets the
 * text into ASCII and non-ASCII characters and divides each bucket by its
 * chars-per-token coefficient, because scripts differ wildly in BPE density
 * (Latin ≈4 chars/token, Cyrillic ≈2). Code and prose both count — the agent
 * loads them alike — but frontmatter is stripped (metadata, not the body the
 * agent reads). Approximate by design: it sizes context *relatively* so the
 * fattest pins stand out; a precise per-model count is not the point.
 */
export const estimateTokens = (
  content: string,
  coeff: { asciiCharsPerToken: number; nonAsciiCharsPerToken: number } = TOKEN_ESTIMATE,
): number => {
  const text = stripFrontmatter(content)
  let ascii = 0
  let nonAscii = 0

  // `for…of` iterates by code point, so an astral char (emoji) counts once and
  // lands in the non-ASCII bucket via its lead surrogate (≥ 0xD800).
  for (const ch of text) {
    if (ch.charCodeAt(0) <= 0x7f) {
      ascii += 1
    } else {
      nonAscii += 1
    }
  }

  return Math.round(ascii / coeff.asciiCharsPerToken + nonAscii / coeff.nonAsciiCharsPerToken)
}

/**
 * How many leading items of an ordered list fit an eager token budget:
 * the longest prefix whose cumulative `tokens` stays within `budgetTokens`, also
 * bounded by `countCap` — the anti-pathological backstop (a runaway many-tiny-items
 * list can't blow the bundle even under budget). The token budget is the PRIMARY
 * limiter; the count cap only bites in the degenerate case. Strict prefix: the
 * first item that would overflow, and everything after it, is trimmed — so "loaded"
 * is always a contiguous head, which the constructor's segment bars render cleanly.
 * SHARED by the server's eager assembly (start_session) and the web preview so the
 * human sees EXACTLY what the agent gets — one rule, no drift.
 */
export const tokenBudgetLoadedCount = (
  tokens: readonly number[],
  budgetTokens: number,
  countCap: number,
): number => {
  let used = 0
  let loaded = 0

  for (let i = 0; i < tokens.length && i < countCap; i++) {
    if (used + tokens[i] > budgetTokens) {
      break
    }
    used += tokens[i]
    loaded += 1
  }

  return loaded
}

/**
 * Curate ONE ordered, priority-sorted weight list against a SINGLE token budget
 * — the primitive behind "one budget per scope". Returns a `loaded` flag per
 * item (the strict-prefix that fits, via {@link tokenBudgetLoadedCount}) plus the
 * loaded/total token sums. The single shared envelope is the whole point: pins and
 * memory (and, in a project, the embedded personal background) are concatenated in
 * priority order into ONE list and weighed against ONE budget — so a scope can never
 * show "budget still free, yet something trimmed" (the old per-channel sub-budget
 * artefact). Callers build the ordered list (e.g. project pins ++ personal pins ++
 * personal memory) and split the returned flags back by segment. SHARED by the MCP
 * gateway (the agent's real bundle) and the REST preview (the pult) so the human sees
 * EXACTLY what the agent loads — one rule, no drift.
 */
export const curateBudget = (
  weights: readonly number[],
  budgetTokens: number,
  countCap: number,
): { loaded: boolean[]; loadedTokens: number; totalTokens: number } => {
  const loadedCount = tokenBudgetLoadedCount(weights, budgetTokens, countCap)
  let loadedTokens = 0

  for (let i = 0; i < loadedCount; i++) {
    loadedTokens += weights[i]
  }

  return {
    loaded: weights.map((_, i) => i < loadedCount),
    loadedTokens,
    totalTokens: weights.reduce((sum, w) => sum + w, 0),
  }
}
