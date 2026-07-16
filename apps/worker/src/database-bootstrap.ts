import type {
  Capability,
  CrewMember,
  CrewPreference,
  CrewSchedule,
  Device,
  IdentityTag,
  Membership,
  Organization,
  Palace,
  Routine,
  RoutineVersion,
  User,
} from '@trash-palace/core'
import { MissionPhaseSchema, hashToolValue } from '@trash-palace/core'
import {
  PgBootstrapRepository,
  PgKnowledgeIndexRepository,
  createDatabase,
  createDatabasePool,
  createUnitOfWork,
  type Database,
} from '@trash-palace/db'
import { migrateDatabase } from '@trash-palace/db/migrations'

import { CANONICAL_LOCAL_SEED } from './canonical-seed.js'
import { FilesystemCaretakerKnowledgeProvider } from './knowledge-provider.js'
import type { WorkerBootstrapConfiguration } from './server-configuration.js'

const BOOTSTRAP_ADVISORY_LOCK_NAMESPACE = 1_967_091_517
const BOOTSTRAP_ADVISORY_LOCK_KEY = 1

type SeedTable =
  | 'capabilities'
  | 'crew_members'
  | 'crew_preferences'
  | 'crew_schedules'
  | 'devices'
  | 'identity_tags'
  | 'memberships'
  | 'organizations'
  | 'palaces'
  | 'routine_versions'
  | 'routines'
  | 'users'

export interface CanonicalSeedRecord {
  readonly key: string
  readonly table: SeedTable
  readonly id: string
  readonly value: Readonly<Record<string, unknown>>
}

export interface CanonicalSeedPlan {
  readonly missingKeys: ReadonlySet<string>
  readonly insertedRecordCount: number
}

export interface DatabaseBootstrapResult {
  readonly insertedRecordCount: number
  readonly indexedKnowledgeSourceCount: number
}

export class CanonicalSeedConflictError extends Error {
  public override readonly name = 'CanonicalSeedConflictError'
}

interface CanonicalTenantSeed {
  readonly organization: Organization
  readonly user: User
  readonly membership: Membership
  readonly palace: Palace
  readonly crewMember?: CrewMember
  readonly schedules?: readonly CrewSchedule[]
  readonly preferences?: readonly CrewPreference[]
  readonly identityTags?: readonly IdentityTag[]
  readonly devices?: readonly Device[]
  readonly capabilities?: readonly Capability[]
  readonly routine: Routine
  readonly routineVersion: RoutineVersion
  readonly haulerRoutine?: Routine
  readonly haulerRoutineVersion?: RoutineVersion
}

/** Returns the exact, pre-mission records permitted in the local demonstration baseline. */
export function canonicalSeedInventory(): readonly CanonicalSeedRecord[] {
  const primary = CANONICAL_LOCAL_SEED.primary
  const mirror = CANONICAL_LOCAL_SEED.mirror
  return Object.freeze([
    seedRecord('organizations', primary.organization),
    seedRecord('users', primary.user),
    seedRecord('users', CANONICAL_LOCAL_SEED.serviceActor.user),
    seedRecord('memberships', primary.membership),
    seedRecord('memberships', CANONICAL_LOCAL_SEED.serviceActor.memberships[0]),
    seedRecord('palaces', primary.palace),
    seedRecord('crew_members', primary.crewMember),
    ...primary.schedules.map((value) => seedRecord('crew_schedules', value)),
    ...primary.preferences.map((value) => seedRecord('crew_preferences', value)),
    ...primary.identityTags.map((value) => seedRecord('identity_tags', value)),
    ...primary.devices.map((value) => seedRecord('devices', value)),
    ...primary.capabilities.map((value) => seedRecord('capabilities', value)),
    seedRecord('routines', primary.routine),
    seedRecord('routine_versions', primary.routineVersion),
    seedRecord('routines', primary.haulerRoutine),
    seedRecord('routine_versions', primary.haulerRoutineVersion),
    seedRecord('organizations', mirror.organization),
    seedRecord('users', mirror.user),
    seedRecord('memberships', mirror.membership),
    seedRecord('memberships', CANONICAL_LOCAL_SEED.serviceActor.memberships[1]),
    seedRecord('palaces', mirror.palace),
    seedRecord('routines', mirror.routine),
    seedRecord('routine_versions', mirror.routineVersion),
  ])
}

