// @vitest-environment jsdom
//
// Corpus honesty (#175): every content Fragment is rendered through the REAL reader
// pipeline — `renderMarkdown` (marked + all reader extensions + the DOMPurify pass) —
// and checked against its declared `expect`. This is what makes the corpus "not for
// show": a fragment can never claim a rendering the reader doesn't actually produce,
// and a security payload is proven inert against the actual sanitiser.
//
// This is the ONE test that needs a DOM (DOMPurify), hence the jsdom docblock above —
// the rest of the suite stays node-only. renderMarkdown is imported from the web
// package; importing it registers the marked extensions and runs KaTeX synchronously.
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../packages/web/src/libs/markdown/markdown/markdown'
import { CORPUS } from './corpus'

describe('corpus honesty — every fragment renders as claimed', () => {
  it('has a non-empty corpus', () => {
    expect(CORPUS.length).toBeGreaterThan(50)
  })

  for (const f of CORPUS) {
    it(`${f.feature}/${f.id} — ${f.exercises}`, () => {
      let html = ''
      expect(() => {
        html = renderMarkdown(f.md)
      }, 'renders without throwing').not.toThrow()

      for (const needle of f.expect?.contains ?? []) {
        expect(html, `must contain ${JSON.stringify(needle)}`).toContain(needle)
      }
      for (const needle of f.expect?.excludes ?? []) {
        expect(html, `must NOT contain ${JSON.stringify(needle)}`).not.toContain(needle)
      }
      for (const [needle, min] of Object.entries(f.expect?.containsCount ?? {})) {
        const count = html.split(needle).length - 1
        expect(
          count,
          `must contain ${JSON.stringify(needle)} at least ${min}× (got ${count})`,
        ).toBeGreaterThanOrEqual(min)
      }

      if (f.expect?.security) {
        // Parse the SANITISED html into a live DOM and assert nothing dangerous
        // survives as a real node/attribute. This is stricter and truer than a string
        // scan: an escaped payload shown as visible text (e.g. `&lt;img onerror=…&gt;`
        // inside a mermaid code block) is inert and must not trip the check.
        const doc = new DOMParser().parseFromString(html, 'text/html')
        expect(doc.querySelector('script'), 'no live <script> element').toBeNull()
        const handlered = [...doc.querySelectorAll('*')].find((el) =>
          [...el.attributes].some((a) => /^on/i.test(a.name)),
        )
        expect(handlered, 'no live inline event handler').toBeUndefined()
        const badUrl = [...doc.querySelectorAll('[href],[src]')].find((el) =>
          /^\s*(?:javascript:|vbscript:|data:text\/html)/i.test(
            (el.getAttribute('href') || el.getAttribute('src') || '').trim(),
          ),
        )
        expect(badUrl, 'no javascript:/vbscript:/data:text/html URL in an href/src').toBeUndefined()
      }
    })
  }
})
