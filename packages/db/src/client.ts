import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg, { type Client, type PoolClient, type PoolConfig } from 'pg'

import * as schema from './schema.js'

export type Database = NodePgDatabase<typeof schema>
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]
export type DatabaseExecutor = Database | DatabaseTransaction

export function createDatabase(client: pg.Pool | PoolClient | Client): Database {
  return drizzle(client, { schema })
}

export function createDatabasePool(config: PoolConfig | string): pg.Pool {
  return new pg.Pool(typeof config === 'string' ? { connectionString: config } : config)
}
