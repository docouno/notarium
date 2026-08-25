// The user-facing half of the durable-text diagnostics (task 392), end to end over
// the production buildApp with the engine swapped: a note carrying a pre-fence byte
// READS fine, and the everyday action on that same note — pinning it — answers with
// the violating code point and its position instead of a bare-engine constant. The
// project auto-pin swallows the same refusal into the request log by design, so its
// proof observes the captured log line, not the response.

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp, type Fixture } from './app.js'

const fixture = (): Fixture => ({
  now: '2026-08-24T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        {
          id: 'dirty-note',
          title: 'Dirty import',
          filePath: 'dirty.md',
          content: 'first line\nse\u0000cond tail\n',
        },
        {
          id: 'team-page',
          title: 'Team',
          filePath: 'team/index.md',
          content: 'over\u0000view\n',
        },
        { id: 'clean-note', title: 'Clean', filePath: 'clean.md', content: 'all good\n' },
      ],
    },
  ],
})

let app: FastifyInstance

beforeEach(async () => {
  app = await createApp(fixture())
})
afterEach(async () => {
  await app.close()
})

describe('durable-text diagnostics over REST', () => {
  it('reads the dirty note back intact — the byte is content, not a quarantine', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/note?id=dirty-note' })

    expect(res.statusCode).toBe(200)
    expect(res.json().content).toContain('se\u0000cond')
  })

  it('answers a pin on the dirty note with the code point and position', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/note/pin',
      payload: { id: 'dirty-note', pinned: true },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain(
      'content contains a control character U+0000 at line 2, column 3',
    )
    expect(res.json().error).not.toContain('invalid durable string')
  })

  it('still pins a clean note', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/note/pin',
      payload: { id: 'clean-note', pinned: true },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, pinned: true })
  })

  it('marks a folder as a project when its dirty page refuses the auto-pin, and logs why', async () => {
    const logged = vi.spyOn(app.log, 'error')
    const res = await app.inject({
      method: 'POST',
      url: '/api/s/main/projects',
      payload: { folderPath: 'team', displayName: 'Team' },
    })

    expect(res.statusCode).toBe(201)
    const call = logged.mock.calls.find(
      (args) => typeof args[1] === 'string' && args[1].includes('auto-pin failed after mark'),
    )

    expect(call).toBeDefined()
    expect(String((call![0] as { err?: Error }).err?.message)).toContain(
      'content contains a control character U+0000 at line 1, column 5',
    )
  })
})
