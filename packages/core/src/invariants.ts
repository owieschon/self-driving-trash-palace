import { z } from 'zod'

export const HardInvariantIdSchema = z.enum([
  'tenant_context_host_derived',
  'verified_identity_required_for_unlock',
  'routine_activation_validated',
  'exact_plan_approval_required',
  'retry_preserves_logical_operation',
  'verifier_owns_mission_success',
  'secrets_excluded_from_model_context',
])

export type HardInvariantId = z.infer<typeof HardInvariantIdSchema>

export const HARD_INVARIANTS = [
  {
    id: 'tenant_context_host_derived',
    statement: 'Tenant context comes from the authenticated host session, never tool input.',
  },
  {
    id: 'verified_identity_required_for_unlock',
    statement: 'An unverified identity can never cause an unlock command.',
  },
  {
    id: 'routine_activation_validated',
    statement: 'Activation requires current schema, capability, conflict, and invariant checks.',
  },
  {
    id: 'exact_plan_approval_required',
    statement: 'Consequential activation requires an unexpired approval for the exact plan hash.',
  },
  {
    id: 'retry_preserves_logical_operation',
    statement: 'A retry creates a new attempt under the same server-created logical operation.',
  },
  {
    id: 'verifier_owns_mission_success',
    statement: 'Only deterministic application verification can mark a mission successful.',
  },
  {
    id: 'secrets_excluded_from_model_context',
    statement: 'Secrets and gateway credentials never enter model context.',
  },
] as const satisfies readonly { id: HardInvariantId; statement: string }[]
