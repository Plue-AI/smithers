/**
 * Table presence probe for databases this package reads but does not own.
 * @since 1.0.0
 */

import type { DatabaseSync } from "node:sqlite"

/**
 * Whether `db` holds a table named `name`.
 * @category predicates
 * @since 1.0.0
 */
export const hasTable = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
