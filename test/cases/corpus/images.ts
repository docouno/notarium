import type { Fragment } from './types'

// Images (#235): the renderer decorates marked's own <img> with loading=lazy +
// decoding=async and the reader height-caps it. A broken URL, an alt-less image
// and a title had no repo fixture (harvest gap). External hosts only (a stand has
// no local blobs); a broken src is honest — it shows the browser's broken-image.
export const imagesFragments: Fragment[] = [
  {
    id: 'image-basic',
    feature: 'images',
    exercises: 'an image is lazy-loaded and decoded off the main thread',
    md: '![a landscape](https://picsum.photos/seed/reader-1/800/400)',
    refs: ['#235', 'markdown.test.ts'],
    expect: { contains: ['loading="lazy"', 'decoding="async"', 'alt="a landscape"'] },
  },
  {
    id: 'image-title-alt',
    feature: 'images',
    exercises: 'an image with a title attribute and descriptive alt text',
    md: '![Notarium logo](https://picsum.photos/seed/logo/200/200 "The mascot, Nota")',
    refs: ['harvest-gap'],
    expect: { contains: ['loading="lazy"', 'title="The mascot, Nota"'] },
  },
  {
    id: 'image-broken',
    feature: 'images',
    exercises: 'a broken image URL still renders an <img> (honest broken-image at runtime)',
    md: '![missing cover](https://example.test/does-not-exist.png)',
    refs: ['harvest-gap', 'base.json'],
    expect: { contains: ['<img', 'src="https://example.test/does-not-exist.png"'] },
  },
  {
    id: 'image-no-alt',
    feature: 'images',
    exercises: 'an image with empty alt text',
    md: '![](https://picsum.photos/seed/noalt/400/300)',
    refs: ['harvest-gap'],
    expect: { contains: ['loading="lazy"', 'alt=""'] },
  },
]
