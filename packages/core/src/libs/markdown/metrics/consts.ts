/** The average characters-per-token coefficients behind `estimateTokens`.
 *  A single named config, NOT baked into the UI: the server owns the estimate (it
 *  has the body) and the client only reads the resulting `tokens` off the wire, so
 *  a tweak here re-scales every surface at once. ASCII/Latin prose runs ≈4 chars
 *  per BPE token (OpenAI's rule of thumb); Cyrillic/CJK cost far more per character
 *  (a Cyrillic letter is often ~1 token) — ≈2 is a model-agnostic average that
 *  errs toward over-counting (warn early) rather than hiding real budget pressure. */
export const TOKEN_ESTIMATE = {
  asciiCharsPerToken: 4,
  nonAsciiCharsPerToken: 2,
}
