import { expect, test } from './fixtures'

// PWA install + theme-color (#40). The service worker itself is OFF in the test
// build (VITE_PWA=off — see playwright.config), so this covers the parts that
// live in the app, not the SW: the install affordance (driven by PwaProvider via
// beforeinstallprompt) and the runtime <meta name="theme-color"> that follows the
// theme. The SW precache/offline/update flow is verified live against a prod build.

test('theme-color meta follows the chosen theme', async ({ page }) => {
  await page.goto('/')
  const meta = page.locator('meta[name="theme-color"]')
  // Default theme is dark → the dark --bg (tokens.scss).
  await expect(meta).toHaveAttribute('content', '#151517')

  await page.goto('/settings/appearance')
  const themeGroup = page.getByRole('group', { name: 'Theme' })
  await themeGroup.getByRole('button', { name: 'Light' }).click()
  await expect(meta).toHaveAttribute('content', '#ffffff')

  await themeGroup.getByRole('button', { name: 'Dark' }).click()
  await expect(meta).toHaveAttribute('content', '#151517')
})

test('install section offers an Install button once the browser allows it', async ({ page }) => {
  await page.goto('/settings/about')
  // Before any beforeinstallprompt, the section is present with an honest
  // "use your browser" hint (headless Chrome won't fire the real event).
  await expect(page.getByTestId('about-install')).toBeVisible()
  await expect(page.getByTestId('install-unavailable')).toBeVisible()
  await expect(page.getByTestId('install-button')).toHaveCount(0)

  // Simulate the browser deeming the app installable. PwaProvider captured the
  // listener at boot, so dispatching the event flips the section to the button.
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt') as Event & {
      prompt: () => Promise<void>
      userChoice: Promise<{ outcome: string; platform: string }>
    }

    e.prompt = () => {
      window.__pwaPrompted = true
      return Promise.resolve()
    }
    e.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' })
    window.dispatchEvent(e)
  })

  const installBtn = page.getByTestId('install-button')
  await expect(installBtn).toBeVisible()
  await installBtn.click()
  // The native prompt was invoked.
  await expect.poll(() => page.evaluate(() => window.__pwaPrompted === true)).toBe(true)

  // Completing the install (the browser's appinstalled event) flips the status.
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')))
  await expect(page.getByTestId('install-status')).toBeVisible()
})
