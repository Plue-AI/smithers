import { afterEach, expect, it, vi } from "vitest"
import * as Selection from "../src/internal/PostgresSelection.ts"

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
  expect(() => Selection.layer("local.db")).toThrow("requires")
  vi.stubEnv("DATABASE_URL", "mysql://secret@host/database")
  expect(() => Selection.layer("local.db")).toThrow("requires a postgres")
  vi.stubEnv("DATABASE_URL", "postgres://[")
  expect(() => Selection.layer("local.db")).toThrow("Invalid PostgreSQL connection URL")
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