/** Refuses drift and returns only absent records; a second identical run is empty. */
export function planCanonicalSeed(
  existing: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): CanonicalSeedPlan {
  const inventory = canonicalSeedInventory()
  const missingKeys = new Set<string>()
  for (const expected of inventory) {
    const actual = existing.get(expected.key)
    if (!actual) {
      missingKeys.add(expected.key)
      continue
    }
    const projected = projectExpectedFields(actual, expected.value)
    if (
      hashToolValue(normalizeValue(projected)) !== hashToolValue(normalizeValue(expected.value))
    ) {
      throw new CanonicalSeedConflictError(`Canonical seed record ${expected.key} has drifted`)
    }
  }

  assertRoutinePairIsAtomic(
    missingKeys,
    recordKey('routines', CANONICAL_LOCAL_SEED.primary.routine.id),
    recordKey('routine_versions', CANONICAL_LOCAL_SEED.primary.routineVersion.id),
  )
  assertRoutinePairIsAtomic(
    missingKeys,
    recordKey('routines', CANONICAL_LOCAL_SEED.primary.haulerRoutine.id),
    recordKey('routine_versions', CANONICAL_LOCAL_SEED.primary.haulerRoutineVersion.id),
  )
  assertRoutinePairIsAtomic(
    missingKeys,
    recordKey('routines', CANONICAL_LOCAL_SEED.mirror.routine.id),
    recordKey('routine_versions', CANONICAL_LOCAL_SEED.mirror.routineVersion.id),
  )
  return Object.freeze({
    missingKeys,
    insertedRecordCount: missingKeys.size,
  })
}

export async function seedCanonicalLocalDatabase(database: Database): Promise<number> {
  const before = await loadExistingCanonicalRecords(database)
  const plan = planCanonicalSeed(before)
  if (plan.insertedRecordCount === 0) return 0

  const bootstrap = new PgBootstrapRepository(database)
  await insertGlobalRecords(bootstrap, plan.missingKeys, CANONICAL_LOCAL_SEED.primary)
  await insertGlobalRecords(bootstrap, plan.missingKeys, CANONICAL_LOCAL_SEED.mirror)
  await insertGlobalUser(bootstrap, plan.missingKeys, CANONICAL_LOCAL_SEED.serviceActor.user)

  const unitOfWork = createUnitOfWork(database)
  await insertTenantRecords(unitOfWork, plan.missingKeys, CANONICAL_LOCAL_SEED.primary)
  await insertTenantRecords(unitOfWork, plan.missingKeys, CANONICAL_LOCAL_SEED.mirror)
  await insertServiceMemberships(
    unitOfWork,
    plan.missingKeys,
    CANONICAL_LOCAL_SEED.serviceActor.memberships,
  )

  const after = planCanonicalSeed(await loadExistingCanonicalRecords(database))
  if (after.insertedRecordCount !== 0) {
    throw new CanonicalSeedConflictError('Canonical seed did not persist every required record')
  }
  return plan.insertedRecordCount
}

/** Migrates, seeds, and indexes repository knowledge under one process-wide database lock. */
export async function runDatabaseBootstrap(
  configuration: WorkerBootstrapConfiguration,
): Promise<DatabaseBootstrapResult> {
  assertLocalFixtureProfile(configuration.profile)
  const knowledge = await FilesystemCaretakerKnowledgeProvider.create({
    repositoryRoot: configuration.repositoryRoot,
    applicationVersion: configuration.applicationVersion,
  })
  const snapshot = await knowledge.load({ signal: new AbortController().signal })
  const pool = createDatabasePool({
    connectionString: configuration.databaseUrl,
    application_name: 'trash-palace-bootstrap',
    max: 4,
  })
  const database = createDatabase(pool)
  try {
    const lockClient = await pool.connect()
    let locked = false
    try {
      await lockClient.query('SELECT pg_advisory_lock($1, $2)', [
        BOOTSTRAP_ADVISORY_LOCK_NAMESPACE,
        BOOTSTRAP_ADVISORY_LOCK_KEY,
      ])
      locked = true
      await migrateDatabase(database)
      const insertedRecordCount = await seedCanonicalLocalDatabase(database)
      const index = new PgKnowledgeIndexRepository(database, null)
      for (const source of snapshot.catalog.sources) {
        const content = snapshot.sourceContents[source.id]
        if (content === undefined) {
          throw new Error(`Verified knowledge source ${source.id} has no retained content`)
        }
        await index.replace({
          source,
          title: knowledgeTitle(source.id, content),
          content,
          phases: MissionPhaseSchema.options,
          indexedAt: snapshot.manifest.createdAt,
        })
      }
      return Object.freeze({
        insertedRecordCount,
        indexedKnowledgeSourceCount: snapshot.catalog.sources.length,
      })
    } finally {
      if (locked) {
        await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [
          BOOTSTRAP_ADVISORY_LOCK_NAMESPACE,
          BOOTSTRAP_ADVISORY_LOCK_KEY,
        ])
      }
      lockClient.release()
    }
  } finally {
    await pool.end()
  }
}

