export class DatabaseRepositoryError extends Error {
  public override readonly name: string = 'DatabaseRepositoryError'
}

export class DatabaseNotFoundError extends DatabaseRepositoryError {
  public override readonly name: string = 'DatabaseNotFoundError'

  public constructor(resource: string) {
    super(`${resource} was not found in the authenticated organization`)
  }
}

export class DatabaseConflictError extends DatabaseRepositoryError {
  public override readonly name: string = 'DatabaseConflictError'
}

export class OptimisticConcurrencyError extends DatabaseConflictError {
  public override readonly name: string = 'OptimisticConcurrencyError'
}
export class TenantBoundaryError extends DatabaseRepositoryError {
  public override readonly name: string = 'TenantBoundaryError'
}

export class ApprovalBindingError extends DatabaseConflictError {
  public override readonly name: string = 'ApprovalBindingError'
}

export class MissionFenceRejectedError extends DatabaseConflictError {
  public override readonly name: string = 'MissionFenceRejectedError'

  public constructor(options?: ErrorOptions) {
    super('Mission worker no longer owns the active lease fence')
    if (options?.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: options.cause,
      })
    }
  }
}

type PostgreSqlError = Error & { code?: string; constraint?: string; cause?: unknown }

function findPostgreSqlError(error: Error): PostgreSqlError {
  let current: unknown = error
  const visited = new Set<unknown>()
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current)
    const candidate = current as PostgreSqlError
    if (candidate.code) return candidate
    current = candidate.cause
  }
  return error
}

export function isRetryableTransactionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const postgresError = findPostgreSqlError(error)
  return postgresError.code === '40001' || postgresError.code === '40P01'
}

export function translateDatabaseError(error: unknown): Error {
  if (error instanceof DatabaseRepositoryError) return error
  if (!(error instanceof Error)) return new DatabaseRepositoryError(String(error))
  const postgresError = findPostgreSqlError(error)
  if (postgresError.code === '40001') {
    return new OptimisticConcurrencyError('Concurrent state change requires a retry')
  }
  if (
    postgresError.code === '23505' &&
    postgresError.constraint !== undefined &&
    [
      'gateway_commands_pkey',
      'gateway_commands_organization_id_id_unique',
      'gateway_commands_operation_logical_key_unique',
    ].includes(postgresError.constraint)
  ) {
    return new OptimisticConcurrencyError(
      'Concurrent gateway intent materialization requires a retry',
    )
  }
  if (postgresError.code === '23505') {
    return new DatabaseConflictError(
      `Unique database constraint rejected the write${postgresError.constraint ? `: ${postgresError.constraint}` : ''}`,
    )
  }
  if (postgresError.code === '23503' || postgresError.code === '23514') {
    return new DatabaseConflictError(
      `Database invariant rejected the write${postgresError.constraint ? `: ${postgresError.constraint}` : ''}`,
    )
  }
  return error
}
