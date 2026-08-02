// Names the environment gates behind `npm test`'s skip count.
// canon: docs/dev-environment.md#invariants

import type { File, Task } from '@vitest/runner'
import type { Vitest } from 'vitest/node'
import type { Reporter } from 'vitest/reporters'

const GATE = /\[gate: ([^\]]+)\]/

const leaves = (tasks: Task[], out: Task[] = []): Task[] => {
  for (const task of tasks) {
    if (task.type === 'test' || task.type === 'custom') {
      out.push(task)
    } else if (task.type === 'suite') {
      leaves(task.tasks, out)
    }
  }

  return out
}

/** The gate this case sat out for, or null when nothing declared one.
 *
 *  Only a node that is ITSELF skipped may answer: vitest also stamps `mode: 'skip'`
 *  on every case of a suite whose `beforeAll` threw, and those must not be read as
 *  "the gate was closed" — a live-Postgres suite that failed to connect would
 *  otherwise be reported as "run `make test-pg`", which is exactly the plausible
 *  total this reporter exists to prevent. They surface as `unlabelled` instead. */
const gateOf = (task: Task): string | null => {
  for (let node: Task | undefined = task; node; node = node.suite) {
    if (node.mode !== 'skip') {
      continue
    }
    const found = GATE.exec(node.name)

    if (found) {
      return found[1]
    }
  }

  return null
}

/** Groups skips by their `[gate: <what> (<how to run it>)]` marker — the domain stays
 *  in the gate modules, so a gate added later is summarized without touching this. */
export default class SkipSummary implements Reporter {
  private ctx?: Vitest

  onInit(ctx: Vitest): void {
    this.ctx = ctx
  }

  onFinished(files: File[] = []): void {
    // `-t` skips everything that does not match, so every gate attribution would be
    // an artefact of the filter rather than of the environment.
    if (this.ctx?.config.testNamePattern) {
      return
    }
    // In watch mode `files` holds only the reran ones; the state has the whole run,
    // matching the count the default reporter just printed.
    const all = this.ctx?.state.getFiles() ?? files
    // `todo` is a different bucket in that count, and never a gate.
    const skipped = leaves(all).filter((task) => task.mode === 'skip')

    if (!skipped.length) {
      return
    }
    const counts = new Map<string, number>()

    for (const task of skipped) {
      const gate = gateOf(task) ?? 'unlabelled'

      counts.set(gate, (counts.get(gate) ?? 0) + 1)
    }
    const groups = [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([gate, count]) => `${count} ${gate}`)
      .join(', ')
    const line = `\n  ⇢ ${skipped.length} skipped: ${groups}\n`

    // The vitest logger, when there is one: it coordinates with the TTY renderer and
    // honours `outputFile`, which a bare console.log does not.
    if (this.ctx) {
      this.ctx.logger.log(line)
    } else {
      console.log(line)
    }
  }
}
