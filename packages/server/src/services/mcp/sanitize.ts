// Defangs UNTRUSTED note-derived text (title/snippet/body/frontmatter) before it reaches the agent.
// canon: docs/mcp-gateway.md#security
// Deliberately conservative: only the angle brackets of a small control-tag set become guillemets ‹›; we
// never strip/rewrite arbitrary markup, so legit notes about XML/code/prompts stay faithful yet inert.
import { isUnsafeMcpFieldKey } from '@notarium/contract/tools'

/** Control/turn-boundary pseudo-tags to defang; kept deliberately small (broadening corrupts legit notes). */
const CONTROL_TAGS =
  /<\/?(?:system|systemprompt|instructions?|assistant|developer|human|user|tool_call|tool_result|tool_use|function_calls?|function_results?|antml)\b[^>]*>/gi

/** Defang control-looking pseudo-tags in one untrusted string. */
export const sanitizeText = (text: string): string =>
  text.replace(CONTROL_TAGS, (tag) => tag.replace(/</g, '‹').replace(/>/g, '›'))

/** Agent-only field-key fence. Human REST and Markdown stay open-world; an MCP
 * surface must neither reflect nor accept a pseudo-control tag as an address. */
export { isUnsafeMcpFieldKey }

/** Defang the string leaves of a frontmatter map. Shallow by design — nested YAML is NOT recursed
 *  (a documented v1 carve-out); the high-value injection surface is the body/snippet/title. */
export const sanitizeFrontmatter = (
  fm: Record<string, unknown>,
): { frontmatter: Record<string, unknown>; unsafeKeysOmitted: number } => {
  const frontmatter = Object.create(null) as Record<string, unknown>
  let unsafeKeysOmitted = 0

  for (const [k, v] of Object.entries(fm)) {
    if (isUnsafeMcpFieldKey(k)) {
      unsafeKeysOmitted++
      continue
    }
    if (typeof v === 'string') {
      frontmatter[k] = sanitizeText(v)
    } else if (Array.isArray(v)) {
      frontmatter[k] = v.map((e) => (typeof e === 'string' ? sanitizeText(e) : e))
    } else {
      frontmatter[k] = v
    }
  }

  return { frontmatter, unsafeKeysOmitted }
}
