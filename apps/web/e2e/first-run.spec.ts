import { expect, test, type Page } from '@playwright/test'

test('orients a first-time member, persists dismissal, and can restart the orientation', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Welcome to TrashPal' })).toBeVisible()
  await expect(page.getByText(/A Palace is one connected home/)).toBeVisible()
  await page.getByRole('button', { name: 'Choose a goal' }).click()
  await expect(page).toHaveURL(/\/automations$/)

  await page.getByRole('button', { name: 'Palace', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: 'Welcome to TrashPal' })).toHaveCount(0)
  await page.getByRole('button', { name: 'How TrashPal works' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome to TrashPal' })).toBeVisible()
})

test('keeps route identity through detail navigation, Back, and direct reload', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/automations')
  await page.getByRole('button', { name: 'Review and customize Scheduled Hauler Access' }).click()
  await expect(page).toHaveURL(/\/automations\/scheduled_hauler_access$/)
  await expect(page.getByRole('button', { name: 'Prepare proposal' })).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(/\/automations$/)
  await expect(
    page.locator('.page-head').getByRole('heading', { name: 'Automations' }),
  ).toBeVisible()

  await page.goto('/automations/scheduled_hauler_access')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Prepare proposal' })).toBeVisible()
})

test('never offers a proposal while the configured Palace is unavailable', async ({ page }) => {
  await page.route('**/api/v1/palaces/**/workspace', async (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: JSON.stringify({ title: 'Unavailable' }),
    }),
  )

  await page.goto('/')

  await expect(
    page.getByRole('heading', { name: 'TrashPal cannot reach this Palace yet' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  await page.getByRole('button', { name: 'Automations', exact: true }).click()
  await expect(
    page.getByRole('button', {
      name: 'Retry Palace connection for Scheduled Hauler Access',
    }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Prepare proposal' })).toHaveCount(0)
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
