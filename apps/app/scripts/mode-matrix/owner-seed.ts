import { createHash, randomBytes, randomInt } from "node:crypto"
import { APPLICATION_TOKEN_SCOPES } from "@smthrs/rpc/ApplicationAuth"

/**
 * The owner a matrix launcher seeds into the PostgreSQL it controls. A real
 * install gets its owner from the GitHub sign-in that carries the printed
 * setup token; a matrix run has no GitHub account to sign in with, so it
 * writes the same rows that claim leaves (a `users` row, the `members` owner
 * row and one access token) and the browser authenticates with that token.
 */
export interface OwnerSeed {
  readonly login: string
  /** The raw `smithers_<40 hex>` token; only its SHA-256 reaches the database. */
  readonly token: string
  /** One statement for `psql -c`; it inserts the user, the owner member and the token. */
  readonly sql: string
}

export const ownerSeed = (login: string): OwnerSeed => {
  if (!/^[a-z][a-z0-9-]{0,38}$/.test(login)) throw new Error(`owner login ${login} is not a lowercase GitHub login`)
  const token = `smithers_${randomBytes(20).toString("hex")}`
  const hash = createHash("sha256").update(token).digest("hex")
  // Any unique id: the matrix owner never signs in with GitHub.
  const githubUserId = 9_000_000_000 + randomInt(1_000_000_000)
  const sql = [
    `WITH owner_user AS (INSERT INTO users (username, lower_username, display_name, is_admin)`,
    `VALUES ('${login}', '${login}', '${login}', TRUE) RETURNING id),`,
    `owner_member AS (INSERT INTO members (user_id, github_user_id, login, role)`,
    `SELECT id, ${githubUserId}, '${login}', 'owner' FROM owner_user)`,
    `INSERT INTO access_tokens (user_id, name, token_hash, token_last_eight, scopes)`,
    `SELECT id, 'mode-matrix', '${hash}', '${hash.slice(-8)}', '${APPLICATION_TOKEN_SCOPES.join(",")}' FROM owner_user;`
  ].join(" ")
  return { login, token, sql }
}
