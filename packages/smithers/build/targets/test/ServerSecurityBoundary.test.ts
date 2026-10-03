import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type * as LlmLint from "../src/LlmLint.ts"
import * as Target from "../src/Target.ts"

const root = fileURLToPath(new URL("../../../../../", import.meta.url))
const read = (path: string) => readFileSync(`${root}${path}`, "utf8")

describe("deployed server security boundaries", () => {
  it.each(["security", "securityAudit"] as const)(
    "%s reviews the deployed edge through authoritative backend authentication",
    async (name) => {
      const declaration = new URL("../../../../../apps/server/PACKAGE.ts", import.meta.url).href
      const { Package } = await import(declaration)
      const attrs = Target.metadata(Package[name]).attrs as LlmLint.Attrs
      const entry = /"main"\s*:\s*"([^"]+)"/.exec(read("apps/server/wrangler.jsonc"))![1]
      const rubric = attrs.rubric
      const boundaries = rubric.slice(0, rubric.indexOf("Checks. Every finding"))
      for (const id of ["repository-flow-invocation", "browser-workflow-dispatch"]) {
        const section = boundaries.split(`Boundary [${id}]`)[1]?.split("Boundary [")[0] ?? ""
        expect(section).toContain(`apps/server/${entry}`)
        expect(section).toContain("apps/server/src/Http.ts")
        expect(section).toContain("packages/backend/internal/compose/router.go")
        expect(section).toContain("packages/backend/internal/middleware/auth.go")
        expect(section).toContain("packages/backend/internal/middleware/csrf.go")
        expect(section).toContain("packages/backend/internal/compose/runtime_helpers.go")
        expect(section).toContain("packages/backend/internal/services/repo_permissions.go")
        expect(section).toContain("packages/backend/internal/middleware/revocation_guard.go")
        expect(section).toContain("packages/backend/internal/middleware/run_credential.go")
        expect(section).toContain("packages/backend/internal/middleware/scope.go")
        expect(section).not.toContain("apps/server/src/index.ts")
        expect(section).not.toContain("apps/server/src/cloudToken.ts")
        expect(section).not.toContain("apps/server/src/identity.ts")
        expect(section).not.toContain("becomes a Cloud bearer")
      }
      expect(boundaries).toContain("packages/backend/internal/compose/browser_flow.go")
      expect(boundaries).toContain("packages/backend/internal/compose/browser_flow_target.go")
      const dispatch = boundaries.split("Boundary [browser-workflow-dispatch]")[1]?.split("Boundary [")[0] ?? ""
      const authorization = dispatch.split("\n").find((line) => line.startsWith("Authorization:")) ?? ""
      for (
        const gate of [
          "packages/backend/internal/middleware/scope.go",
          "packages/backend/internal/middleware/run_credential.go",
          "packages/backend/internal/services/repo.go",
          "packages/backend/internal/services/repo_permissions.go",
          "packages/backend/internal/db/workspace.sql.go"
        ]
      ) {
        expect(authorization).toContain(gate)
        expect(attrs.include.map((glob) => glob.pattern)).toContain(`//${gate}`)
        expect(attrs.context.map((glob) => glob.pattern)).toContain(`//${gate}`)
      }
    }
  )
})
