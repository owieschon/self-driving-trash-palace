export type ConnectorErrorCode =
  | 'authentication_required'
  | 'authorization_denied'
  | 'command_not_ready'
  | 'command_conflict'
  | 'credential_rotation_conflict'
  | 'human_confirmation_required'
  | 'invalid_oauth_callback'
  | 'invalid_provider_response'
  | 'provider_access_denied'
  | 'provider_not_found'
  | 'provider_rate_limited'
  | 'provider_temporarily_unavailable'
  | 'provider_transport_unknown'
  | 'state_mismatch'
  | 'tenant_boundary_violation'
  | 'thermostat_unit_mismatch'
  | 'thermostat_mode_mismatch'
  | 'unsupported_capability'
  | 'webhook_verification_failed'

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly outcome: 'definitely_not_sent' | 'unknown'

  constructor(input: {
    readonly code: ConnectorErrorCode
    readonly retryable?: boolean
    readonly retryAfterMs?: number
    readonly outcome?: 'definitely_not_sent' | 'unknown'
  }) {
    super(input.code)
    this.name = 'ConnectorError'
    this.code = input.code
    this.retryable = input.retryable ?? false
    this.outcome = input.outcome ?? 'definitely_not_sent'
    if (input.retryAfterMs !== undefined) {
      this.retryAfterMs = input.retryAfterMs
    }
  }
}
