import { describe, expect, it } from 'vitest'

import {
  OptimisticConcurrencyError,
  isRetryableTransactionError,
  translateDatabaseError,
} from './errors.js'

describe('database transaction error classification', () => {
  it.each(['40001', '40P01'])(
    'retries PostgreSQL transaction failure %s through causes',
    (code) => {
      const postgres = Object.assign(new Error('database rejected transaction'), { code })
      const driver = new Error('driver failure', { cause: postgres })

      expect(isRetryableTransactionError(driver)).toBe(true)
    },
  )

  it('does not retry constraint or application failures', () => {
    expect(
      isRetryableTransactionError(
        Object.assign(new Error('constraint rejected write'), { code: '23505' }),
      ),
    ).toBe(false)
    expect(isRetryableTransactionError(new Error('application failure'))).toBe(false)
  })

  it.each(['40001', '40P01'])(
    'translates exhausted PostgreSQL transaction failure %s into a retryable conflict',
    (code) => {
      const postgres = Object.assign(new Error('database rejected transaction'), { code })

      expect(translateDatabaseError(postgres)).toBeInstanceOf(OptimisticConcurrencyError)
    },
  )
})
