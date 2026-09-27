/** Native store existence without mistaking a PostgreSQL schema for a local file.
 * @since 1.0.0
 */

import { existsSync } from "node:fs"

/** Configuration follows the native database adapter's explicit-URL precedence.
 * @category predicates
 * @since 1.0.0
 */
export const exists = (filename: string): boolean =>
  /^postgres(?:ql)?:\/\//.test(filename) ||
  (filename !== "" && filename !== ":memory:" && !filename.startsWith("file:") &&
    process.env.SMITHERS_BACKEND !== "sqlite" &&
    Boolean(
      process.env.SMITHERS_POSTGRES_URL?.trim() ||
        (process.env.SMITHERS_BACKEND === "postgres" && process.env.DATABASE_URL?.trim())
    )) ||
  existsSync(filename)