function assertLocalFixtureProfile(profile: string): asserts profile is 'local-fixture' {
  if (profile !== 'local-fixture') {
    throw new TypeError('Canonical database seed requires the local-fixture bootstrap profile')
  }
}

async function loadExistingCanonicalRecords(
  database: Database,
): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
  const inventory = canonicalSeedInventory()
  const inventoryKeys = new Set(inventory.map((record) => record.key))
  const idsFor = (table: SeedTable): string[] =>
    inventory.filter((record) => record.table === table).map((record) => record.id)
  const existing = new Map<string, Readonly<Record<string, unknown>>>()
  const rowsByTable = await Promise.all([
    database.query.organizations.findMany({
      where: (table, operators) => operators.inArray(table.id, idsFor('organizations')),
    }),
    database.query.users.findMany({
      where: (table, operators) => operators.inArray(table.id, idsFor('users')),
    }),
    database.query.memberships.findMany({
      where: (table, operators) => operators.inArray(table.id, idsFor('memberships')),
    }),
    database.query.palaces.findMany({
      where: (table, operators) => operators.inArray(table.id, idsFor('palaces')),
    }),
    database.query.crewMembers.findMany({
      where: (table, operators) => operators.inArray(table.id, idsFor('crew_members')),
    }),
    database.query.crewSchedules.findMany({
      where: (table, operators) => operators.inArray(table.id, idsFor('crew_schedules')),
    }),
    database.query.crewPreferences.findMany({
      where: (table, operators) => operators.inArray(table.id, idsFor('crew_preferences')),
    }),
    database.query.identityTags.findMany({
      where: (table, operators) => operators.inArray(table.id, idsFor('identity_tags')),
    }),
    database.query.devices.findMany({
      where: (table, operators) => operators.inArray(table.id, idsFor('devices')),
    }),
    database.query.capabilities.findMany({
      where: (table, operators) => operators.inArray(table.id, idsFor('capabilities')),
    }),
    database.query.routines.findMany({
      where: (table, operators) => operators.inArray(table.id, idsFor('routines')),
    }),
    database.query.routineVersions.findMany({
      where: (table, operators) => operators.inArray(table.id, idsFor('routine_versions')),
    }),
  ])
  collectRows(existing, inventoryKeys, 'organizations', rowsByTable[0])
  collectRows(existing, inventoryKeys, 'users', rowsByTable[1])
  collectRows(existing, inventoryKeys, 'memberships', rowsByTable[2])
  collectRows(existing, inventoryKeys, 'palaces', rowsByTable[3])
  collectRows(existing, inventoryKeys, 'crew_members', rowsByTable[4])
  collectRows(existing, inventoryKeys, 'crew_schedules', rowsByTable[5])
  collectRows(existing, inventoryKeys, 'crew_preferences', rowsByTable[6])
  collectRows(existing, inventoryKeys, 'identity_tags', rowsByTable[7])
  collectRows(existing, inventoryKeys, 'devices', rowsByTable[8])
  collectRows(existing, inventoryKeys, 'capabilities', rowsByTable[9])
  collectRows(existing, inventoryKeys, 'routines', rowsByTable[10])
  collectRows(existing, inventoryKeys, 'routine_versions', rowsByTable[11])
  return existing
}

function collectRows(
  target: Map<string, Readonly<Record<string, unknown>>>,
  inventoryKeys: ReadonlySet<string>,
  table: SeedTable,
  rows: readonly Readonly<Record<string, unknown> & { id: string }>[],
): void {
  for (const row of rows) {
    const key = recordKey(table, row.id)
    if (inventoryKeys.has(key)) {
      target.set(key, row)
    }
  }
}

