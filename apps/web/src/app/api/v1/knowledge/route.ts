import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { knowledgeCatalogResponse } from '../../../../server/knowledge-catalog-route.js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET(): Promise<Response> {
  const repositoryRoot =
    process.env.TRASH_PALACE_REPOSITORY_ROOT ??
    (existsSync(resolve(process.cwd(), 'knowledge/catalog.json'))
      ? process.cwd()
      : resolve(process.cwd(), '../..'))
  return knowledgeCatalogResponse(repositoryRoot)
}
