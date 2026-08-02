// canon: docs/cli.md#npm-cli

import { helpText } from './commands/help'
import { resolveCommand } from './resolve'

// A reader may close the pipe before we finish writing (`npx notarium | head -1`):
// that is the consumer being done, not this CLI failing. Every other write failure
// still has to be loud — registering this listener is what takes Node's own
// unhandled-error exit away, so the non-EPIPE branch has to replace it.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') {
    process.exit(0)
  }

  process.stderr.write(`notarium: ${error.message}\n`)
  process.exit(1)
})

const resolution = resolveCommand(process.argv.slice(2))

if ('error' in resolution) {
  process.stderr.write(`notarium: ${resolution.error}\n\n${helpText}`)
  process.exit(1)
}

resolution.run()