async function insertGlobalRecords(
  repository: PgBootstrapRepository,
  missing: ReadonlySet<string>,
  seed: CanonicalTenantSeed,
): Promise<void> {
  if (missing.has(recordKey('organizations', seed.organization.id))) {
    await repository.insertOrganization(seed.organization)
  }
  if (missing.has(recordKey('users', seed.user.id))) {
    await repository.insertUser(seed.user)
  }
}

async function insertGlobalUser(
  repository: PgBootstrapRepository,
  missing: ReadonlySet<string>,
  user: User,
): Promise<void> {
  if (missing.has(recordKey('users', user.id))) {
    await repository.insertUser(user)
  }
}

async function insertServiceMemberships(
  unitOfWork: ReturnType<typeof createUnitOfWork>,
  missing: ReadonlySet<string>,
  memberships: readonly Membership[],
): Promise<void> {
  for (const membership of memberships) {
    if (!missing.has(recordKey('memberships', membership.id))) continue
    await unitOfWork.run(membership.organizationId, (repositories) =>
      repositories.records.insertMembership(membership),
    )
  }
}

async function insertTenantRecords(
  unitOfWork: ReturnType<typeof createUnitOfWork>,
  missing: ReadonlySet<string>,
  seed: CanonicalTenantSeed,
): Promise<void> {
  await unitOfWork.run(seed.organization.id, async (repositories) => {
    if (missing.has(recordKey('memberships', seed.membership.id))) {
      await repositories.records.insertMembership(seed.membership)
    }
    if (missing.has(recordKey('palaces', seed.palace.id))) {
      await repositories.records.insertPalace(seed.palace)
    }
    if (seed.crewMember && missing.has(recordKey('crew_members', seed.crewMember.id))) {
      await repositories.records.insertCrewMember(seed.crewMember)
    }
    for (const schedule of seed.schedules ?? []) {
      if (missing.has(recordKey('crew_schedules', schedule.id))) {
        await repositories.records.insertCrewSchedule(schedule)
      }
    }
    for (const preference of seed.preferences ?? []) {
      if (missing.has(recordKey('crew_preferences', preference.id))) {
        await repositories.records.insertCrewPreference(preference)
      }
    }
    for (const tag of seed.identityTags ?? []) {
      if (missing.has(recordKey('identity_tags', tag.id))) {
        await repositories.records.insertIdentityTag(tag)
      }
    }
    for (const device of seed.devices ?? []) {
      if (missing.has(recordKey('devices', device.id))) {
        await repositories.records.insertDevice(device)
      }
    }
    for (const capability of seed.capabilities ?? []) {
      if (missing.has(recordKey('capabilities', capability.id))) {
        await repositories.records.insertCapability(capability)
      }
    }
    if (missing.has(recordKey('routines', seed.routine.id))) {
      await repositories.records.insertRoutine(seed.routine, seed.routineVersion)
    }
    if (
      seed.haulerRoutine &&
      seed.haulerRoutineVersion &&
      missing.has(recordKey('routines', seed.haulerRoutine.id))
    ) {
      await repositories.records.insertRoutine(seed.haulerRoutine, seed.haulerRoutineVersion)
    }
  })
}

function seedRecord(
  table: SeedTable,
  value: Readonly<Record<string, unknown>>,
): CanonicalSeedRecord {
  const id = value.id
  if (typeof id !== 'string') throw new TypeError('Canonical seed records require string IDs')
  return Object.freeze({ key: recordKey(table, id), table, id, value })
}

function recordKey(table: SeedTable, id: string): string {
  return `${table}:${id}`
}

function assertRoutinePairIsAtomic(
  missing: ReadonlySet<string>,
  routineKey: string,
  versionKey: string,
): void {
  if (missing.has(routineKey) !== missing.has(versionKey)) {
    throw new CanonicalSeedConflictError(
      'Canonical routine and active version are only partly stored',
    )
  }
}

function projectExpectedFields(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]]))
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const timestamp = new Date(value)
    if (!Number.isNaN(timestamp.valueOf())) return timestamp.toISOString()
  }
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeValue(nested)]),
    )
  }
  return value
}

function knowledgeTitle(sourceId: string, content: string): string {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim()
  const title = heading && heading.length > 0 ? heading : sourceId
  if (title.length > 200)
    throw new Error(`Knowledge source ${sourceId} title exceeds 200 characters`)
  return title
}
