import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

// Names in scripts the slug algebra cannot romanise (#296). A title picks the file
// name AND the key `[[wikilinks]]` resolve against, so a script with no romaniser used
// to slug to '' — every such note aimed at the one path `<dir>/.md` (a dot-file the
// scan hides, so the note died on the next boot) and shared the one empty resolve key
// (so the whole non-Latin corpus was one arbitrary note, or one merged ghost).
//
// The stand holds the states that flow FROM the fixed rule: five scripts living side
// by side in ONE folder, a uniquified pair, links that resolve across scripts, a
// broken non-Latin link that must stay its OWN ghost, a folder named in CJK, and a
// Cyrillic note proving romanisation did NOT change (nothing gets renamed).
//
// Deliberately NOT here: a title made only of emoji, whose file is named after the
// NOTE (`<id>.md`). The seed declares each note's path up front and pins it as the
// write's fileName, but the id rung is settled by the write itself — a seeded path
// could not agree with it, and the fake and the real stand would disagree about a
// state neither is wrong about. That rung is covered where it survives: the store
// contract (all four engine legs) and test/unit/cachedStoreMutations.test.ts.
export const nonLatinNames: CaseSpec = {
  name: 'non-latin-names',
  description:
    'Titles in scripts with no romaniser — CJK/Japanese/Hebrew/Thai/Korean side by side in one folder, a uniquified pair, cross-script wikilinks and a lone non-Latin ghost (#296).',
  axes: ['identity', 'graph', 'structure'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Main' })

    // Five scripts, ONE folder. Each used to be `journal/.md`, so the second create
    // was refused as a duplicate of a note with a visibly different title, and after a
    // restart the survivor read as deleted while its bytes sat on disk.
    b.note({
      space: 'main',
      path: 'journal/第三季度规划.md',
      title: '第三季度规划',
      content:
        '# 第三季度规划\n\nQ3 planning: hiring, the migration window, and what we are deliberately not doing.\n\nRelated: [[会議の議事録]].',
      created: daysBefore(now, 30),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'journal/会議の議事録.md',
      title: '会議の議事録',
      content: '# 会議の議事録\n\nMeeting minutes. Links back to [[第三季度规划]].',
      created: daysBefore(now, 28),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'journal/תוכניות-לרבעון.md',
      title: 'תוכניות לרבעון',
      content: '# תוכניות לרבעון\n\nQuarterly plans, right-to-left — a space is a separator.',
      created: daysBefore(now, 26),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'journal/แผนไตรมาส.md',
      title: 'แผนไตรมาส',
      content:
        '# แผนไตรมาส\n\nThai keeps its combining vowels — stripping marks would mangle the word, not romanise it.',
      created: daysBefore(now, 24),
      principal: 'user:sergey',
    })
    b.note({
      space: 'main',
      path: 'journal/안녕하세요.md',
      title: '안녕하세요',
      content:
        '# 안녕하세요\n\nHangul, recomposed to NFC — the decomposed jamo must never reach the disk.',
      created: daysBefore(now, 22),
      principal: 'user:sergey',
    })

    // A REAL duplicate of one of them: what "save under a free name" leaves behind
    // once the counter has a readable base to count from (it used to give `2.md`).
    b.note({
      space: 'main',
      path: 'journal/第三季度规划-2.md',
      title: '第三季度规划 2',
      content:
        '# 第三季度规划 2\n\nThe copy taken to rework the numbers without touching the original.',
      created: daysBefore(now, 20),
      principal: 'user:sergey',
    })

    // Mixed script: the romanisable half romanises, the rest keeps its letters.
    b.note({
      space: 'main',
      path: 'journal/roadmap-路线图.md',
      title: 'Roadmap 路线图',
      content: '# Roadmap 路线图\n\nHalf romanised, half kept — one name, one file.',
      created: daysBefore(now, 18),
      principal: 'user:sergey',
    })

    // A folder named in CJK. Folders have always landed on disk verbatim; it is the
    // FILE names that were rewritten, and that asymmetry is what the fix removes.
    b.note({
      space: 'main',
      path: '第三季度/交付清单.md',
      title: '交付清单',
      content: '# 交付清单\n\nDelivery checklist, in a folder whose own name is CJK too.',
      created: daysBefore(now, 16),
      principal: 'user:sergey',
    })

    // The resolver surface: two links that must resolve to real notes, and one that
    // must stay its OWN ghost. All three used to collapse onto the single empty key,
    // so the graph showed one ghost node named after whichever link came last.
    b.note({
      space: 'main',
      path: 'journal/linker.md',
      title: 'Cross-script links',
      content:
        '# Cross-script links\n\nResolves: [[第三季度规划]] and [[会議の議事録]].\n\nBroken on purpose, and its own ghost: [[缺失的笔记]].',
      created: daysBefore(now, 14),
      principal: 'user:sergey',
    })

    // Cyrillic, unchanged: it romanises exactly as before, so no existing vault is
    // renamed by the fix. `plany.md`, not `планы.md`.
    b.note({
      space: 'main',
      path: 'journal/plany.md',
      title: 'Планы',
      content: '# Планы\n\nRomanisation is untouched — this file is still `plany.md`.',
      created: daysBefore(now, 12),
      principal: 'user:sergey',
    })

    return b.build()
  },
}
