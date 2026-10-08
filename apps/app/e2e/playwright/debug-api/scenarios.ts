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
const activationBlocker = "This check still requires its own install or branch-machine evidence. Slash/Advanced and documented forms have a local-own real-backend browser test; the composed install advertises debug.api."

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

    // Missing delegated-dispatch and execution receipts remain visible.
    // Browser and role cases own an isolated startLocalOwn backend and PostgreSQL.
    // This trusted-process test install supplies no branch-machine receipt.
    // The blocked cases deliberately have no route.fulfill/cloudFixture and
    // no guessed success bodies, sessions, SQL mappings or process receipts.
    const pending = (name: string, dependency: string) => {
      test(name, async () => {
        test.fixme(true, `${activationBlocker} ${dependency}`)
        throw new Error(`Missing real-install evidence: ${dependency}`)
      })
    }
    test("slash and Advanced reach CardRenderers on a real install; literal operations and secret fields; selection sends nothing", async () => {
      test.setTimeout(900_000)
      const output = mkdtempSync(resolve(tmpdir(), "c-ui-10-browser-"))
      try {
        const result = await promisify(execFile)("bun", ["e2e/playwright/debug-api/local-own-read.ts", output, "browser"], {
          env: { ...process.env, TMPDIR: output }, timeout: 840_000, maxBuffer: 8 * 1024 * 1024
        })
        expect(result.stdout).toContain("C-UI-10 REAL BROWSER PASS")
      } finally {
        for (const name of ["local-own.execution.json", "browser.role-receipt.json"]) {
          const path = resolve(output, name)
          if (existsSync(path)) await test.info().attach(name, { path, contentType: "application/json" })
        }
        rmSync(output, { recursive: true, force: true })
      }
    })
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
    test("Ben PUT /api/secrets awaits Confirm then 403 permission with zero SQL rows; Mia Maintainer gets 201 and one SQL row", async () => {
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
    test("host-minted app-agent refuses locally; compiled smthrs has no debug.api door and makes no HTTP/SQL effects", async () => {
      test.setTimeout(300_000)
      const result = await promisify(execFile)("go", ["test", "./internal/compose", "-run", "^TestDebugAPIDelegatedDispatchBoundariesPostgres$", "-count=1", "-v"], {
        cwd: resolve("../../packages/backend"), env: process.env,
        timeout: 270_000, maxBuffer: 8 * 1024 * 1024
      })
      expect(result.stdout).toContain("--- PASS: TestDebugAPIDelegatedDispatchBoundariesPostgres")
      await test.info().attach("delegated-dispatch-http-sql", { body: result.stdout, contentType: "text/plain" })
    })
    test("viewer-only API response stays out of the live host model context", async () => {
      test.setTimeout(300_000)
      const result = await promisify(execFile)("go", ["test", "./internal/compose", "-run", "^TestLocalSharedPreflightUsesFastRoleThenCodingFallback$", "-count=1", "-v"], {
        cwd: resolve("../../packages/backend"), env: { ...process.env, SMITHERS_REQUIRE_DATABASE_TESTS: "1" },
        timeout: 270_000, maxBuffer: 8 * 1024 * 1024
      })
      expect(result.stdout).toContain("--- PASS: TestLocalSharedPreflightUsesFastRoleThenCodingFallback")
      await test.info().attach("viewer-only-model-context", { body: result.stdout, contentType: "text/plain" })
    })
    pending("delegated app-agent and CLI scope/role failures retain precedence over debug.api person-only refusal",
      "The shipped catalog declares debug-api with cli:null and http:null. Compiled smthrs debug api returns COMMAND_NOT_FOUND without HTTP, and the app-agent default invocation has no credentialed host authorizer. Catalog.ts now delegates served HTTP commands to the server, but that does not supply this client-only door. T-CAT-01 must supply the shared authorization contract before combined real-install precedence can be proved; T-APP-21 excludes new backend routes.")
    test("repository-flow execution with isolation unavailable refuses before execution with no host process", async () => {
      test.setTimeout(300_000)
      const result = await promisify(execFile)("go", ["test", "./internal/compose", "-run", "^TestDebugAPIInvokeWithoutIsolationPostgres$", "-count=1", "-v"], {
        cwd: resolve("../../packages/backend"), env: process.env,
        timeout: 270_000, maxBuffer: 8 * 1024 * 1024
      })
      expect(result.stdout).toContain("--- PASS: TestDebugAPIInvokeWithoutIsolationPostgres")
      await test.info().attach("missing-isolation-http-sql", { body: result.stdout, contentType: "text/plain" })
    })
    test("available repository-flow execution runs only in a branch machine", async () => {
      test.fixme(!process.env.SMITHERS_CHECK_BUNDLE,
        "Requires the qualified Apple Silicon install bundle and real microVM; trusted-process local-own cannot qualify this case.")
      test.setTimeout(3_600_000)
      const result = await promisify(execFile)("go", ["test", "-p", "4", "./internal/compose", "-run", "^TestCSEC02BundledInstallIsolation$", "-count=1", "-v"], {
        cwd: resolve("../../packages/backend"),
        env: { ...process.env, SMITHERS_REQUIRE_MICROVM_TESTS: "1" },
        timeout: 3_540_000, maxBuffer: 8 * 1024 * 1024
      })
      expect(result.stdout).toContain("--- PASS: TestCSEC02BundledInstallIsolation")
      await test.info().attach("qualified-debug-api-invoke", { body: result.stdout, contentType: "text/plain" })
    })
    for (const missing of ["catalog", "authorizer", "view"] as const) {
      test(`production app with only ${missing} guard unavailable produces zero real-install API/SQL effects`, async () => {
        test.setTimeout(900_000)
        const output = mkdtempSync(resolve(tmpdir(), "c-ui-10-guard-"))
        try {
          const result = await promisify(execFile)("bun", ["e2e/playwright/debug-api/local-own-read.ts", output, `guard-${missing}`], {
            env: { ...process.env, TMPDIR: output }, timeout: 840_000, maxBuffer: 8 * 1024 * 1024
          })
          expect(result.stdout).toContain(`C-UI-10 REAL GUARD PASS: ${missing}`)
        } finally {
          for (const name of ["local-own.execution.json", "guard.role-receipt.json"]) {
            const path = resolve(output, name)
            if (existsSync(path)) await test.info().attach(name, { path, contentType: "application/json" })
          }
          rmSync(output, { recursive: true, force: true })
        }
      })
    }
  })
}
