import { z } from 'zod'

export const ToolNameSchema = z.enum([
  'palaces.get',
  'crews.list',
  'capabilities.list',
  'routines.list',
  'routines.get',
  'executions.list',
  'knowledge.search',
  'plans.propose',
  'plans.validate',
  'plans.simulate',
  'plans.request_approval',
  'plans.activate',
  'operations.get',
  'verification.get_evidence',
  'missions.cancel',
])

export type ToolName = z.infer<typeof ToolNameSchema>
