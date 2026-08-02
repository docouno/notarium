import { describe, expect, it } from 'vitest'

import { MutationCoordinator } from './mutationCoordinator'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('MutationCoordinator', () => {
  it('serializes the same note id and releases the follower after a failure', async () => {
    const coordinator = new MutationCoordinator()
    const gate = deferred()
    const order: string[] = []
    const first = coordinator.run({ noteIds: ['n-1'] }, async () => {
      order.push('first:start')
      await gate.promise
      order.push('first:fail')
      throw new Error('boom')
    })
    const second = coordinator.run({ noteIds: ['n-1'] }, async () => {
      order.push('second')
    })

    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    gate.resolve()
    await expect(first).rejects.toThrow('boom')
    await second
    expect(order).toEqual(['first:start', 'first:fail', 'second'])
  })

  it('fences exact child paths against source and destination folder prefixes', async () => {
    const coordinator = new MutationCoordinator()
    const gate = deferred()
    const order: string[] = []
    const folder = coordinator.run({ prefixes: ['from', 'to'] }, async () => {
      order.push('folder:start')
      await gate.promise
      order.push('folder:end')
    })
    const sourceChild = coordinator.run({ paths: ['from/a.md'] }, async () => {
      order.push('source-child')
    })
    const destinationChild = coordinator.run({ paths: ['/to/nested/b.md/'] }, async () => {
      order.push('destination-child')
    })

    await Promise.resolve()
    expect(order).toEqual(['folder:start'])
    gate.resolve()
    await Promise.all([folder, sourceChild, destinationChild])
    expect(order.slice(0, 2)).toEqual(['folder:start', 'folder:end'])
    expect(new Set(order.slice(2))).toEqual(new Set(['source-child', 'destination-child']))
  })

  it('does not let a later child overtake an earlier waiting folder fence', async () => {
    const coordinator = new MutationCoordinator()
    const firstGate = deferred()
    const folderGate = deferred()
    const order: string[] = []
    const firstChild = coordinator.run({ paths: ['tree/a.md'] }, async () => {
      order.push('first-child:start')
      await firstGate.promise
      order.push('first-child:end')
    })
    const folder = coordinator.run({ prefixes: ['tree'] }, async () => {
      order.push('folder:start')
      await folderGate.promise
      order.push('folder:end')
    })
    const laterChild = coordinator.run({ paths: ['tree/b.md'] }, async () => {
      order.push('later-child')
    })

    await Promise.resolve()
    expect(order).toEqual(['first-child:start'])
    firstGate.resolve()
    await firstChild
    await Promise.resolve()
    expect(order).toEqual(['first-child:start', 'first-child:end', 'folder:start'])
    folderGate.resolve()
    await Promise.all([folder, laterChild])
    expect(order).toEqual([
      'first-child:start',
      'first-child:end',
      'folder:start',
      'folder:end',
      'later-child',
    ])
  })

  it('keeps independent notes concurrent', async () => {
    const coordinator = new MutationCoordinator()
    const gate = deferred()
    const entered: string[] = []
    const a = coordinator.run({ noteIds: ['a'], paths: ['one/a.md'] }, async () => {
      entered.push('a')
      await gate.promise
    })
    const b = coordinator.run({ noteIds: ['b'], paths: ['two/b.md'] }, async () => {
      entered.push('b')
      await gate.promise
    })

    await Promise.resolve()
    expect(entered).toEqual(['a', 'b'])
    gate.resolve()
    await Promise.all([a, b])
  })

  it('uses a global claim as a quiescence checkpoint for every resource', async () => {
    const coordinator = new MutationCoordinator()
    const noteGate = deferred()
    const globalGate = deferred()
    const order: string[] = []
    const note = coordinator.run({ noteIds: ['a'] }, async () => {
      order.push('note:start')
      await noteGate.promise
      order.push('note:end')
    })
    const global = coordinator.run({ global: true }, async () => {
      order.push('global:start')
      await globalGate.promise
      order.push('global:end')
    })
    const unrelated = coordinator.run({ paths: ['other.md'] }, async () => {
      order.push('unrelated')
    })

    await Promise.resolve()
    expect(order).toEqual(['note:start'])
    noteGate.resolve()
    await note
    expect(order).toEqual(['note:start', 'note:end', 'global:start'])
    globalGate.resolve()
    await Promise.all([global, unrelated])
    expect(order).toEqual(['note:start', 'note:end', 'global:start', 'global:end', 'unrelated'])
  })

  it('reacquires a mutable claim without letting a later conflicting waiter overtake it', async () => {
    const coordinator = new MutationCoordinator()
    const moveGate = deferred()
    const firstEntered = deferred()
    const firstRelease = deferred()
    const order: string[] = []
    let currentPath = 'from/a.md'

    const critical = async (name: string) => {
      order.push(`${name}:start`)
      firstEntered.resolve()
      await firstRelease.promise
      order.push(`${name}:end`)
    }
    const move = coordinator.run({ prefixes: ['from', 'moved'] }, async () => {
      order.push('move:start')
      await moveGate.promise
      currentPath = 'moved/a.md'
      order.push('move:end')
    })
    const save = coordinator.runStable(
      () => ({ noteIds: ['a'], paths: [currentPath] }),
      () => critical('save'),
    )
    const contender = coordinator.run({ noteIds: ['a'], paths: ['moved/a.md'] }, () =>
      critical('contender'),
    )

    await Promise.resolve()
    expect(order).toEqual(['move:start'])
    moveGate.resolve()
    await move
    await firstEntered.promise
    expect(order.at(-1)).toBe('save:start')
    firstRelease.resolve()
    await Promise.all([save, contender])
    expect(order).toEqual([
      'move:start',
      'move:end',
      'save:start',
      'save:end',
      'contender:start',
      'contender:end',
    ])
  })

  it('releases its claim when a stable revalidation throws', async () => {
    const coordinator = new MutationCoordinator()
    let derivations = 0
    const broken = coordinator.runStable(
      () => {
        derivations += 1
        if (derivations === 2) {
          throw new Error('snapshot unavailable')
        }

        return { noteIds: ['a'] }
      },
      async () => undefined,
    )

    await expect(broken).rejects.toThrow('snapshot unavailable')
    await expect(coordinator.run({ noteIds: ['a'] }, async () => 'released')).resolves.toBe(
      'released',
    )
  })
})
