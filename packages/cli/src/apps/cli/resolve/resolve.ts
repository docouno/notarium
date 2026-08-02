import { runHelp } from '../commands/help'
import { runVersion } from '../commands/version'

const COMMAND = {
  help: runHelp,
  version: runVersion,
} as const

const ALIAS = {
  '--help': 'help',
  '--version': 'version',
  '-h': 'help',
  '-v': 'version',
} as const

export type Resolution = { run: () => void } | { error: string }

// Own-property lookups, not plain indexing: `notarium constructor` must be an
// unknown command, not a call into Object.prototype.
export const resolveCommand = (args: string[]): Resolution => {
  const [requested = 'help', ...rest] = args
  const name = Object.hasOwn(ALIAS, requested) ? ALIAS[requested as keyof typeof ALIAS] : requested

  if (!Object.hasOwn(COMMAND, name)) {
    return { error: `unknown command "${requested}"` }
  }

  if (rest.length > 0) {
    return { error: `unexpected argument "${rest[0]}"` }
  }

  return { run: COMMAND[name as keyof typeof COMMAND] }
}
