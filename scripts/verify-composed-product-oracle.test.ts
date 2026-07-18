import { describe, expect, it } from 'vitest'

import { composedProductOracleFailures } from './verify-composed-product-oracle.js'

const passingSource = `
  test('composed product', async ({ page }) => {
    await page.goto('/')
    await page.getByText('Night Shift Homecoming').click()
    await page.getByText('Scheduled Hauler Access').click()
    await page.getByRole('button', { name: 'Approve proposal' }).click()
    await expectMissionState(page, 'checking_result')
    await page.reload()
    await expectMissionState(page, 'verified')
  })
`

describe('composed product oracle verifier', () => {
  it('accepts a real two-program journey with reload recovery and verified completion', () => {
    expect(composedProductOracleFailures(passingSource)).toEqual([])
  })

  it.each([
    [
      'route interception',
      passingSource.replace("await page.goto('/')", "await page.route('**/*', () => {})"),
    ],
    [
      'missing program',
      passingSource.replace("await page.getByText('Scheduled Hauler Access').click()", ''),
    ],
    [
      'missing approval',
      passingSource.replace(
        "await page.getByRole('button', { name: 'Approve proposal' }).click()",
        '',
      ),
    ],
    ['missing reload', passingSource.replace('await page.reload()', '')],
    [
      'missing verified completion',
      passingSource.replace("await expectMissionState(page, 'verified')", ''),
    ],
  ])('rejects %s', (_label, source) => {
    expect(composedProductOracleFailures(source)).not.toEqual([])
  })

  it.each(['failed', 'cancelled', 'checking_result'])(
    'accepts %s beside a verified outcome',
    (state) => {
      expect(
        composedProductOracleFailures(
          passingSource.replace(
            "await expectMissionState(page, 'checking_result')",
            `await expectMissionState(page, '${state}')`,
          ),
        ),
      ).toEqual([])
    },
  )
})
