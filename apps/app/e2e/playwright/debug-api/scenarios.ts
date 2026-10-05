import { expect, test } from "@playwright/test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parse } from "yaml"
import { createDebugApiSeam, installOperations, type DebugApiGates, type OpenApiDocument } from "../../../src/mainview/state/seams/DebugApiSeam"
import operations from "../../../src/debugApi/install-operations.fixture.json"

// Release YAML is input under test; the committed JSON is the literal oracle.
// Like the app's existing Playwright commands, run from apps/app.
const document = () => parse(readFileSync(resolve("../../docs/api/openapi.yaml"), "utf8")) as OpenApiDocument
const activationBlocker = "T-CAT-01: no debug.api descriptor in packages/smithers/ui/src/app-operations; T-ACC-03: production debugApiGates has catalog=false, authorizer=false and no install provider."

export function debugApiScenarios(prefix: string) {
  test.describe(prefix, () => {
    // Client-boundary checks, NOT real-backend C-UI-10 receipts.
    test("release install composition equals the committed literal fixture", () => {
      expect(installOperations(document()).map(({ id, method, path }) => ({ id, method, path }))).toEqual(operations)
    })
    for (const missing of ["catalog", "authorizer", "view"] as const) {
      test(`unavailable ${missing} independently refuses open and Send before transport`, async () => {
        let effects = 0
        const gates: DebugApiGates = { catalog: true, authorizer: true, view: true }
        const seam = createDebugApiSeam({ document: async () => document(), gates: () => gates,
          origin: "http://127.0.0.1:47321",
          // Real transport, no substituted response. Count before network errors.
          fetch: (url, init) => { effects++; return fetch(url, init) } })
        try {
          await seam.open("get_api_bootstrap")
          gates[missing] = false
          expect(Object.entries(gates).filter(([, available]) => !available).map(([name]) => name)).toEqual([missing])
          await expect(seam.open("get_api_bootstrap")).rejects.toThrow("Debug API is unavailable")
          await expect(seam.send({ intent: "send", operationId: "get_api_bootstrap" })).rejects.toThrow("Debug API is unavailable")
          await expect(seam.send({ intent: "confirm", operationId: "get_api_bootstrap", confirmation: "stale" })).rejects.toThrow("Debug API is unavailable")
          expect(effects).toBe(0)
          expect(seam.get().model.exchange).toBeUndefined()
        } finally { seam.dispose() }
      })
    }

    // Missing real-install receipts remain visible. Reuse startLocalOwn from
    // scripts/mode-matrix/local-own.ts for isolated backend + PostgreSQL when
    // dependencies land. run-real-e2e.ts's Bun host alone is not SQL evidence.
    // The blocked cases deliberately have no route.fulfill/cloudFixture and
    // no guessed success bodies, sessions, SQL mappings or process receipts.
    const pending = (name: string, dependency: string) => {
      test(name, async () => {
        test.fixme(true, `${activationBlocker} ${dependency}`)
        throw new Error(`Missing real-install evidence: ${dependency}`)
      })
    }
    pending("slash and Advanced open through CardRenderers; selecting a literal operation sends zero requests",
      "No test install composition supplies the catalog-backed Advanced door or activation provider.")
    pending("Ben Member GET /api/stack returns literal seeded 200 body; independently compare curl with Ben's session",
      "GET /api/stack is absent from compose/router.go and release OpenAPI; approved response and Ben session seed unavailable.")
    pending("Ben PUT /api/secrets sends zero requests before confirmation, then 403 permission; Mia Maintainer succeeds; independently assert SQL effects",
      "PUT /api/secrets is absent; existing repository secrets use POST /api/repos/{owner}/{repo}/secrets. Install role seeds and PUT success envelope unavailable.")
    pending("Ben signs out in another tab; Send renders literal 401 permission/unauthenticated without a crash",
      "Real install Ben session seed and revocation composition unavailable.")
    pending("eligible delegated app-agent and smthrs dispatch refuse debug.api as never with zero effects; scope/role refusals retain precedence",
      "No catalog-backed debug.api app-agent/CLI dispatcher or delegated install fixture.")
    pending("displayed operations and form fields equal committed install fixture; Plue-only and undocumented operations absent",
      "Release operation inventory exists; production activation and reviewed literal install form-field fixtures unavailable.")
    pending("repository-flow execution with isolation unavailable refuses before execution with no host process",
      "POST /api/flows install execution route is absent; T-INS-02/T-FLW-01 route composition and process receipts unavailable.")
    pending("available repository-flow execution runs only in a branch machine",
      "T-INS-02/T-FLW-01 install execution route and branch-machine evidence unavailable.")
    for (const missing of ["catalog", "authorizer", "view"] as const) {
      pending(`real install with only ${missing} unavailable produces zero API/SQL effects`,
        "No real-install composition wires independently selectable DebugApiGates; seam checks above are not backend evidence.")
    }
  })
}
