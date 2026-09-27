import { afterEach, expect, it, vi } from "vitest"
import * as DatabaseLocation from "../src/internal/DatabaseLocation.ts"

afterEach(() => vi.unstubAllEnvs())

it("counts a PostgreSQL store only where the database adapter would select one (#2175)", () => {
  for (const name of ["SMITHERS_POSTGRES_URL", "DATABASE_URL", "SMITHERS_BACKEND"]) vi.stubEnv(name, "")
  const missing = "/nonexistent/smithers/engine.db"
  expect(DatabaseLocation.exists("postgres://host/database")).toBe(true)
  vi.stubEnv("DATABASE_URL", "postgres://host/app")
  expect(DatabaseLocation.exists(missing)).toBe(false)
  vi.stubEnv("SMITHERS_BACKEND", "postgres")
  expect(DatabaseLocation.exists(missing)).toBe(true)
  expect(DatabaseLocation.exists(":memory:")).toBe(false)
  vi.stubEnv("SMITHERS_BACKEND", "")
  vi.stubEnv("SMITHERS_POSTGRES_URL", "postgres://host/database")
  expect(DatabaseLocation.exists(missing)).toBe(true)
  vi.stubEnv("SMITHERS_BACKEND", "sqlite")
  expect(DatabaseLocation.exists(missing)).toBe(false)
})
