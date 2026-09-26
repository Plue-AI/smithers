import { describe, expect, it } from "@effect/vitest"
import * as UnsupportedBackend from "../src/UnsupportedBackend.ts"

/**
 * Negative gates for unsupported backend environment names: rc.0 stores run
 * state in local SQLite only, so the connection strings a 0.x PostgreSQL or
 * PGlite deployment exports have no effect. Ignoring them silently is the
 * failure the release policy was written to remove — a project would run
 * against SQLite believing it ran against PostgreSQL — so each name is
 * announced once, with the sentence the contract fixes.
 *
 * One case per name the contract lists, because the matcher is the thing that
 * can silently stop covering a name.
 */

describe("names rc.0 ignores (X-01, the release policy)", () => {
  it.each([
    "SMITHERS_TEST_PG_URL",
    "SMITHERS_POSTGRES_MAX_CONNECTIONS"
  ])("announces %s and does not act on it", (name) => {
    expect(UnsupportedBackend.ignoredNames({ [name]: "postgres://localhost/smithers" })).toEqual([name])
    expect(UnsupportedBackend.ignoredNotice(name)).toBe(
      `ignored: ${name} has no effect in 1.0.0-rc.1 (use SMITHERS_POSTGRES_URL to select PostgreSQL)`
    )
  })

  it("announces every matching name once, in a stable order", () => {
    expect(UnsupportedBackend.ignoredNames({
      SMITHERS_POSTGRES_URL: "postgres://localhost/smithers",
      SMITHERS_TEST_PG_URL: "postgres://localhost/test",
      SMITHERS_POSTGRES_MAX_CONNECTIONS: "10",
      SMITHERS_REMOTE: "http://localhost:3000",
      PATH: "/usr/bin"
    })).toEqual([
      "SMITHERS_POSTGRES_MAX_CONNECTIONS",
      "SMITHERS_TEST_PG_URL"
    ])
  })

  it("announces nothing about a name rc.0 does support", () => {
    expect(
      UnsupportedBackend.ignoredNames({
        SMITHERS_BACKEND: "sqlite",
        SMITHERS_POSTGRES_URL: "postgres://localhost/db",
        SMITHERS_POSTGRES_SCHEMA: "flows",
        SMITHERS_REMOTE: "http://x"
      })
    ).toEqual([])
  })

  /**
   * The contract lists `SMITHERS_POSTGRES_*`, not every name that starts with
   * those letters. A prefix test without the separator claims rc.0 ignores
   * `SMITHERS_POSTGRESQL_URL`, a name it never read, and the notice would
   * describe a decision nobody made.
   */
  it("announces nothing about a name outside the SMITHERS_POSTGRES_ family", () => {
    expect(UnsupportedBackend.ignoredNames({ SMITHERS_POSTGRESQL_URL: "postgres://localhost/smithers" }))
      .toEqual([])
    expect(UnsupportedBackend.ignoredNames({ SMITHERS_POSTGRESTS: "1" })).toEqual([])
  })

  it("treats an exported-but-blank name as unset", () => {
    expect(UnsupportedBackend.ignoredNames({ SMITHERS_POSTGRES_URL: "" })).toEqual([])
    expect(UnsupportedBackend.ignoredNames({ SMITHERS_POSTGRES_URL: undefined })).toEqual([])
    expect(UnsupportedBackend.ignoredNames({})).toEqual([])
  })
})
