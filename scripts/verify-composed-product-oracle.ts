import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const REQUIRED_PROGRAMS = ['Night Shift Homecoming', 'Scheduled Hauler Access'] as const
const ACCEPTED_NON_SUCCESS_STATES = ['failed', 'cancelled', 'checking_result'] as const

export function composedProductOracleFailures(source: string): readonly string[] {
  const failures: string[] = []

  for (const forbidden of [
    'page.route(',
    'route.fulfill(',
    'route.abort(',
    'vi.mock(',
    'mockResolvedValue',
  ]) {
    if (source.includes(forbidden))
      failures.push(`Composed product oracle must not intercept or mock: ${forbidden}`)
  }
  for (const program of REQUIRED_PROGRAMS) {
    if (!source.includes(program))
      failures.push(`Composed product oracle omits program: ${program}`)
  }
  if (!source.includes("name: 'Approve proposal'")) {
    failures.push('Composed product oracle does not exercise a real approval decision')
  }
  if (!source.includes('page.reload()')) {
    failures.push('Composed product oracle does not prove reload recovery')
  }
  if (!source.includes("'verified'")) {
    failures.push('Composed product oracle does not prove one verified completion')
  }
  if (
    !ACCEPTED_NON_SUCCESS_STATES.some((state) => source.includes(`'${state}'`)) &&
    !source.includes('expectMissionState')
  ) {
    failures.push(
      'Composed product oracle must support an honest non-success or still-checking result',
    )
  }

  return failures
}

export function assertComposedProductOracleSource(source: string): void {
  const failures = composedProductOracleFailures(source)
  if (failures.length > 0) throw new Error(failures.join('\n'))
}

async function main(): Promise<void> {
  const input = process.argv[2] ?? 'apps/web/e2e/composed-product.spec.ts'
  const source = await readFile(resolve(process.cwd(), input), 'utf8')
  assertComposedProductOracleSource(source)
  process.stdout.write(`Composed product oracle verified: ${input}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main()
