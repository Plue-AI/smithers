/** Clients a driver opened for reading only.
 * @since 1.0.0
 */

import type { SqlClient } from "effect/unstable/sql/SqlClient"

const clients = new WeakSet<SqlClient>()

/** Records that the driver opened `sql` read-only; only drivers call this.
 * @since 1.0.0
 * @private
 */
export const mark = (sql: SqlClient): void => {
  clients.add(sql)
}

/** Whether a driver opened `sql` read-only.
 * @since 1.0.0
 * @private
 */
export const has = (sql: SqlClient): boolean => clients.has(sql)
