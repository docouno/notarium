// How the drill spells the fixture's options. Its own module because the drill itself
// is a Docker-only script no fast test can reach, and the spelling is load-bearing: a
// space id is 12 chars over an alphabet that includes `-`, so about one id in 4096
// begins with `--`, which the separate-argument form of the option parser refuses.

/** Mode plus options as ONE inline `--key=value` list. Inline is not a style choice —
 *  it is the only form whose value may start with a dash. */
export const fixtureArgv = (mode, options) => [
  mode,
  ...Object.entries(options).map(([key, value]) => `--${key}=${value}`),
]
