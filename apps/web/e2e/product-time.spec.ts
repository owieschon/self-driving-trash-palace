import { expect, test } from '@playwright/test'

test('uses Palace-projected local time for the member greeting', async ({ page }) => {
  await page.route('**/api/v1/palaces/pal_e2e_workspace/workspace', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 'palace-workspace@1',
        member: {
          id: 'usr_rocky_workspace',
          organizationId: 'org_raccoon_coop',
          displayName: 'Rocky',
          role: 'owner',
          grants: [],
        },
        palace: {
          id: 'pal_e2e_workspace',
          organizationId: 'org_raccoon_coop',
          name: 'Rocky’s Palace',
          timezone: 'America/Los_Angeles',
        },
        presentation: {
          observedAt: '2026-07-16T03:30:00.000Z',
          timezone: 'America/Los_Angeles',
          dayPeriod: 'evening',
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
        ],
        activeAutomations: [],
        activity: [],
      }),
    }),
  )

  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Good evening, Rocky' })).toBeVisible()
  await expect(page.getByText('Rocky’s Palace')).toBeVisible()
  await expect(page.getByText('America/Los_Angeles', { exact: true })).toBeVisible()
  await expect(page.getByText('Good evening', { exact: true })).toBeVisible()
})
