/** `grant` has no options: everything after the command is literal positional
 *  data. Insert the parser's option terminator so a valid opaque space id that
 *  begins with `--` is not misread as an option. Preserve an operator-supplied
 *  terminator without turning it into a positional. */
export const normalizeAdminArguments = (args: readonly string[]): string[] => {
  if (args[0] !== 'grant') {
    return [...args]
  }
  const tail = [...args.slice(1)]
  const separator = tail.indexOf('--')

  if (separator >= 0) {
    tail.splice(separator, 1)
  }

  return ['grant', '--', ...tail]
}
