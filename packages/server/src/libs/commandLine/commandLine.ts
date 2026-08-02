// Small, strict parser for the image CLI. We deliberately keep the public
// surface dependency-free and reject typos instead of silently ignoring them.

export type CommandOptionKind = 'boolean' | 'value'

export type ParsedCommandLine = {
  positionals: string[]
  provided: string[]
  has: (name: string) => boolean
  value: (name: string) => string | undefined
}

export const parseCommandLine = (
  args: readonly string[],
  specification: Readonly<Record<string, CommandOptionKind>>,
): ParsedCommandLine => {
  const positionals: string[] = []
  const options = new Map<string, string | true>()
  let optionsEnded = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string

    if (!optionsEnded && arg === '--') {
      optionsEnded = true
      continue
    }
    if (optionsEnded || !arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }

    const separator = arg.indexOf('=')
    const name = arg.slice(2, separator === -1 ? undefined : separator)
    const kind = specification[name]

    if (!kind) {
      throw new Error(`unknown option --${name || arg}`)
    }
    if (options.has(name)) {
      throw new Error(`option --${name} may be provided only once`)
    }
    if (kind === 'boolean') {
      if (separator !== -1) {
        throw new Error(`option --${name} does not accept a value`)
      }
      options.set(name, true)
      continue
    }

    const inline = separator === -1 ? undefined : arg.slice(separator + 1)
    const next = inline ?? args[index + 1]

    if (
      next === undefined ||
      next.length === 0 ||
      (inline === undefined && next.startsWith('--'))
    ) {
      throw new Error(`option --${name} requires a value`)
    }
    if (inline === undefined) {
      index += 1
    }
    options.set(name, next)
  }

  return {
    positionals,
    provided: [...options.keys()],
    has: (name) => options.has(name),
    value: (name) => {
      const value = options.get(name)
      return typeof value === 'string' ? value : undefined
    },
  }
}
