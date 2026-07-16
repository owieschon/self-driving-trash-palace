import type { OrganizationId } from '@trash-palace/core'

export interface ApplicationTransportFaultPolicyPort {
  shouldLoseCommittedResponse(input: {
    readonly organizationId: OrganizationId
    readonly authorization: 'manual' | 'mission_lease'
  }): boolean
}

export const NO_APPLICATION_TRANSPORT_FAULT_POLICY: ApplicationTransportFaultPolicyPort =
  Object.freeze({
    shouldLoseCommittedResponse: () => false,
  })
