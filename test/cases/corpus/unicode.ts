import type { Fragment } from './types'

// Non-latin & multilingual content. The reading fonts bundle latin / latin-ext /
// cyrillic / greek / vietnamese subsets and fall to the OS font for CJK/Arabic/Hebrew
// (reading-typography.md). RTL scripts and emoji-in-body/heading had NO repo fixture
// (harvest gap) — and a stand for a RU-first team must read correctly in Cyrillic.
export const unicodeFragments: Fragment[] = [
  {
    id: 'unicode-cyrillic',
    feature: 'unicode',
    exercises: 'a Cyrillic note body with inline markup (RU is first-class)',
    md: '# Важная заметка\n\nТекст со **полужирным** и [ссылкой](https://example.com).\n\n> Цитата на русском.',
    refs: ['#71', 'editor.md', 'metaDb.test.ts'],
    expect: { contains: ['Важная', '<strong>полужирным</strong>'] },
  },
  {
    id: 'unicode-latin-ext',
    feature: 'unicode',
    exercises: 'latin-ext scripts — Polish, Czech, Turkish, Vietnamese diacritics',
    md: '- Polish: Zażółć gęślą jaźń\n- Czech: Příliš žluťoučký kůň úpěl ďábelské ódy\n- Turkish: İstanbul’da iyi günler\n- Vietnamese: Tiếng Việt rất đẹp',
    refs: ['reading-typography.md', 'harvest-gap'],
    // `<li` proves the list actually rendered (not a raw passthrough of the source text).
    expect: { contains: ['<li>', 'Zażółć', 'Tiếng Việt'] },
  },
  {
    id: 'unicode-greek',
    feature: 'unicode',
    exercises: 'Greek text (a bundled subset)',
    md: '## Ελληνικά\n\nΤα μαθηματικά είναι η γλώσσα του σύμπαντος.',
    refs: ['reading-typography.md'],
    expect: { contains: ['<h2', 'Ελληνικά'] },
  },
  {
    id: 'unicode-cjk',
    feature: 'unicode',
    exercises: 'CJK content (falls back to the OS font, no bundled subset)',
    md: '# 你好世界\n\n中文内容测试。日本語のテキストもあります。한국어 텍스트도 있습니다.',
    refs: ['reading-typography.md', 'spaces.spec.ts'],
    expect: { contains: ['<h1', '你好世界', '日本語'] },
  },
  {
    id: 'unicode-rtl',
    feature: 'unicode',
    exercises: 'right-to-left scripts — Arabic and Hebrew (harvest gap)',
    md: '## اللغة العربية\n\nمرحبا بالعالم. هذه فقرة باللغة العربية للاختبار.\n\n## עברית\n\nשלום עולם. זהו טקסט בעברית לבדיקה.',
    refs: ['harvest-gap'],
    expect: { contains: ['<h2', 'مرحبا بالعالم', 'שלום עולם'] },
  },
  {
    id: 'unicode-emoji',
    feature: 'unicode',
    exercises: 'emoji in a heading and body (harvest gap)',
    md: '## 🚀 Launch checklist\n\nShip it 🎉 — thumbs up 👍 from the team. Family: 👨‍👩‍👧‍👦 (a ZWJ sequence).',
    refs: ['harvest-gap'],
    expect: { contains: ['<h2', '🚀', '🎉'] },
  },
]
