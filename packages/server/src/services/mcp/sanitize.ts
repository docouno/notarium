// Defangs UNTRUSTED note-derived text (title/snippet/body/frontmatter) before it reaches the agent.
// canon: docs/mcp-gateway.md#security
// Deliberately conservative: only the angle brackets of a small control-tag set become guillemets ‹›; we
// never strip/rewrite arbitrary markup, so legit notes about XML/code/prompts stay faithful yet inert.

/** Control/turn-boundary pseudo-tags to defang; kept deliberately small (broadening corrupts legit notes). */
const CONTROL_TAGS =
  /<\/?(?:system|systemprompt|instructions?|assistant|developer|human|user|tool_call|tool_result|tool_use|function_calls?|function_results?|antml)\b[^>]*>/gi

/** Defang control-looking pseudo-tags in one untrusted string. */
export const sanitizeText = (text: string): string =>
  text.replace(CONTROL_TAGS, (tag) => tag.replace(/</g, '‹').replace(/>/g, '›'))

/** Defang the string leaves of a frontmatter map. Shallow by design — nested YAML is NOT recursed
 *  (a documented v1 carve-out); the high-value injection surface is the body/snippet/title. */
export const sanitizeFrontmatter = (fm: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}

  for (const [k, v] of Object.entries(fm)) {
    if (typeof v === 'string') {
      out[k] = sanitizeText(v)
    } else if (Array.isArray(v)) {
      out[k] = v.map((e) => (typeof e === 'string' ? sanitizeText(e) : e))
    } else {
      out[k] = v
    }
  }

  return out
}
