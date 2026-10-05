import { expect, test } from "@playwright/test"
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
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

    // Unimplemented browser/dispatcher and execution receipts remain visible.
    // The role cases below own an isolated startLocalOwn backend and PostgreSQL;
    // it is a seam receipt, not a CardRenderers/browser interaction receipt.
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
    test("Ben Member GET /api/todos returns literal seeded 200 body; independently compare curl with Ben's session", async () => {
      test.setTimeout(900_000)
      const output = mkdtempSync(resolve(tmpdir(), "c-ui-10-read-"))
      try {
        const result = await promisify(execFile)("bun", ["e2e/playwright/debug-api/local-own-read.ts", output], {
          env: { ...process.env, TMPDIR: output }, timeout: 840_000, maxBuffer: 8 * 1024 * 1024
        })
        expect(result.stdout).toContain("C-UI-10 REAL READ PASS")
      } finally {
        for (const name of ["local-own.execution.json", "write.role-receipt.json"]) {
          const path = resolve(output, name)
          if (existsSync(path)) await test.info().attach(name, { path, contentType: "application/json" })
        }
        rmSync(output, { recursive: true, force: true })
      }
    })
    test("Ben POST secrets awaits Confirm then 403 permission with zero SQL rows; Mia Maintainer gets 201 and one SQL row", async () => {
      test.setTimeout(900_000)
      const output = mkdtempSync(resolve(tmpdir(), "c-ui-10-write-"))
      try {
        const result = await promisify(execFile)("bun", ["e2e/playwright/debug-api/local-own-read.ts", output, "write"], {
          env: { ...process.env, TMPDIR: output }, timeout: 840_000, maxBuffer: 8 * 1024 * 1024
        })
        expect(result.stdout).toContain("C-UI-10 REAL WRITE PASS")
      } finally {
        for (const name of ["local-own.execution.json", "write.role-receipt.json"]) {
          const path = resolve(output, name)
          if (existsSync(path)) await test.info().attach(name, { path, contentType: "application/json" })
        }
        rmSync(output, { recursive: true, force: true })
      }
    })
    test("Ben signs out in another tab; Send renders literal 401 permission/unauthenticated without a crash", async () => {
      test.setTimeout(900_000)
      const output = mkdtempSync(resolve(tmpdir(), "c-ui-10-signout-"))
      try {
        const result = await promisify(execFile)("bun", ["e2e/playwright/debug-api/local-own-read.ts", output, "signout"], {
          env: { ...process.env, TMPDIR: output }, timeout: 840_000, maxBuffer: 8 * 1024 * 1024
        })
        expect(result.stdout).toContain("C-UI-10 REAL SIGNOUT PASS")
      } finally {
        for (const name of ["local-own.execution.json", "signout.role-receipt.json"]) {
          const path = resolve(output, name)
          if (existsSync(path)) await test.info().attach(name, { path, contentType: "application/json" })
        }
        rmSync(output, { recursive: true, force: true })
      }
    })
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
