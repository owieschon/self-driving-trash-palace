import {
  EvidenceIdSchema,
  PersistedEvidenceRecordSchema,
  ReceiptIdSchema,
  hashToolValue,
  type Mission,
  type PersistedEvidenceRecord,
} from '@trash-palace/core'

import { ConflictError } from './errors.js'
import type { TenantRepositories } from './ports.js'

export type HomecomingForecastProfile = Readonly<{
  targetCelsius: number
  pathwayLightingIntensityPercent: number
  pathwayLightingDurationSeconds: number
}>

export interface HomecomingBatteryForecastPort {
  project(profile: HomecomingForecastProfile): number
}

/** Reference forecast used by the executable lab; provider adapters can replace this port. */
export class ReferenceHomecomingBatteryForecast implements HomecomingBatteryForecastPort {
  public project(profile: HomecomingForecastProfile): number {
    const heating = Math.max(0, profile.targetCelsius - 18) * 1.6
    const lightingMinutes = profile.pathwayLightingDurationSeconds / 60
    const lighting = (profile.pathwayLightingIntensityPercent / 100) * lightingMinutes * (1 / 6)
    return Math.round((9 + heating + lighting) * 10) / 10
  }
}

export interface MissionBootstrapEvidencePort {
  project(input: {
    readonly repositories: TenantRepositories
    readonly mission: Mission
    readonly observedAt: string
  }): Promise<readonly PersistedEvidenceRecord[]>
}

/** Converts the active crew preference and one program fallback into provenance-bound forecasts. */
export class HomecomingPlanningEvidenceProjector implements MissionBootstrapEvidencePort {
  public constructor(
    private readonly forecasts: HomecomingBatteryForecastPort,
    private readonly energyFirst: HomecomingForecastProfile,
  ) {}

  public async project(input: {
    readonly repositories: TenantRepositories
    readonly mission: Mission
    readonly observedAt: string
  }): Promise<readonly PersistedEvidenceRecord[]> {
    const crew = await input.repositories.crews.list(input.mission.palaceId, true)
    const schedule = requireSingle(
      crew.schedules.filter((candidate) => candidate.active),
      'active crew schedule',
    )
    const preference = requireSingle(
      crew.preferences.filter(
        (candidate) => candidate.active && candidate.crewMemberId === schedule.crewMemberId,
      ),
      'active scheduled-crew preference',
    )
    const preferenceProfile: HomecomingForecastProfile = {
      targetCelsius: preference.targetCelsius,
      pathwayLightingIntensityPercent: preference.pathwayLightingIntensityPercent,
      pathwayLightingDurationSeconds: preference.pathwayLightingDurationSeconds,
    }
    return [
      planningProjectionRecord(
        input.mission,
        input.observedAt,
        'homecoming.preference-energy-projection',
        this.forecasts.project(preferenceProfile),
      ),
      planningProjectionRecord(
        input.mission,
        input.observedAt,
        'homecoming.energy-first-projection',
        this.forecasts.project(this.energyFirst),
      ),
    ]
  }
}

function planningProjectionRecord(
  mission: Mission,
  observedAt: string,
  ruleId: string,
  projectedUsePercentagePoints: number,
): PersistedEvidenceRecord {
  const identity = hashToolValue({
    schemaVersion: 'homecoming-planning-projection-identity@1',
    missionId: mission.id,
    ruleId,
  })
  const evidenceId = EvidenceIdSchema.parse(`evd_${identity.slice(0, 32)}`)
  return PersistedEvidenceRecordSchema.parse({
    schemaVersion: 'persisted-evidence@1',
    evidence: {
      id: evidenceId,
      organizationId: mission.organizationId,
      missionId: mission.id,
      palaceId: mission.palaceId,
      observedAt,
      type: 'battery_projection',
      projectedUsePercentagePoints,
    },
    authorityReceipt: {
      schemaVersion: 'evidence-authority-receipt@1',
      id: ReceiptIdSchema.parse(`rcp_${identity.slice(0, 32)}`),
      evidenceId,
      organizationId: mission.organizationId,
      missionId: mission.id,
      palaceId: mission.palaceId,
      verifiedAt: observedAt,
      authority: 'application',
      producer: 'application_code',
      ruleId,
      ruleVersion: 1,
      inputEvidenceIds: [],
      derivationVerified: true,
    },
    persistedAt: observedAt,
  })
}

function requireSingle<Value>(values: readonly Value[], label: string): Value {
  if (values.length !== 1 || values[0] === undefined) {
    throw new ConflictError(`Mission bootstrap requires exactly one ${label}`)
  }
  return values[0]
}
