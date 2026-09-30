import { afterEach, expect, it, vi } from "vitest"
import * as Selection from "../src/internal/PostgresSelection.ts"
import { isUnsupportedDatabase } from "../src/internal/SqliteOpen.ts"

/** The tagged refusal a selection throws, as its code and message; never its credentials. */
const refusal = (select: () => unknown) => {
  try {
    select()
  } catch (error) {
    expect(isUnsupportedDatabase(error)).toBe(true)
    const { code, message } = error as { readonly code: string; readonly message: string }
    expect(message).not.toContain("secret")
    return { code, message }
  }
  return expect.unreachable("the selection was accepted")
}

afterEach(() => vi.unstubAllEnvs())
const clear = () => {
  for (const key of ["SMITHERS_POSTGRES_URL", "DATABASE_URL", "SMITHERS_POSTGRES_SCHEMA", "SMITHERS_BACKEND"]) {
    vi.stubEnv(key, "")
  }
}
it("keeps SQLite default and validates explicit PostgreSQL configuration without exposing credentials", () => {
  clear()
  expect(Selection.layer("local.db")).toBeUndefined()
  vi.stubEnv("SMITHERS_BACKEND", "postgres")
  expect(refusal(() => Selection.layer("local.db"))).toEqual({
    code: "postgres_url_missing",
    message: "PostgreSQL requires SMITHERS_POSTGRES_URL or DATABASE_URL"
  })
  vi.stubEnv("DATABASE_URL", "mysql://secret@host/database")
  expect(refusal(() => Selection.layer("local.db"))).toEqual({
    code: "postgres_url_invalid",
    message: "PostgreSQL configuration requires a postgres:// or postgresql:// URL"
  })
  vi.stubEnv("DATABASE_URL", "postgres://[")
  expect(refusal(() => Selection.layer("local.db"))).toEqual({
    code: "postgres_url_invalid",
    message: "Invalid PostgreSQL connection URL"
  })
  vi.stubEnv("DATABASE_URL", "postgres://host/database")
  expect(Selection.layer("local.db")).toBeDefined()
  vi.stubEnv("SMITHERS_POSTGRES_SCHEMA", "workspace")
  expect(Selection.layer("local.db")).toBeDefined()
  vi.stubEnv("SMITHERS_BACKEND", "sqlite")
  expect(Selection.layer("local.db")).toBeUndefined()
  expect(Selection.layer("postgresql://host/database?schema=explicit")).toBeDefined()
  expect(Selection.layer("postgres://host/database")).toBeDefined()
})

it("ignores an ambient DATABASE_URL and keeps SQLite-owned opens local (#2175)", () => {
  clear()
  vi.stubEnv("DATABASE_URL", "file:./dev.db")
  expect(Selection.layer("local.db")).toBeUndefined()
  vi.stubEnv("DATABASE_URL", "postgres://user:secret@host/app")
  expect(Selection.layer("local.db")).toBeUndefined()
  vi.stubEnv("SMITHERS_POSTGRES_URL", "postgres://host/database")
  expect(Selection.layer(":memory:")).toBeUndefined()
  expect(Selection.layer("")).toBeUndefined()
  expect(Selection.layer("file:memdb?mode=memory")).toBeUndefined()
  expect(Selection.layer("local.db")).toBeDefined()
  vi.stubEnv("SMITHERS_POSTGRES_URL", "")
  vi.stubEnv("SMITHERS_BACKEND", "postgres")
  expect(Selection.layer(":memory:")).toBeUndefined()
  expect(Selection.layer("local.db")).toBeDefined()
  vi.stubEnv("DATABASE_URL", "mysql://secret@host/database")
  vi.stubEnv("SMITHERS_POSTGRES_URL", "postgres://host/database")
  expect(Selection.layer("local.db")).toBeDefined()
})

it("locates a store's schema the way the layer opens it", () => {
  clear()
  expect(Selection.location("local.db")).toBeUndefined()
  expect(Selection.location("postgres://user@host/database?schema=explicit&sslmode=require")).toEqual({
    url: "postgres://user@host/database?sslmode=require",
    schema: "explicit"
  })
  expect(Selection.location("postgresql://host/database")).toEqual({
    url: "postgresql://host/database",
    schema: "smithers_flows"
  })
  vi.stubEnv("SMITHERS_POSTGRES_URL", "postgres://host/database")
  const hashed = Selection.location("/project/.flows/engine.db")
  expect(hashed?.url).toBe("postgres://host/database")
  expect(hashed?.schema).toMatch(/^smithers_[0-9a-f]{32}$/)
  // Unprefixed, the whole path names the schema, so another directory is another schema.
  expect(Selection.location("/copy/.flows/engine.db")?.schema).not.toBe(hashed?.schema)
  vi.stubEnv("SMITHERS_POSTGRES_SCHEMA", "workspace")
  // Prefixed, only the basename does: a copy needs a name of its own.
  expect(Selection.location("/project/.flows/engine.db")?.schema).toBe("workspace_engine_db")
  expect(Selection.location("/copy/.flows/engine.db")?.schema).toBe("workspace_engine_db")
  expect(Selection.location("/copy/.flows/verify_ab_engine.db")?.schema).toBe("workspace_verify_ab_engine_db")
})
