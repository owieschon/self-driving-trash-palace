import {
  KnowledgeSearchInputSchema,
  KnowledgeSearchOutputSchema,
  assertPermission,
  type MissionPhase,
} from '@trash-palace/core'

import type { ActorContext } from './models.js'
import type { KnowledgeSearchResult, UnitOfWorkPort } from './ports.js'

export interface KnowledgeSearchProjection {
  readonly results: readonly KnowledgeSearchResult[]
}

export class KnowledgeSearchService {
  public constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  public search(input: {
    readonly context: ActorContext
    readonly query: string
    readonly phase: MissionPhase
    readonly limit?: number
  }): Promise<KnowledgeSearchProjection> {
    assertPermission(input.context.principal, 'knowledge:read')
    const query = KnowledgeSearchInputSchema.parse({
      query: input.query,
      phase: input.phase,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })
    return this.unitOfWork.run(input.context.principal.organizationId, async (repositories) =>
      KnowledgeSearchOutputSchema.parse({ results: await repositories.knowledge.search(query) }),
    )
  }
}
