import { FIELD_COLOR } from '@notarium/contract/enums'
import { expect, test } from './fixtures'

test('all semantic primitives share every readable tone in light and dark', async ({ page }) => {
  await page.goto('/__test/semantic-palette')
  // This proof samples the steady semantic endpoints, not a halfway frame of a
  // button's hover/theme background transition. Disable only the plate's cosmetic
  // transitions so switching the root variables is atomic for the color sampler.
  await page.addStyleTag({
    content: '[data-testid="semantic-palette-plate"] * { transition: none !important; }',
  })
  const plate = page.getByTestId('semantic-palette-plate')
  await expect(plate).toBeVisible()
  const expected = Object.values(FIELD_COLOR)

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next
      // Let the browser commit the root-variable swap before sampling several
      // computed properties.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    }, theme)
    const rows = plate.getByTestId('semantic-tone')
    await expect(rows).toHaveCount(expected.length)
    expect(
      await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-tone'))),
    ).toEqual(expected)

    for (const color of expected) {
      const row = plate.locator(`[data-testid="semantic-tone"][data-tone="${color}"]`)
      const samples = [
        { name: 'chip', target: row.getByTestId('palette-chip') },
        { name: 'facet', target: row.getByTestId('palette-facet'), backgroundParent: true },
        { name: 'select', target: row.getByTestId('palette-select') },
        { name: 'notice', target: row.getByTestId('palette-notice') },
        { name: 'button', target: row.getByTestId('palette-button') },
      ]

      for (const sample of samples) {
        const colors = await sample.target.evaluate((element, backgroundParent) => {
          const style = getComputedStyle(element)
          const background = getComputedStyle(
            backgroundParent ? element.parentElement! : element,
          ).backgroundColor
          const canvas = document.createElement('canvas')
          canvas.width = 1
          canvas.height = 1
          const context = canvas.getContext('2d', { willReadFrequently: true })!

          const pixel = (cssColor: string, base?: string): [number, number, number] => {
            context.clearRect(0, 0, 1, 1)
            if (base) {
              context.fillStyle = base
              context.fillRect(0, 0, 1, 1)
            }
            context.fillStyle = cssColor
            context.fillRect(0, 0, 1, 1)
            return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)] as [
              number,
              number,
              number,
            ]
          }

          const luminance = ([red, green, blue]: [number, number, number]) => {
            const channel = (value: number) => {
              const normal = value / 255
              return normal <= 0.04045 ? normal / 12.92 : ((normal + 0.055) / 1.055) ** 2.4
            }

            return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
          }
          const plateBackground = getComputedStyle(
            document.querySelector('[data-testid="semantic-palette-plate"]')!,
          ).backgroundColor
          const foregroundRgb = pixel(style.color)
          const backgroundRgb = pixel(background, plateBackground)
          const [high, low] = [luminance(foregroundRgb), luminance(backgroundRgb)].sort(
            (left, right) => right - left,
          )
          return {
            foreground: style.color,
            background,
            contrast: (high + 0.05) / (low + 0.05),
          }
        }, sample.backgroundParent === true)
        expect.soft(colors.background).not.toBe('rgba(0, 0, 0, 0)')
        expect
          .soft(colors.contrast, `${theme}/${color}/${sample.name}: ${JSON.stringify(colors)}`)
          .toBeGreaterThanOrEqual(4.5)
      }
    }
    for (const testId of ['palette-danger-solid', 'palette-accent-solid']) {
      const contrast = await plate.getByTestId(testId).evaluate((element) => {
        const parse = (value: string) =>
          (value.match(/[\d.]+/gu) ?? []).slice(0, 3).map(Number) as [number, number, number]
        const luminance = (rgb: [number, number, number]) =>
          rgb.reduce((sum, value, index) => {
            const normal = value / 255
            const linear = normal <= 0.04045 ? normal / 12.92 : ((normal + 0.055) / 1.055) ** 2.4
            return sum + linear * [0.2126, 0.7152, 0.0722][index]
          }, 0)
        const style = getComputedStyle(element)
        const values = [
          luminance(parse(style.color)),
          luminance(parse(style.backgroundColor)),
        ].sort((left, right) => right - left)

        return (values[0] + 0.05) / (values[1] + 0.05)
      })

      expect.soft(contrast, `${theme}/${testId}`).toBeGreaterThanOrEqual(4.5)
    }
  }
})
