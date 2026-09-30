import { describe, expect, test } from "vitest"
import { ADMIN_HEALTH_PATH } from "../src/AgentApiRoutes.ts"
import { AdminSystemHealthSchema } from "../src/Health.ts"

describe("shared backend administrator health", () => {
  test("the public route names the mounted backend endpoint", () => {
    expect(ADMIN_HEALTH_PATH).toBe("/api/admin/system/health")
  })

  test.each([
    { status: "ok", database: { status: "ok", latency: "1.2ms" } },
    { status: "degraded", database: { status: "error", error: "database offline" } },
    { status: "ok", database: { status: "ok" }, components: {} },
    { status: "degraded", database: { status: "error" }, components: { queue: { status: "error" } } },
    { status: "ok", database: { status: "ok" }, components: { queue: { status: "ok", latency: "3ms" } } }
  ])("retains the backend observation without invented probe fields: %j", (body) => {
    expect(AdminSystemHealthSchema.parse(body)).toEqual(body)
  })

  test.each([
    null,
    [],
    {},
    { services: [], charges: null, checkedAt: "2026-09-30" },
    { status: "ok", database: null },
    { status: "healthy", database: { status: "ok" } },
    { status: "ok", database: { status: "failed" } },
    { status: "ok", database: { status: "ok", latency: 3 } },
    { status: "degraded", database: { status: "error", error: {} } },
    { status: "ok", database: { status: "ok", extra: "unread" } },
    { status: "ok", database: { status: "ok" }, components: [] },
    { status: "ok", database: { status: "ok" }, components: { "": { status: "ok" } } },
    { status: "ok", database: { status: "ok" }, components: { queue: { status: "unknown" } } },
    { status: "ok", database: { status: "ok" }, charges: null }
  ])("refuses legacy or malformed evidence as a whole: %j", (body) => {
    expect(AdminSystemHealthSchema.safeParse(body).success).toBe(false)
  })
})
