import { expect, test, type Page } from '@playwright/test'

test('orients a first-time member toward a clear, inspectable first action', async ({ page }) => {
  await mockConnectedWorkspace(page)
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Welcome to TrashPal' })).toBeVisible()
  await expect(page.getByText(/A Palace is one connected home/)).toBeVisible()
  await page.getByRole('button', { name: 'I’ll look around first' }).click()

  await expect(page.getByRole('heading', { name: 'Good morning, Rocky' })).toBeVisible()
  await expect(page.getByText('What would you like Pal to take care of?')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Automations', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Help', exact: true })).toBeVisible()
})

test('keeps supported automations and their control boundary discoverable', async ({ page }) => {
  await mockConnectedWorkspace(page)
  await page.goto('/automations')

  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible()
  await expect(page.getByText('Night Shift Homecoming')).toBeVisible()
  await expect(page.getByText('Scheduled Hauler Access')).toBeVisible()
  await expect(page.getByRole('button', { name: 'New automation' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Search TrashPal' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Rocky account' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Review and customize Scheduled Hauler Access' }).click()
  await expect(page).toHaveURL(/\/automations\/scheduled_hauler_access$/)
  await expect(page.getByText('Choose the outcome. Review the plan before Pal acts.')).toBeVisible()
  await expect(page.getByText('Nothing changes yet.')).toBeVisible()
})

test('renders Workspace and Activity without manufacturing a device result or activity record', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/setup')

  await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible()
  await expect(page.getByText('Current workspace information')).toBeVisible()
  await expect(
    page.locator('.house-sections').getByText('Rocky’s Palace', { exact: true }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await expect(page).toHaveURL(/\/activity$/)
  await expect(page.getByText('No recent Palace activity')).toBeVisible()
  await expect(
    page.locator('.change-notice').getByText('This Palace has no recent requests to show.'),
  ).toBeVisible()
  await expect(page.locator('.activity-list')).toHaveCount(0)
})

test('keeps keyboard focus, reduced motion, theme contrast, and reload usable', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByRole('button', { name: 'I’ll look around first' }).click()
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
  await expect(page.getByRole('heading', { name: 'Good morning, Rocky' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Welcome to TrashPal' })).toHaveCount(0)
})

async function mockConnectedWorkspace(page: Page) {
  await page.route('**/api/v1/palaces/**/workspace', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 'palace-workspace@1',
        member: {
          id: 'usr_e2e_workspace',
          organizationId: 'org_e2e_workspace',
          displayName: 'Rocky',
          role: 'owner',
          grants: [],
        },
        palace: {
          id: 'pal_e2e_workspace',
          organizationId: 'org_e2e_workspace',
          name: 'Rocky’s Palace',
          timezone: 'America/New_York',
        },
        presentation: {
          observedAt: '2026-07-16T12:00:00.000Z',
          timezone: 'America/New_York',
          dayPeriod: 'morning',
        },
        attention: [],
        capabilityIdeas: [
          {
            programKind: 'night_shift_homecoming',
            label: 'Night Shift Homecoming',
            description: 'Prepare the Palace for a verified arrival.',
            availability: 'ready',
            requiredCapabilities: ['temperature_target'],
          },
          {
            programKind: 'scheduled_hauler_access',
            label: 'Scheduled Hauler Access',
            description: 'Give an assigned hauler limited service access.',
            availability: 'ready',
            requiredCapabilities: ['service_hatch'],
          },
        ],
        activeAutomations: [],
        activity: [],
      }),
    }),
  )
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
