export {
  CallbackDedupeInputSchema,
  GatewayAcknowledgementIdSchema,
  GatewayCallbackBindingSchema,
  GatewayCallbackEvidenceSchema,
  GatewayCallbackNonceSchema,
  GatewayCallbackSchema,
  GatewayCallbackStatusSchema,
  GatewayCommandInstructionSchema,
  GatewayCommandLogicalKeySchema,
  GatewayCommandSchema,
  GatewayDispatchResultSchema,
  GatewayDeliveryEvidenceSchema,
  GatewaySignatureMetadataSchema,
  LockedDesiredStatePayloadSchema,
  SetLightingPayloadSchema,
  SetTemperaturePayloadSchema,
  SignedGatewayCallbackSchema,
  UnlockPayloadSchema,
  callbackDedupeInput,
  canonicalGatewayJson,
  computeGatewayCallbackPayloadHash,
  computeGatewayPayloadHash,
  createGatewayCommand,
  deriveGatewayCommandId,
  gatewayCallbackBindingForCommand,
  gatewayCallbackSignaturePayload,
  validateGatewayCommandCallbackBinding,
  type GatewayAcknowledgementId,
  type CallbackDedupeInput,
  type GatewayCallback,
  type GatewayCallbackBinding,
  type GatewayCallbackEvidence,
  type GatewayCallbackNonce,
  type GatewayCallbackStatus,
  type GatewayCommand,
  type GatewayCommandInput,
  type GatewayCommandInstruction,
  type GatewayCommandLogicalKey,
  type GatewayDispatchResult,
  type GatewayJsonValue,
  type GatewaySignatureMetadata,
  type SignedGatewayCallback,
} from '@trash-palace/core'

export const PRIVATE_GATEWAY_ORIGIN = 'http://gateway-simulator:4319' as const
export const PRIVATE_GATEWAY_COMMAND_URL = `${PRIVATE_GATEWAY_ORIGIN}/v1/commands` as const

// Callback destinations are topology, not input. Keeping the internal web target fixed prevents
// a simulated device command from turning callback delivery into an SSRF primitive.
export const PRIVATE_WEB_ORIGIN = 'http://web:3000' as const
export const PRIVATE_GATEWAY_CALLBACK_PATH = '/api/internal/v1/gateway/callbacks' as const
export const PRIVATE_GATEWAY_CALLBACK_URL =
  `${PRIVATE_WEB_ORIGIN}${PRIVATE_GATEWAY_CALLBACK_PATH}` as const
export const PRIVATE_IDENTITY_TELEMETRY_PATH = '/api/internal/v1/identity/telemetry' as const
export const PRIVATE_IDENTITY_TELEMETRY_URL =
  `${PRIVATE_WEB_ORIGIN}${PRIVATE_IDENTITY_TELEMETRY_PATH}` as const
export const PRIVATE_WEB_READINESS_URL = `${PRIVATE_WEB_ORIGIN}/api/v1/ready` as const

export function assertFixedPrivateGatewayOrigin(
  input: string | URL,
): typeof PRIVATE_GATEWAY_ORIGIN {
  const url = input instanceof URL ? input : new URL(input)
  if (
    url.origin !== PRIVATE_GATEWAY_ORIGIN ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error(`Gateway origin must be the fixed private origin ${PRIVATE_GATEWAY_ORIGIN}`)
  }
  return PRIVATE_GATEWAY_ORIGIN
}
