import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// An imported AI-conversation note — Notarium's real bread-and-butter content
// (#223 import, and the very motivation for #236 mermaid / #237 math: "Notarium
// lives on ChatGPT/Claude exports"). Long alternating turns with code, a table
// and diagram/math fences — a realistic reader stress case that also stands in
// for imported material.

const THREAD = `# Designing the seed catalog — thread

> Imported from a Claude export. Long dialogue with code, a table and diagram/math fences.

## You

I need to fill dev stands with realistic data so the heatmap and feed don't look empty. What's the cleanest way?

## Assistant

The heatmap is derived from the revision journal, and the journal stamps \`now()\` — so any HTTP or import path lands everything on today. The honest way is an in-process seeder with an injected clock:

\`\`\`typescript
const store = new CachedStore({ inner: engine, revisionPersistence: metaDb.revisions, now: () => clock })
for (const e of events) { clock = new Date(e.date); await store.write(toWrite(e)); await store.settle() }
\`\`\`

That backdates each journal row to the authored date, with the correct chained \`base_rev\`.

## You

And how do I express the cases so both the fake backend and the real engine can use them?

## Assistant

One declarative timeline per case, two appliers. A quick comparison:

| Applier | Consumes | Backdated journal? |
|---|---|---|
| fake (\`caseToFixture\`) | reduced snapshot + activity | seeded rows |
| real (\`scripts/seed.ts\`) | replays the timeline | via injected clock |

The category of each journal row falls out of the chain position:

- \`base_rev\` NULL + write/restore → **created**
- \`base_rev\` non-null → **edited**
- \`kind = delete\` → **deleted**

## You

Can you sketch the data flow?

## Assistant

\`\`\`mermaid
graph LR
  Case[Case timeline] --> Fake[caseToFixture]
  Case --> Real[in-process seeder]
  Fake --> FB[fake backend]
  Real --> DB[(meta.db + files)]
\`\`\`

And the intensity of a day on the heatmap is just:

$$
I(d) = created(d) + edited(d) + deleted(d)
$$

## You

Great — that's exactly what I'll build.

## Assistant

> [!tip] One source, two appliers
> Keep the case a pure declaration; let each applier project it. The fake gets e2e/visual reproducibility, the real engine gets an honest, backdated stand.
`

/** A single long imported-thread note (plus a short index it links from). */
export const importThread: CaseSpec = {
  name: 'import-thread',
  description:
    'An imported ChatGPT/Claude conversation — long turns with code, a table and diagram/math fences (#223, motivates #236/#237).',
  axes: ['import', 'content'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })
    b.note({
      space: 'main',
      path: 'imports/2026-07-06-seed-catalog-thread.md',
      title: 'Designing the seed catalog — thread',
      content: THREAD,
      tags: ['import', 'chatgpt'],
      noteType: 'conversation',
      created: daysBefore(now, 6, 14),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'imports/index.md',
      title: 'Imported threads',
      content: '# Imported threads\n\n- [[Designing the seed catalog — thread]]',
      tags: ['import'],
      created: daysBefore(now, 6, 15),
      principal: 'user:sergey',
    })
    return b.build()
  },
}
