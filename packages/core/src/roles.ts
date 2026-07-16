import { z } from 'zod'

import {
  IsoDateTimeSchema,
  MembershipIdSchema,
  OrganizationIdSchema,
  UserIdSchema,
} from './identifiers.js'

export const ProductRoleSchema = z.enum(['owner', 'operator', 'viewer', 'service', 'delegated'])

export const PermissionSchema = z.enum([
  'palace:read',
  'crew:read',
  'capability:read',
  'routine:read',
  'routine:draft',
  'routine:validate',
  'routine:simulate',
  'routine:approve',
  'routine:activate',
  'recovery:propose',
  'operation:reconcile',
  'verification:read',
  'knowledge:read',
  'mission:cancel',
])

export const OperatorGrantSchema = z.literal('routine:approve')
export const DelegatedPermissionSchema = PermissionSchema.exclude(['routine:approve'])

export type ProductRole = z.infer<typeof ProductRoleSchema>
export type Permission = z.infer<typeof PermissionSchema>
export type OperatorGrant = z.infer<typeof OperatorGrantSchema>
export type DelegatedPermission = z.infer<typeof DelegatedPermissionSchema>

const READ_PERMISSIONS = [
  'palace:read',
  'crew:read',
  'capability:read',
  'routine:read',
  'verification:read',
  'knowledge:read',
] as const satisfies readonly Permission[]

export const ROLE_PERMISSION_MATRIX = {
  owner: [
    ...READ_PERMISSIONS,
    'routine:draft',
    'routine:validate',
    'routine:simulate',
    'routine:approve',
    'routine:activate',
    'recovery:propose',
    'operation:reconcile',
    'mission:cancel',
  ],
  operator: [...READ_PERMISSIONS, 'routine:draft', 'routine:validate', 'routine:simulate'],
  viewer: READ_PERMISSIONS,
  service: [
    ...READ_PERMISSIONS,
    'routine:draft',
    'routine:validate',
    'routine:simulate',
    'routine:activate',
    'recovery:propose',
    'operation:reconcile',
  ],
  delegated: [] as const,
} as const satisfies Record<ProductRole, readonly Permission[]>

export const MembershipSchema = z
  .object({
    id: MembershipIdSchema,
    organizationId: OrganizationIdSchema,
    userId: UserIdSchema,
    role: z.enum(['owner', 'operator', 'viewer']),
    grants: z.array(OperatorGrantSchema).default([]),
    createdAt: IsoDateTimeSchema,
    revokedAt: IsoDateTimeSchema.nullable().default(null),
  })
  .strict()
  .superRefine((membership, ctx) => {
    if (membership.role !== 'operator' && membership.grants.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['grants'],
        message: 'Only operators receive additive per-membership grants',
      })
    }
    if (new Set(membership.grants).size !== membership.grants.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['grants'],
        message: 'Membership grants must be unique',
      })
    }
  })

export const PrincipalSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    actorId: UserIdSchema,
    role: ProductRoleSchema,
    operatorGrants: z.array(OperatorGrantSchema).default([]),
    delegatedPermissions: z.array(DelegatedPermissionSchema).default([]),
  })
  .strict()
  .superRefine((principal, ctx) => {
    if (principal.role !== 'delegated' && principal.delegatedPermissions.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['delegatedPermissions'],
        message: 'Only delegated principals may carry delegated permissions',
      })
    }
    if (principal.role !== 'operator' && principal.operatorGrants.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['operatorGrants'],
        message: 'Only operators may carry the routine:approve grant',
      })
    }
  })

export type Membership = z.infer<typeof MembershipSchema>
export type Principal = z.infer<typeof PrincipalSchema>

export function permissionsFor(
  role: ProductRole,
  additive: readonly Permission[] = [],
): ReadonlySet<Permission> {
  const base = ROLE_PERMISSION_MATRIX[role]
  if (role === 'operator') {
    return new Set<Permission>([
      ...base,
      ...additive.filter(
        (permission): permission is OperatorGrant => permission === 'routine:approve',
      ),
    ])
  }
  if (role === 'delegated') {
    return new Set<Permission>([
      ...base,
      ...additive.filter((permission) => permission !== 'routine:approve'),
    ])
  }
  return new Set<Permission>(base)
}

export function principalHasPermission(principal: Principal, permission: Permission): boolean {
  const scopes =
    principal.role === 'operator' ? principal.operatorGrants : principal.delegatedPermissions
  return permissionsFor(principal.role, scopes).has(permission)
}
