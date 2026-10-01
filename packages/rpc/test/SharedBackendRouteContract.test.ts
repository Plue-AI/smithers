import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { SHARED_BACKEND_CLIENT_ROUTES } from "../src/AgentApiRoutes.ts"

describe("shared backend client route contract", () => {
  test("every client-called route is mounted by the Go composition root", () => {
    const router = readFileSync(join(import.meta.dirname, "../../backend/internal/compose/router.go"), "utf8")
    const bootstrap = readFileSync(join(import.meta.dirname, "../../backend/internal/compose/bootstrap.go"), "utf8")
    for (const route of SHARED_BACKEND_CLIENT_ROUTES) {
      const path = route.path.replace(/^\/api\//, "")
      const mounted = router.includes(`r.${route.method === "GET" ? "Get" : "Post"}(\"${route.path}\"`) ||
        router.includes(`${route.method === "GET" ? "Get" : "Post"}(\"/${path}\"`)
      expect(mounted, `${route.method} ${route.path} is not mounted in packages/backend/internal/compose/router.go`)
        .toBe(true)
      if ("capability" in route && route.capability === "recommend") {
        expect(router).toContain("if extras.Recommender != nil")
        expect(bootstrap).toContain("\"recommend\"")
      }
      if ("capability" in route && route.capability === "commands.select") {
        // The selection handler is the recommender's: one decision model, one condition.
        expect(router).toContain("if extras.Recommender != nil")
        expect(bootstrap).toContain("\"commands.select\"")
      }
      if ("capability" in route && route.capability === "model.turn") {
        expect(router).toContain("if extras.ModelStream != nil")
        expect(bootstrap).toContain("\"model.turn\"")
      }
    }
  })
})
