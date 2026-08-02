import { expect, type Page, test } from './fixtures'

// #176 — auto-hide scrollbars + inset strictly between the glass bands. The bar's
// PAINT (the opacity fade, the transparent button-inset) is WebKit chrome the headless
// renderer never rasterises, so these specs assert the DOM-observable CONTRACT that
// drives it — exactly what a real browser then paints:
//   • --sb-op   the 0→1 opacity useAutoHideScrollbars animates per frame (styles/base.scss
//               multiplies the thumb colour by it). Snaps to 1 on scroll / edge-hover,
//               eases to 0 after ~1.4s idle.
//   • --sb-inset-top / --sb-inset-bottom  each surface sets these from the height of the
//               glass band above/below it; the ::-webkit-scrollbar-button caps read them
//               so the thumb can't travel under the chrome.
// The visual finish (fade smoothness, the inset gap) is verified live on a real browser
// (make seed CASE=long-document) — headless can't show it, so we don't fake that here.

// A note long enough to overflow the reader's content-scroll, so it has a real bar.
const LONG_BODY =
  '# The Long One\n\n' +
  Array.from(
    { length: 140 },
    (_, i) => `Paragraph ${i + 1}. ${'lorem ipsum dolor sit amet '.repeat(10)}`,
  ).join('\n\n')

const FIXTURE = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        {
          title: 'Long One',
          filePath: 'long.md',
          modifiedAt: '2026-06-09T00:00:00.000Z',
          createdAt: '2026-06-01T09:00:00.000Z',
          tags: [],
          content: LONG_BODY,
        },
      ],
    },
  ],
}
const LONG_ID = 'fake-long'

// The controller's idle window (1400ms) + fade (220ms); wait past both before asserting hidden.
const IDLE_AND_FADE = 1900

const content = (page: Page) => page.getByTestId('content-scroll')
// --sb-op is written as an INLINE style by the controller; read it there (empty = unset).
const opOf = (loc: ReturnType<Page['getByTestId']>) =>
  loc.evaluate((el: HTMLElement) => el.style.getPropertyValue('--sb-op') || '')
const insetOf = (loc: ReturnType<Page['getByTestId']>, side: 'top' | 'bottom') =>
  loc.evaluate(
    (el: HTMLElement, s: string) => getComputedStyle(el).getPropertyValue(`--sb-inset-${s}`).trim(),
    side,
  )

test.use({ viewport: { width: 1280, height: 700 } })

test('a scroll shows the bar (--sb-op→1), then it fades out after idle (#176)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto(`/n/${LONG_ID}`)
  await expect(content(page)).toBeVisible()
  // The reader scroller genuinely overflows (a bar exists to hide).
  await expect
    .poll(() => content(page).evaluate((el: HTMLElement) => el.scrollHeight > el.clientHeight + 20))
    .toBe(true)

  // At rest before any interaction: unset → the base rule's default (visible), untouched.
  expect(await opOf(content(page))).toBe('')

  // A real scroll snaps the bar to full opacity (the controller's capture-phase listener).
  await content(page).evaluate((el: HTMLElement) => el.scrollTo({ top: 900 }))
  await expect.poll(() => opOf(content(page))).toBe('1.000')

  // Left idle, it eases to fully hidden and stays there.
  await expect.poll(() => opOf(content(page)), { timeout: IDLE_AND_FADE + 1500 }).toBe('0.000')
})

test('a hidden bar reveals on edge-hover but NOT on content-hover (#176)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto(`/n/${LONG_ID}`)
  await expect(content(page)).toBeVisible()

  // Drive it to hidden: scroll, then wait out the idle+fade.
  await content(page).evaluate((el: HTMLElement) => el.scrollTo({ top: 900 }))
  await expect.poll(() => opOf(content(page)), { timeout: IDLE_AND_FADE + 1500 }).toBe('0.000')

  const box = (await content(page).boundingBox())!
  // Pointer over the CONTENT (left of the gutter) must NOT wake the bar — it shouldn't
  // sit on while you read.
  await page.mouse.move(box.x + 120, box.y + box.height / 2)
  await page.waitForTimeout(120)
  expect(await opOf(content(page))).toBe('0.000')

  // Pointer into the right-edge gutter band (where the bar lives) reveals it.
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2)
  await expect.poll(() => opOf(content(page))).toBe('1.000')
})

test('inset vars sit the thumb between the glass bands, per surface (#176)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto(`/n/${LONG_ID}`)
  await expect(content(page)).toBeVisible()

  // Reader: topbar band inset on top, nothing below (no bottom glass in read mode). The
  // bottom reads '0px' (not unset) because base.scss resets --sb-inset-* on * to block
  // inheritance into nested scrollers — see the inheritance test below.
  expect(await insetOf(content(page), 'top')).toBe('52px')
  expect(await insetOf(content(page), 'bottom')).toBe('0px')

  // The rail's inset equals the measured floating-head band it reclaims with padding-top
  // (same single source — they must not drift).
  const rail = page.getByTestId('rail-scroll')
  const railInset = await insetOf(rail, 'top')
  const railPad = await rail.evaluate((el: HTMLElement) => getComputedStyle(el).paddingTop)
  expect(railInset).not.toBe('')
  expect(railInset).toBe(railPad)

  // Editor: entering edit floats a glass status bar over the bottom → a bottom inset
  // appears (its height), while the top band inset stays. Poll the var itself (the
  // meaningful signal) rather than the CSS-module class name.
  await page.getByRole('button', { name: /^edit$/i }).click()
  await expect.poll(() => insetOf(content(page), 'bottom')).toBe('30px')
  expect(await insetOf(content(page), 'top')).toBe('52px')

  // Preview hides the glass status bar → the bottom inset must drop to 0 (no phantom cap
  // under a bar that isn't there). Back to Edit restores it.
  await page.getByRole('button', { name: /^preview$/i }).click()
  await expect.poll(() => insetOf(content(page), 'bottom')).toBe('0px')
  await page.getByRole('button', { name: /^edit$/i }).click()
  await expect.poll(() => insetOf(content(page), 'bottom')).toBe('30px')
})

test('inset does NOT inherit into a nested scroller inside an inset surface (#176)', async ({
  page,
  baseURL,
}) => {
  // The inset is a global ::-webkit-scrollbar-button rule reading inheriting vars; without
  // the base.scss `* { --sb-inset-*: 0 }` reset, a popup list nested inside an inset
  // surface (the editor combo menu, the CodeMirror autocomplete) would inherit the
  // surface's inset and get a phantom transparent cap. Assert a nested element falls back
  // to 0, while the surface itself keeps its 52px.
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.goto(`/n/${LONG_ID}`)
  await expect(content(page)).toBeVisible()
  const probe = await content(page).evaluate((el: HTMLElement) => {
    const surface = getComputedStyle(el).getPropertyValue('--sb-inset-top').trim()
    const d = document.createElement('div')
    el.appendChild(d)
    const nestedTop = getComputedStyle(d).getPropertyValue('--sb-inset-top').trim()
    const nestedOp = getComputedStyle(d).getPropertyValue('--sb-op').trim()
    d.remove()
    return { surface, nestedTop, nestedOp }
  })
  expect(probe.surface).toBe('52px') // the opt-in surface keeps its inset
  expect(probe.nestedTop).toBe('0px') // a nested scroller does NOT inherit it
  expect(probe.nestedOp).toBe('1') // nor the fade
})
