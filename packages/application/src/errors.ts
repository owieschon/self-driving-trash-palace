export class ApplicationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApplicationError'
  }
}

export class NotFoundError extends ApplicationError {
  public constructor(resource: string) {
    super('NOT_FOUND', `${resource} was not found`)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends ApplicationError {
  public constructor(message: string) {
    super('CONFLICT', message)
    this.name = 'ConflictError'
  }
}

export class OptimisticConcurrencyError extends ConflictError {
  public constructor(resource: string) {
    super(`${resource} changed before this request committed`)
    this.name = 'OptimisticConcurrencyError'
  }
}

export class AuthenticationError extends ApplicationError {
  public constructor(message: string) {
    super('AUTHENTICATION_REQUIRED', message)
    this.name = 'AuthenticationError'
  }
}

export class ApprovalExpiredError extends ConflictError {
  public constructor() {
    super('Approval expired before the consequential action was authorized')
    this.name = 'ApprovalExpiredError'
  }
}

export class LeaseUnavailableError extends ConflictError {
  public constructor() {
    super('Mission already has an active worker lease')
    this.name = 'LeaseUnavailableError'
  }
}

export class LeaseLostError extends ConflictError {
  public constructor(cause?: unknown) {
    super('Mission worker no longer owns the active lease fence')
    this.name = 'LeaseLostError'
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: cause,
      })
    }
  }
}
