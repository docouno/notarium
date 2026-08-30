/** The MCP create-note nudge is intentionally narrow: false positives train agents
 * to ignore a warning. Provider-header checks use their own broader advisory set,
 * while the credential prefix gate asks the narrower, blocking question. */
const MCP_SECRET_PATTERN: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/,
  /(?:api[_-]?key|secret|password|passwd|token)["'`]?\s*[:=]\s*["'`][^"'`\s]{12,}["'`]/i,
]

const PROVIDER_SECRET_PATTERN: readonly RegExp[] = [
  ...MCP_SECRET_PATTERN,
  /\bsk-ant-api03-[A-Za-z0-9_-]{16,}\b/,
  /\bsk-or-v1-[A-Fa-f0-9]{32,}\b/,
  /\bsk-proj-[A-Za-z0-9_-]{16,}\b/,
  /\bgsk_[A-Za-z0-9_-]{16,}\b/,
  /\bhf_[A-Za-z0-9]{16,}\b/,
  /\b[A-Fa-f0-9]{32}\b/,
  /\b[A-Za-z0-9]{32}\b/, // Mistral-style opaque API key (a dashed UUID stays quiet)
  /\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}\b/i,
  /\b(?:pk|vk)_[A-Za-z0-9_-]{16,}\b/,
]

export const detectSecretWarnings = (text: string): string[] =>
  MCP_SECRET_PATTERN.some((pattern) => pattern.test(text)) ? ['possible-secret'] : []

export const looksLikeSecret = (value: string): boolean =>
  PROVIDER_SECRET_PATTERN.some((pattern) => pattern.test(value))

/** A prefix is blocking only when it carries a complete credential-looking value.
 * Short legal prefixes (`Bearer `, `Basic `, `Token `, `ApiKey `) stay valid. */
export const carriesWholeSecret = (prefix: string): boolean =>
  prefix.trim().length > 0 && looksLikeSecret(prefix)
