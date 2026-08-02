// Inlined by tsup (see tsup.config.ts); the fallback is what the unbundled tsx run
// prints, where no `define` ran.
const VERSION = process.env.NOTARIUM_CLI_VERSION ?? '0.0.0-dev'

export const runVersion = () => {
  process.stdout.write(`notarium ${VERSION}\n`)
}
