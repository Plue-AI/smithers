/**
 * Public database port used by SQL-backed memory adapters.
 *
 * @since 0.1.0
 */

import type { Service as DurableWriterService } from "@smthrs/database/DurableWriter"
import type * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Query and serialized-write capabilities required by memory SQL adapters.
 *
 * @category models
 * @since 0.1.0
 */
export interface DatabaseService extends DurableWriterService {
  readonly sql: SqlClient.SqlClient
}
