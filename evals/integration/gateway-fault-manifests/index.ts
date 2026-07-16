import { GatewayFaultDurableOutcomeCatalogSchema } from '../../../packages/core/src/index.js'

import { DELAYED_CALLBACK_GATEWAY_FAULT_MANIFEST } from './delayed-callback.js'
import { DEVICE_OFFLINE_GATEWAY_FAULT_MANIFEST } from './device-offline.js'
import { DUPLICATE_CALLBACK_GATEWAY_FAULT_MANIFEST } from './duplicate-callback.js'
import { LOST_ACK_GATEWAY_FAULT_MANIFEST } from './lost-ack.js'
import { NONE_GATEWAY_FAULT_MANIFEST } from './none.js'
import { RESPONSE_TIMEOUT_GATEWAY_FAULT_MANIFEST } from './response-timeout.js'
import { STALE_STATE_GATEWAY_FAULT_MANIFEST } from './stale-state.js'

export {
  DELAYED_CALLBACK_GATEWAY_FAULT_MANIFEST,
  DEVICE_OFFLINE_GATEWAY_FAULT_MANIFEST,
  DUPLICATE_CALLBACK_GATEWAY_FAULT_MANIFEST,
  LOST_ACK_GATEWAY_FAULT_MANIFEST,
  NONE_GATEWAY_FAULT_MANIFEST,
  RESPONSE_TIMEOUT_GATEWAY_FAULT_MANIFEST,
  STALE_STATE_GATEWAY_FAULT_MANIFEST,
}

export const GATEWAY_FAULT_DURABLE_OUTCOME_CATALOG = GatewayFaultDurableOutcomeCatalogSchema.parse({
  schemaVersion: 'gateway-fault-durable-outcome-catalog@1',
  fixtureId: 'night-shift-homecoming@1',
  observationPoint: 'post_preheat_callback_ingested',
  manifests: [
    NONE_GATEWAY_FAULT_MANIFEST,
    DELAYED_CALLBACK_GATEWAY_FAULT_MANIFEST,
    DEVICE_OFFLINE_GATEWAY_FAULT_MANIFEST,
    STALE_STATE_GATEWAY_FAULT_MANIFEST,
    DUPLICATE_CALLBACK_GATEWAY_FAULT_MANIFEST,
    LOST_ACK_GATEWAY_FAULT_MANIFEST,
    RESPONSE_TIMEOUT_GATEWAY_FAULT_MANIFEST,
  ],
})
