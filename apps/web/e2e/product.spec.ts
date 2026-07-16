import { expect, test, type Page } from '@playwright/test'

test('presents TrashPal as a reusable household automation product', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'TrashPal', exact: true })).toBeVisible()
  await expect(page.getByText('Set the outcome once. Keep the limits visible.')).toBeVisible()
  await page.getByRole('button', { name: 'Automations' }).click()
  await expect(page.getByText('Night Shift Homecoming')).toBeVisible()
  await expect(page.getByText('Scheduled Hauler Access')).toBeVisible()
  await page.getByRole('button', { name: /Scheduled Hauler Access/ }).click()
  await expect(page.getByText('Review the exact effect before TrashPal acts')).toBeVisible()
  await expect(page.getByText('Assigned hauler tag')).toBeVisible()
})

test('executes Hauler Access through the authenticated product API', async ({ page }) => {
  await page.route('**/api/v1/auth/dev-session', async (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ session: { csrfToken: 'csrf_test' } }),
    }),
  )
  let requestBody: unknown
  await page.route('**/api/v1/missions', async (route) => {
    requestBody = route.request().postDataJSON()
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ mission: { id: 'mis_hauler', state: { status: 'queued' } } }),
    })
  })
  await openHaulerReview(page)
  await page.getByRole('button', { name: 'Approve change' }).click()
  await expect(page.getByText('Change recorded')).toBeVisible()
  expect(requestBody).toMatchObject({
    constraints: {
      serviceHatchOnly: true,
      residentialHatchMustRemainLocked: true,
      finalServiceHatchState: 'locked',
    },
  })
})

test('preserves unknown outcomes instead of claiming failure or retrying', async ({ page }) => {
  await page.route('**/api/v1/auth/dev-session', async (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ session: { csrfToken: 'csrf_test' } }),
    }),
  )
  let calls = 0
  await page.route('**/api/v1/missions', async (route) => {
    calls += 1
    await route.abort('connectionreset')
  })
  await openHaulerReview(page)
  await page.getByRole('button', { name: 'Approve change' }).click()
  await expect(page.getByText('Outcome unknown')).toBeVisible()
  await expect(page.getByText(/before any retry/)).toBeVisible()
  expect(calls).toBe(1)
})

test('renders denied sessions and supports reject and cancel without mutation', async ({
  page,
}) => {
  await page.route('**/api/v1/auth/dev-session', async (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
  )
  await openHaulerReview(page)
  await page.getByRole('button', { name: 'Approve change' }).click()
  await expect(page.getByText('Change not applied')).toBeVisible()
  await expect(page.getByText(/signed-in TrashPal session/)).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: /Night Shift Homecoming/ }).click()
  await page.getByRole('button', { name: 'Reject' }).click()
  await expect(page.getByText('Change rejected')).toBeVisible()
})

for (const width of [390, 768, 1440]) {
  test(`keeps the knowledge path usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Learn' }).click()
    await expect(page.getByText('Give TrashPal a job, not unlimited control')).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(overflow).toBe(false)
  })
}

test('supports keyboard focus, reduced motion, theme contrast, and reload', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.keyboard.press('Tab')
  expect(
    await page.evaluate(() => ['BUTTON', 'A'].includes(document.activeElement?.tagName ?? '')),
  ).toBe(true)
  const animationDuration = await page
    .locator('.r-shell')
    .evaluate((node) => getComputedStyle(node).animationDuration)
  expect(['0s', '0.01ms']).toContain(animationDuration)
  await page.getByRole('button', { name: /Switch to dark mode/ }).click()
  await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('dark')
  expect(await contrastRatio(page, 'body')).toBeGreaterThanOrEqual(4.5)
  await page.reload()
  await expect(page.getByText('Good evening, Rocky')).toBeVisible()
})

async function openHaulerReview(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Automations' }).click()
  await page.getByRole('button', { name: /Scheduled Hauler Access/ }).click()
}

async function contrastRatio(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((node) => {
    const parse = (value: string) =>
      value
        .match(/[\d.]+/g)
        ?.slice(0, 3)
        .map(Number) ?? [0, 0, 0]
    const luminance = (rgb: number[]) =>
      rgb
        .map((part) => {
          const channel = part / 255
          return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        })
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0)
    const style = getComputedStyle(node)
    const foreground = luminance(parse(style.color))
    const background = luminance(parse(style.backgroundColor))
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
  })
}
