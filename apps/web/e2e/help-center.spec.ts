import { expect, test } from '@playwright/test'

test('starts with customer Help while keeping developer and API material one click away', async ({
  page,
}) => {
  await page.goto('/help')

  await expect(page.getByRole('heading', { name: 'Help', exact: true })).toBeVisible()
  await expect(
    page.getByRole('article').getByRole('heading', { name: 'TrashPal Help' }),
  ).toBeVisible()
  await expect(
    page.getByLabel('Knowledge sections').locator('summary', { hasText: 'Start using TrashPal' }),
  ).toBeVisible()
  await expect(
    page.getByLabel('Knowledge sections').locator('summary', { hasText: 'Developer docs' }),
  ).toBeVisible()
  await expect(
    page.getByLabel('Knowledge sections').locator('summary', { hasText: 'API and MCP reference' }),
  ).toBeVisible()

  await page
    .getByLabel('Knowledge sections')
    .locator('summary', { hasText: 'Developer docs' })
    .click()
  await page.getByRole('button', { name: 'Build with HTTP and MCP' }).click()
  await expect(page).toHaveURL(/\/help\/procedure.build-http-mcp$/)
  await expect(page.getByRole('heading', { name: 'Build with HTTP and MCP' })).toBeVisible()
})

test('searches the whole public catalog without hiding developer or API results', async ({
  page,
}) => {
  await page.goto('/help')

  await page.getByRole('searchbox', { name: 'Search Help' }).fill('MCP')
  await expect(page.getByRole('button', { name: 'Build with HTTP and MCP' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Executable API, MCP, and event reference' }),
  ).toBeVisible()
})

test('searches the canonical article body, not only catalog labels', async ({ page }) => {
  await page.goto('/help')

  await page.getByRole('searchbox', { name: 'Search Help' }).fill('same-payload replay')
  await expect(page.getByRole('button', { name: 'Build with HTTP and MCP' })).toBeVisible()
})

test('offers a retry when the canonical Help catalog is temporarily unavailable', async ({
  page,
}) => {
  let catalogRequests = 0
  await page.route('**/api/v1/knowledge', async (route) => {
    catalogRequests += 1
    if (catalogRequests === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'temporarily unavailable' }),
      })
      return
    }
    await route.continue()
  })

  await page.goto('/help')
  await expect(page.locator('article [role="alert"]')).toContainText('Help could not load')
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(
    page.getByRole('article').getByRole('heading', { name: 'TrashPal Help' }),
  ).toBeVisible()
  expect(catalogRequests).toBe(2)
})

test('keeps the selected Help article within the first phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/help')

  const articleHeading = page.getByRole('article').getByRole('heading', { name: 'TrashPal Help' })
  await expect(articleHeading).toBeVisible()
  const bounds = await articleHeading.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds?.y).toBeLessThan(844)
})

test('renders a reader-facing fallback for an unknown Help route', async ({ page }) => {
  await page.goto('/help/guide-that-does-not-exist')

  const article = page.getByRole('article')
  await expect(
    article.getByRole('heading', { name: 'This Help page is unavailable' }),
  ).toBeVisible()
  await article.getByRole('button', { name: 'Browse Help' }).click()
  await expect(page).toHaveURL(/\/help\/overview.trash-palace$/)
  await expect(page.getByRole('heading', { name: 'TrashPal Help' })).toBeVisible()
})
