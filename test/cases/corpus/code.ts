import type { Fragment } from './types'

// Fenced code (#115): hljs over a curated ~25-language set, class-based output
// (`hljs language-<lang>`). A recognised tag highlights; an UNTAGGED fence auto-
// detects; an unknown/`text` tag renders verbatim (never guess). `~~~` fences,
// a no-language fence and a very long line had no repo fixture (harvest gap).
export const codeFragments: Fragment[] = [
  {
    id: 'code-typescript',
    feature: 'code',
    exercises: 'a TypeScript fence highlights with class-based hljs output',
    md: '```typescript\nexport function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n```',
    refs: ['#115', 'readerShowcase', 'highlight.ts'],
    expect: { contains: ['language-typescript', 'hljs'] },
  },
  {
    id: 'code-languages',
    feature: 'code',
    exercises: 'python / rust / sql / diff / bash — five more of the curated languages',
    md: [
      '```python',
      'def fib(n: int) -> int:',
      '    return n if n < 2 else fib(n - 1) + fib(n - 2)',
      '```',
      '',
      '```rust',
      'fn main() { println!("sum = {}", (1..=3).sum::<i32>()); }',
      '```',
      '',
      '```sql',
      'SELECT date(created_at) AS day, count(*) FROM note_revisions GROUP BY day;',
      '```',
      '',
      '```diff',
      '- const now = Date.now()',
      '+ const now = this.now()',
      '```',
      '',
      '```bash',
      'make seed CASE=reader-showcase',
      '```',
    ].join('\n'),
    refs: ['#115', 'readerShowcase', 'highlight.ts'],
    expect: {
      contains: [
        'language-python',
        'language-rust',
        'language-sql',
        'language-diff',
        'language-bash',
      ],
    },
  },
  {
    id: 'code-untagged-autodetect',
    feature: 'code',
    exercises: 'an untagged fence auto-detects a language over the registered set',
    md: '```\nconst answer = 42\nconsole.log(answer)\n```',
    refs: ['#115', 'highlight.ts'],
    // `hljs-` token span proves auto-detect actually tokenised — the `hljs` class alone
    // is added to EVERY untagged fence (emptyLangClass), so it can't prove detection.
    expect: { contains: ['<code class="hljs', 'hljs-'] },
  },
  {
    id: 'code-plaintext',
    feature: 'code',
    exercises: 'a `text` fence renders verbatim — no language is guessed',
    md: '```text\nJust some plain log output — do not colourise me.\n```',
    refs: ['#115', 'highlight.ts'],
    expect: { contains: ['language-text'] },
  },
  {
    id: 'code-tilde-fence',
    feature: 'code',
    exercises: 'a ~~~ fence is a code block too (wikilink/math must not fire inside)',
    md: '~~~js\nconst x = [[NotAWikiLink]]\n~~~',
    refs: ['harvest-gap', 'markdown.test.ts'],
    expect: { contains: ['language-js'], excludes: ['#wiki/'] },
  },
  {
    id: 'code-long-line',
    feature: 'code',
    exercises: 'a very long single line inside a code block scrolls, not wraps',
    md: '```json\n{ "veryLongKeyThatKeepsGoing": "and a very long value that keeps going and going and going and going and going and going far past the reading column width" }\n```',
    refs: ['harvest-gap', '#235'],
    expect: { contains: ['language-json'] },
  },
  {
    id: 'code-inline',
    feature: 'code',
    exercises: 'inline code with angle brackets is escaped, not parsed',
    md: 'Call `arr.map<T>((x) => x)` and `a < b && c > d` inline.',
    refs: ['#235'],
    expect: { contains: ['<code>', '&lt;'] },
  },
]
