import { z } from 'zod'

export const MAX_GATEWAY_FAULT_DELAY_VIRTUAL_MILLISECONDS = 5 * 60 * 1_000

const BoundedDelaySchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_GATEWAY_FAULT_DELAY_VIRTUAL_MILLISECONDS)

export const GatewayFaultProfileSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('delayed_callback'),
      delayVirtualMilliseconds: BoundedDelaySchema.min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('device_offline'),
      offlineForVirtualMilliseconds: BoundedDelaySchema.min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('stale_state'),
      staleByVirtualMilliseconds: BoundedDelaySchema.min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('duplicate_callback'),
      copies: z.number().int().min(2).max(4),
      separationVirtualMilliseconds: BoundedDelaySchema.max(5_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('lost_ack'),
      callbackDelayVirtualMilliseconds: BoundedDelaySchema.max(30_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('response_timeout'),
      callbackDelayVirtualMilliseconds: BoundedDelaySchema.min(1).max(30_000),
    })
    .strict(),
])

export type GatewayFaultProfile = z.infer<typeof GatewayFaultProfileSchema>

export const GATEWAY_FAULT_PROFILES = Object.freeze({
  none: { kind: 'none' },
  delayed_callback: { kind: 'delayed_callback', delayVirtualMilliseconds: 4_000 },
  device_offline: { kind: 'device_offline', offlineForVirtualMilliseconds: 30_000 },
  stale_state: { kind: 'stale_state', staleByVirtualMilliseconds: 10_000 },
  duplicate_callback: {
    kind: 'duplicate_callback',
    copies: 2,
    separationVirtualMilliseconds: 1,
  },
  lost_ack: { kind: 'lost_ack', callbackDelayVirtualMilliseconds: 0 },
  response_timeout: { kind: 'response_timeout', callbackDelayVirtualMilliseconds: 5_000 },
} as const satisfies Readonly<Record<string, GatewayFaultProfile>>)

export function parseGatewayFaultProfile(input: unknown): GatewayFaultProfile {
  return GatewayFaultProfileSchema.parse(input)
}
