import { z } from 'zod'

const ProviderIdentifierSchema = z.string().min(1).max(256)

export const SmartThingsTokenResponseSchema = z.looseObject({
  access_token: z.string().min(1).max(8192),
  token_type: z.string().toLowerCase().pipe(z.literal('bearer')),
  refresh_token: z.string().min(1).max(8192),
  expires_in: z.number().int().positive().max(2_678_400),
  scope: z.string().min(1).max(8192),
  installed_app_id: ProviderIdentifierSchema,
  access_tier: z.number().int().optional(),
  developer_account_id: ProviderIdentifierSchema.optional(),
  iot_account_id: ProviderIdentifierSchema.optional(),
  owner_account_id: ProviderIdentifierSchema.optional(),
})

const SmartThingsCapabilitySchema = z.looseObject({
  id: z.string().min(1).max(256),
  version: z.number().int().positive(),
})

const SmartThingsCategorySchema = z.looseObject({
  name: z.string().min(1).max(256),
  categoryType: z.string().min(1).max(256).optional(),
})

const SmartThingsComponentSchema = z.looseObject({
  id: z.string().min(1).max(256),
  label: z.string().max(1024).optional(),
  capabilities: z.array(SmartThingsCapabilitySchema).max(256),
  categories: z.array(SmartThingsCategorySchema).max(256).optional(),
})

export const SmartThingsDeviceSchema = z.looseObject({
  deviceId: ProviderIdentifierSchema,
  name: z.string().max(1024).optional(),
  label: z.string().max(1024).optional(),
  manufacturerName: z.string().max(1024).optional(),
  locationId: ProviderIdentifierSchema.optional(),
  components: z.array(SmartThingsComponentSchema).min(1).max(256),
  type: z.string().max(256).optional(),
})

const SmartThingsNextLinkSchema = z.looseObject({
  href: z.url(),
})

export const SmartThingsDevicePageSchema = z.looseObject({
  items: z.array(SmartThingsDeviceSchema).max(1000),
  _links: z.looseObject({
    next: SmartThingsNextLinkSchema.optional(),
  }),
})

const SmartThingsAttributeSchema = z.looseObject({
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  unit: z.string().max(32).optional(),
  timestamp: z.iso.datetime().optional(),
})

const SmartThingsCapabilityStatusSchema = z.record(
  z.string().min(1).max(256),
  SmartThingsAttributeSchema,
)

const SmartThingsComponentStatusSchema = z.record(
  z.string().min(1).max(256),
  SmartThingsCapabilityStatusSchema,
)

export const SmartThingsDeviceStatusSchema = z.looseObject({
  components: z.record(z.string().min(1).max(256), SmartThingsComponentStatusSchema),
})

export const SmartThingsCommandResponseSchema = z.looseObject({
  results: z
    .array(
      z.looseObject({
        id: ProviderIdentifierSchema,
        status: z.literal('ACCEPTED'),
      }),
    )
    .min(1)
    .max(32),
})

const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

const SmartThingsDeviceEventSchema = z.looseObject({
  eventTime: z.iso.datetime(),
  eventType: z.literal('DEVICE_EVENT'),
  deviceEvent: z.looseObject({
    eventId: ProviderIdentifierSchema,
    locationId: ProviderIdentifierSchema,
    deviceId: ProviderIdentifierSchema,
    componentId: ProviderIdentifierSchema,
    capability: z.string().min(1).max(256),
    attribute: z.string().min(1).max(256),
    value: JsonScalarSchema,
    valueType: z.string().min(1).max(64),
    stateChange: z.boolean(),
    subscriptionName: z.string().min(1).max(256),
  }),
})

const SmartThingsDeleteEventSchema = z.looseObject({
  eventTime: z.iso.datetime(),
  eventType: z.literal('INSTALLED_APP_LIFECYCLE_EVENT'),
  installedAppLifecycleEvent: z.looseObject({
    eventId: ProviderIdentifierSchema,
    locationId: ProviderIdentifierSchema,
    installedAppId: ProviderIdentifierSchema,
    appId: ProviderIdentifierSchema,
    lifecycle: z.literal('DELETE'),
    delete: z.looseObject({}),
  }),
})

export const SmartThingsWebhookEventSchema = z.looseObject({
  messageType: z.literal('EVENT'),
  eventData: z.looseObject({
    installedApp: z.looseObject({
      installedAppId: ProviderIdentifierSchema,
      locationId: ProviderIdentifierSchema,
    }),
    events: z
      .array(z.union([SmartThingsDeviceEventSchema, SmartThingsDeleteEventSchema]))
      .min(1)
      .max(1000),
  }),
})

export type SmartThingsDevice = z.infer<typeof SmartThingsDeviceSchema>
export type SmartThingsDeviceStatus = z.infer<typeof SmartThingsDeviceStatusSchema>
export type SmartThingsWebhookEvent = z.infer<typeof SmartThingsWebhookEventSchema>
