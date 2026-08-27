import { describe, expect, it } from 'vitest'

import { type MutationClaim, MutationCoordinator } from './mutationCoordinator'

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

  it('serializes equal opaque resources without treating them as paths or note ids', async () => {
    const coordinator = new MutationCoordinator()
    const gate = deferred()
    const order: string[] = []
    const first = coordinator.run({ resources: ['source:v1:a'] }, async () => {
      order.push('first:start')
      await gate.promise
      order.push('first:end')
    })
    const same = coordinator.run({ resources: ['source:v1:a'] }, async () => {
      order.push('same')
    })
    const different = coordinator.run({ resources: ['source:v1:b'] }, async () => {
      order.push('different')
    })

    await Promise.resolve()
    expect(order).toEqual(['first:start', 'different'])
    gate.resolve()
    await Promise.all([first, same, different])
    expect(order).toEqual(['first:start', 'different', 'first:end', 'same'])
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

  // Claims are not re-entrant and the queue is fair, so a task that takes one
  // while holding another can wait forever behind a waiter that wants what it
  // holds. Work reachable from BOTH a claimed and an unclaimed caller — the
  // identity drain — has to be able to tell the two apart at run time.
  it('reports whether the caller already holds a lease', async () => {
    const coordinator = new MutationCoordinator()

    expect(coordinator.holds()).toBe(false)
    await coordinator.run({ noteIds: ['a'] }, async () => {
      expect(coordinator.holds()).toBe(true)
      // Across an await, and inside a nested async call — the whole chain counts.
      await Promise.resolve()
      await (async () => expect(coordinator.holds()).toBe(true))()
    })
    expect(coordinator.holds()).toBe(false)

    // A lease held by SOMEONE ELSE is not this caller's lease: answering yes
    // there would send an unclaimed drain through under a stranger's claim.
    let outside: boolean | undefined
    const holding = coordinator.run({ noteIds: ['b'] }, async () => {
      outside = await Promise.resolve().then(() => coordinator.holds())
      await new Promise((done) => setTimeout(done, 5))
    })

    expect(coordinator.holds()).toBe(false)
    await holding
    expect(outside).toBe(true)
  })

  it('reports a runStable lease the same way', async () => {
    const coordinator = new MutationCoordinator()

    await coordinator.runStable(
      () => ({ noteIds: ['a'] }),
      async () => {
        expect(coordinator.holds()).toBe(true)
      },
    )
    expect(coordinator.holds()).toBe(false)
  })

  it('adopts a candidate a held prefix or a held global lease already reaches', async () => {
    const coordinator = new MutationCoordinator()
    const entered: string[] = []
    const adopt = (claim: MutationClaim, label: string) =>
      coordinator.runWithinHeld(claim, async () => {
        entered.push(label)
      })

    await coordinator.run(
      { noteIds: ['a'], paths: ['/one/a.md/'], prefixes: ['one/assets'] },
      async () => {
        await expect(
          adopt({ noteIds: ['a'], paths: ['one/a.md'] }, 'exact'),
        ).resolves.toBeUndefined()
        // A candidate PATH inside a held PREFIX is inside exactly the reach that
        // prefix already fences, so adopting it widens nothing…
        await expect(
          adopt({ noteIds: ['a'], paths: ['one/assets/icon.png'] }, 'under-prefix'),
        ).resolves.toBeUndefined()
        // …while a candidate PREFIX has to be one the lease itself took, and an
        // opaque RESOURCE has no containment order at all: only equality.
        await expect(adopt({ prefixes: ['one/assets/deep'] }, 'sub-prefix')).rejects.toThrow(
          /not covered by an active caller lease/i,
        )
        await expect(adopt({ resources: ['source:v1:a'] }, 'resource')).rejects.toThrow(
          /not covered by an active caller lease/i,
        )
      },
    )

    // A global lease fences everything, so it reaches both a narrow candidate and
    // a global one — the only lease that reaches a global candidate at all.
    await coordinator.run({ global: true }, async () => {
      await expect(
        adopt({ noteIds: ['a'], paths: ['one/a.md'] }, 'narrow-under-global'),
      ).resolves.toBeUndefined()
      await expect(adopt({ global: true }, 'global-under-global')).resolves.toBeUndefined()
    })

    expect(entered).toEqual(['exact', 'under-prefix', 'narrow-under-global', 'global-under-global'])
  })

  it('retains the lease until an admitted covered child settles', async () => {
    const coordinator = new MutationCoordinator()
    const childEntered = deferred()
    const releaseChild = deferred()
    const tryLateJoin = deferred()
    const order: string[] = []
    let child!: Promise<void>
    let lateJoin!: Promise<void>

    const outer = coordinator.run({ noteIds: ['a'] }, async () => {
      lateJoin = (async () => {
        await tryLateJoin.promise
        return coordinator.runWithinHeld({ noteIds: ['a'] }, async () => {
          order.push('late')
        })
      })()
      child = coordinator.runWithinHeld({ noteIds: ['a'] }, async () => {
        order.push('child:start')
        childEntered.resolve()
        await releaseChild.promise
        order.push('child:end')
      })
      await childEntered.promise
      order.push('outer:return')
    })

    await childEntered.promise
    const contender = coordinator.run({ noteIds: ['a'] }, async () => {
      order.push('contender')
    })
    const unrelated = coordinator.run({ noteIds: ['b'] }, async () => {
      order.push('unrelated')
    })

    await Promise.resolve()
    expect(order).toEqual(['child:start', 'outer:return', 'unrelated'])
    await new Promise<void>((resolve) => setImmediate(resolve))
    tryLateJoin.resolve()
    await expect(lateJoin).rejects.toThrow(/active caller lease/i)

    releaseChild.resolve()
    await Promise.all([outer, child, contender, unrelated])
    expect(order).toEqual(['child:start', 'outer:return', 'unrelated', 'child:end', 'contender'])
  })

  // A claimed callback that THROWS is the ordinary production path — every
  // failure cut runs through it — so the lease has to outlive a child that is
  // still inside it exactly as it does on the success path.
  it('retains the lease for a running child when the callback throws', async () => {
    const coordinator = new MutationCoordinator()
    const childEntered = deferred()
    const releaseChild = deferred()
    const order: string[] = []
    let child!: Promise<void>

    const outer = coordinator.run({ noteIds: ['a'] }, async () => {
      child = coordinator.runWithinHeld({ noteIds: ['a'] }, async () => {
        order.push('child:start')
        childEntered.resolve()
        await releaseChild.promise
        order.push('child:end')
      })
      await childEntered.promise
      throw new Error('boom')
    })

    await childEntered.promise
    const contender = coordinator.run({ noteIds: ['a'] }, async () => {
      order.push('contender')
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(order).toEqual(['child:start'])
    releaseChild.resolve()
    await expect(outer).rejects.toThrow('boom')
    await Promise.all([child, contender])
    expect(order).toEqual(['child:start', 'child:end', 'contender'])
  })

  it('refuses an uncovered candidate inside an active lease', async () => {
    const coordinator = new MutationCoordinator()
    const entered: string[] = []

    await coordinator.run({ noteIds: ['a'], paths: ['one/a.md'] }, async () => {
      // The lease is active and this IS its callback, so only the coverage test
      // on the candidate can keep these three outside it.
      await expect(
        coordinator.runWithinHeld({ noteIds: ['b'] }, async () => {
          entered.push('other-note')
        }),
      ).rejects.toThrow(/not covered by an active caller lease/i)
      await expect(
        coordinator.runWithinHeld({ global: true }, async () => {
          entered.push('global')
        }),
      ).rejects.toThrow(/not covered by an active caller lease/i)
      await expect(
        coordinator.runWithinHeld({ paths: ['two/b.md'] }, async () => {
          entered.push('other-path')
        }),
      ).rejects.toThrow(/not covered by an active caller lease/i)
      // …while the candidate the lease does cover still adopts it.
      await expect(
        coordinator.runWithinHeld({ noteIds: ['a'], paths: ['one/a.md'] }, async () => {
          entered.push('covered')
          return 'covered'
        }),
      ).resolves.toBe('covered')
    })

    expect(entered).toEqual(['covered'])
    // A refused candidate joined no lifetime: the lease is free immediately.
    await expect(
      coordinator.run({ noteIds: ['a'], paths: ['one/a.md'] }, async () => 'after'),
    ).resolves.toBe('after')
  })

  it('expires claim coverage when the lease callback finishes', async () => {
    const coordinator = new MutationCoordinator()
    const continueDetached = deferred()
    let detached!: Promise<void>

    await coordinator.run({ noteIds: ['a'] }, async () => {
      expect(coordinator.hasClaimContext()).toBe(true)
      await Promise.resolve()
      await expect(
        coordinator.runWithinHeld({ noteIds: ['a'] }, async () => undefined),
      ).resolves.toBeUndefined()

      detached = (async () => {
        await continueDetached.promise
        expect(coordinator.hasClaimContext()).toBe(true)
        expect(coordinator.holds()).toBe(false)
        return coordinator.runWithinHeld({ noteIds: ['a'] }, async () => undefined)
      })()
    })

    expect(coordinator.hasClaimContext()).toBe(false)
    continueDetached.resolve()
    await expect(detached).rejects.toThrow(/active caller lease/i)
  })

  it('expires claim coverage when the lease callback throws', async () => {
    const coordinator = new MutationCoordinator()
    const continueDetached = deferred()
    let detached!: Promise<unknown>

    await expect(
      coordinator.run({ noteIds: ['a'] }, async () => {
        detached = (async () => {
          await continueDetached.promise
          return coordinator.runWithinHeld({ noteIds: ['a'] }, async () => 'joined')
        })()
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // The failed lease is gone and the note belongs to the next caller: a
    // descendant that shows up afterwards must not join the dead claim beside it.
    const contender = coordinator.run({ noteIds: ['a'] }, async () => 'contender')

    continueDetached.resolve()
    await expect(detached).rejects.toThrow(/active caller lease/i)
    await expect(contender).resolves.toBe('contender')
  })

  it('does not attach manually acquired claims to the async caller', async () => {
    const coordinator = new MutationCoordinator()
    const release = await coordinator.acquire({ global: true })

    try {
      expect(coordinator.hasClaimContext()).toBe(false)
      expect(coordinator.holds()).toBe(false)
    } finally {
      release()
    }
  })
})
