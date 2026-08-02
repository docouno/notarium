import type { Author } from '@notarium/contract'

/** Phrase a resolved author (#13) for the UI + say whether it's an agent (drives
 *  the glyph). The server already decided identity + privacy (the viewer's own
 *  key name, or another user's username — never their key name); here we only
 *  word it. `mine` → "you" / "your agent X"; otherwise "<name>" / "<name>'s
 *  agent". One place so the note history and the memory feed read identically. */
export const authorLabel = (
  author: Author | null | undefined,
): { text: string; agent: boolean } => {
  if (!author) {
    return { text: 'outside Notarium', agent: false }
  }
  switch (author.kind) {
    case 'agent':
      return {
        agent: true,
        text: author.mine
          ? author.name
            ? `your agent ${author.name}`
            : 'your agent'
          : author.name
            ? `${author.name}’s agent`
            : 'an agent',
      }
    case 'user':
      return { agent: false, text: author.mine ? 'you' : (author.name ?? 'someone') }
    case 'system':
      return { agent: false, text: 'system' }
    case 'external':
      return { agent: false, text: 'outside Notarium' }
  }
}
