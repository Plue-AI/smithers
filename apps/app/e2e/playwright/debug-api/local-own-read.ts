// Bun owns the native install; Playwright's Node worker cannot run Bun.spawn.
import { startLocalOwn } from "../../../scripts/mode-matrix/local-own"
import { createDebugApiSeam, type OpenApiDocument } from "../../../src/mainview/state/seams/DebugApiSeam"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parse } from "yaml"
import { strict as assert } from "node:assert"
import fixtures from "./role-cases.fixture.json"
import operations from "../../../src/debugApi/install-operations.fixture.json"
import { chromium, expect } from "@playwright/test"
import { fillComposer } from "../composer"
import { createAppController } from "../../../src/mainview/state/AppController"
import { createAppStore } from "../../../src/mainview/state/AppStore"
import { memoryStorage, silentAgent } from "../../../src/mainview/state/TestFixtures"

const outputDir = process.argv[2]!
const rootDir = resolve("../..")
const command = (argv: string[], env = process.env) => {
  const result = Bun.spawnSync(argv, { env, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw Error(`${argv[0]} failed: ${new TextDecoder().decode(result.stderr)}`)
  return new TextDecoder().decode(result.stdout).trim()
}
const selectedCase = process.argv[3] ?? "read"
const revision = command(["git", "rev-parse", "HEAD"])
// The test binary alone supplies trusted-process isolation.
process.env.SMITHERS_WORKSPACE_ISOLATION = "microvm"
// The native launcher rejects shell pager injection before bundle validation.
delete process.env.GIT_PAGER
const session = await startLocalOwn(rootDir, revision, outputDir)
try {
  const owner = JSON.parse(session.runtimeEnvironment.SMITHERS_LOCAL_OWNER_SESSION!)
  const verifiedOwner = await fetch(new URL("/api/user", session.modeConfig.origin), { headers: { cookie: `smithers_session=${owner.sessionCookie}` } })
  assert.equal(verifiedOwner.status, 200)
  assert.equal((await verifiedOwner.json()).username, owner.username)
  // TMPDIR is private to this child. Never inspect or stop another lane's PG.
  const ownRoot = readdirSync(outputDir).find(name => name.startsWith("smithers-local-own-"))
  assert.ok(ownRoot, "startLocalOwn root in the child-owned TMPDIR")
  const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)])
  const pidFile = files(join(outputDir, ownRoot, "state")).find(path => path.endsWith("/postmaster.pid"))!
  assert.ok(pidFile, "owned PostgreSQL pid file")
  const port = readFileSync(pidFile, "utf8").split("\n")[3]!
  const password = readFileSync(join(dirname(dirname(pidFile)), "password"), "utf8")
  const sql = (query: string) => command(["psql", "-h", "127.0.0.1", "-p", port, "-U", "smithers", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", query], { ...process.env, PGPASSWORD: password })
  const repo = JSON.parse(sql("SELECT json_build_object('owner',u.username,'name',r.name,'id',r.id) FROM repositories r JOIN users u ON u.id=r.user_id LIMIT 1"))
  // Same collaborators permissions and SHA256 session seed as
  // compose/members_integration_test.go; maintain/admin -> Maintainer.
  sql(`INSERT INTO install_settings(key,value) VALUES ('github.repository',jsonb_build_object('owner_login','${repo.owner}','repository_name','${repo.name}','repository_id',${repo.id})) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
    UPDATE install_settings SET value=(SELECT value FROM install_settings WHERE key='github.repository')||jsonb_build_object('last_access_check_at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')) WHERE key='owner.access';
    INSERT INTO users(username,lower_username,display_name) VALUES ('ben','ben','Ben'),('mia','mia','Mia');
    INSERT INTO collaborators(repository_id,user_id,permission,github_login) SELECT ${repo.id},id,CASE username WHEN 'ben' THEN 'write' ELSE 'admin' END,username FROM users WHERE username IN ('ben','mia');`)
  // Real logout accepts UUID credentials, as minted by the auth service.
  const cookie = selectedCase === "signout" ? "a3559000-0000-4000-8000-000000000010" : "c-ui-10-ben-session"
  const hash = createHash("sha256").update(cookie).digest("hex")
  sql(`INSERT INTO auth_sessions(session_key,user_id,username,expires_at) SELECT '${hash}',id,username,now()+interval '1 hour' FROM users WHERE username='ben'`)
  // A fresh, explicitly asserted empty repository is the literal read fixture.
  assert.equal(sql(`SELECT count(*) FROM mythical_items WHERE repository_id=${repo.id}`), "0")
  assert.equal(sql("SELECT permission FROM collaborators c JOIN users u ON u.id=c.user_id WHERE u.username='ben'"), "write")
  const miaCookie = "c-ui-10-mia-session"
  sql(`INSERT INTO auth_sessions(session_key,user_id,username,expires_at) SELECT '${createHash("sha256").update(miaCookie).digest("hex")}',id,username,now()+interval '1 hour' FROM users WHERE username='mia'`)
  assert.equal(sql("SELECT permission FROM collaborators c JOIN users u ON u.id=c.user_id WHERE u.username='mia'"), "admin")
  let activeCookie = cookie
  const csrf = createHash("sha256").update("c-ui-10-csrf").digest("hex")
  const origin = session.modeConfig.origin
  const releaseDocument = () => parse(readFileSync(resolve("../../docs/api/openapi.yaml"), "utf8")) as OpenApiDocument
  let requests = 0
  const sentCookies: string[] = []
  const seam = createDebugApiSeam({ origin, document: async () => releaseDocument(),
    gates: () => ({ view: true, catalog: true, authorizer: true }),
    fetch: (url, init) => { requests++; const headers = new Headers(init.headers); headers.set("cookie", `${activeCookie ? `smithers_session=${activeCookie}; ` : ""}__csrf=${csrf}`); headers.set("X-CSRF-Token", csrf); headers.set("Origin", origin); sentCookies.push(headers.get("cookie")!); return fetch(url, { ...init, headers }) } })
  try {
    if (selectedCase === "read" || selectedCase === "browser") {
      await seam.open(fixtures.read.operationId)
      assert.equal(requests, 0)
      await seam.send({ intent: "send", operationId: fixtures.read.operationId })
      const exchange = seam.get().model.exchange!
      assert.equal(exchange.response?.status, fixtures.read.status)
      assert.equal(exchange.failure, undefined)
      assert.deepEqual(JSON.parse(exchange.response!.body), fixtures.read.body)
      assert.equal(requests, 1)
      const curl = command(["curl", "--silent", "--show-error", "--fail", "--cookie", `smithers_session=${cookie}`, `${origin}/api/todos`])
      assert.deepEqual(JSON.parse(curl), fixtures.read.body)
      console.log("C-UI-10 REAL READ PASS: Member GET /api/todos; literal []; independent curl session comparison")
      if (selectedCase === "browser") {
        const browser = await chromium.launch({ headless: true })
        try {
          const context = await browser.newContext()
          await context.addCookies([{ name: "smithers_session", value: cookie, url: origin }])
          const page = await context.newPage()
          // Observe the playground's redirect-blocking transport while leaving
          // the native fetch and real response untouched. The live TODO provider
          // also reads this URL when Chat changes; those reads are independent.
          await page.addInitScript(() => {
            const observed = window as unknown as { debugApiReads: number }
            observed.debugApiReads = 0
            const nativeFetch = window.fetch.bind(window)
            window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
              const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin)
              if (init?.redirect === "error" && url.pathname === "/api/todos") observed.debugApiReads++
              return nativeFetch(input, init)
            }, window.fetch)
          })
          const browserReads = () => page.evaluate(() => (window as unknown as { debugApiReads: number }).debugApiReads)
          await page.goto(origin)
          await expect.poll(async () => await page.getByTestId("composer-input").isVisible() ||
            await page.getByRole("button", { name: "Chat", exact: true }).isVisible(), { timeout: 60_000 }).toBe(true)
          await fillComposer(page, "/help")
          await page.keyboard.press("Enter")
          const help = page.getByRole("article", { name: "Commands", exact: true })
          await help.getByText("Advanced", { exact: true }).click()
          await help.getByRole("button", { name: /debug-api/ }).click()
          const card = page.getByRole("article", { name: "Debug API", exact: true })
          await expect(card).toBeVisible({ timeout: 60_000 })
          const shown = await card.getByRole("navigation", { name: "Operations" }).locator("button code").allTextContents()
          assert.deepEqual(shown.sort(), operations.map(operation => `${operation.method} ${operation.path}`).sort())
          const beforeSelection = await browserReads()
          await card.getByRole("button", { name: /^GET \/api\/todos(?: |$)/ }).click()
          assert.equal(await browserReads(), beforeSelection)
          await expect(card.getByRole("region", { name: "Exchange" })).toHaveCount(0)
          await card.getByRole("button", { name: "Send", exact: true }).click()
          await expect(card.getByText(/200 ·/)).toBeVisible({ timeout: 60_000 })
          assert.equal(await browserReads(), beforeSelection + 1)
          await card.getByRole("button", { name: /^PUT \/api\/secrets PUT/ }).click()
          assert.deepEqual(await card.locator("input:not([type=hidden]), textarea").evaluateAll(elements => elements.map(element =>
            Array.from(document.querySelectorAll("label")).find(label => label.htmlFor === element.id)?.textContent?.trim())), ["JSON"])
          await fillComposer(page, "/debug-api get_api_todos")
          await page.keyboard.press("Enter")
          await expect(card.getByRole("button", { name: /^GET \/api\/todos(?: |$)/ })).toHaveAttribute("aria-pressed", "true")
          assert.equal(await browserReads(), beforeSelection + 1)
          await expect(page.getByTestId("composer-input")).toBeEnabled()
          writeFileSync(join(outputDir, "browser.role-receipt.json"), `${JSON.stringify({ revision, layer: "CardRenderers browser against real backend and PostgreSQL", operations: shown.length, requestsOnSelection: 0, readStatus: 200 }, null, 2)}\n`)
          console.log("C-UI-10 REAL BROWSER PASS")
        } finally { await browser.close() }
      }
    } else if (selectedCase.startsWith("guard-")) {
      const missing = selectedCase.slice(6)
      assert.ok(missing === "catalog" || missing === "authorizer" || missing === "view")
      const gates = { catalog: true, authorizer: true, view: true }
      const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      let playgroundRequests = 0
      activeCookie = miaCookie
      const controller = createAppController(store, silentAgent, {
        openApi: async () => releaseDocument(), debugApiOrigin: origin, debugApiGates: () => gates,
        fetchImpl: (url, init) => {
          if (init?.redirect === "error") playgroundRequests++
          const headers = new Headers(init?.headers)
          headers.set("cookie", `smithers_session=${activeCookie}; __csrf=${csrf}`)
          headers.set("X-CSRF-Token", csrf); headers.set("Origin", origin)
          return fetch(new URL(String(url), origin), { ...init, headers })
        }
      })
      const values = { body: JSON.stringify(fixtures.write.body) }
      const send = JSON.stringify({ intent: "send", operationId: fixtures.write.operationId, values })
      const count = () => sql(`SELECT count(*) FROM repository_secrets WHERE repository_id=${repo.id}`)
      const settle = async (ready: () => boolean) => {
        for (let n = 0; n < 200 && !ready(); n++) await Bun.sleep(10)
        assert.ok(ready(), "controller background action settled")
      }
      try {
        assert.equal(count(), "0")
        gates[missing] = false
        assert.deepEqual(Object.entries(gates).filter(([, available]) => !available).map(([name]) => name), [missing])
        assert.equal((await controller.runCommandForResult("debug-api", fixtures.write.operationId)).status, "failed")
        assert.equal(store.collections.cards.has("debug-api"), false)
        assert.equal((await controller.runCommandForResult("debug.api", send)).status, "failed")
        assert.equal(playgroundRequests, 0)
        assert.equal(count(), "0")
        gates[missing] = true
        assert.equal((await controller.runCommandForResult("debug-api", fixtures.write.operationId)).status, "executed")
        await settle(() => store.collections.cards.has("debug-api"))
        assert.equal((await controller.runCommandForResult("debug.api", send)).status, "executed")
        await settle(() => !!controller.debugApi.get().confirmation)
        const confirmation = controller.debugApi.get().confirmation
        gates[missing] = false
        assert.equal((await controller.runCommandForResult("debug.api", JSON.stringify({ intent: "confirm", operationId: fixtures.write.operationId, values, confirmation }))).status, "failed")
        assert.equal(playgroundRequests, 0)
        assert.equal(count(), "0", "revoked dependency blocks an already mounted card and pending mutation")
        gates[missing] = true
        await controller.runCommandForResult("debug.api", send)
        await settle(() => !!controller.debugApi.get().confirmation)
        await controller.runCommandForResult("debug.api", JSON.stringify({ intent: "confirm", operationId: fixtures.write.operationId, values, confirmation: controller.debugApi.get().confirmation }))
        await settle(() => !!controller.debugApi.get().model.exchange && !controller.debugApi.get().busy)
        assert.equal(controller.debugApi.get().model.exchange?.response?.status, 201)
        assert.equal(playgroundRequests, 1)
        assert.equal(count(), "1", "positive control proves the same live transport can mutate SQL")
        writeFileSync(join(outputDir, "guard.role-receipt.json"), `${JSON.stringify({ revision, layer: "production app dispatcher and DebugApiSeam against real install HTTP and PostgreSQL", missing, refusedRequests: 0, refusedRows: 0, positiveControlStatus: 201, positiveControlRows: 1 }, null, 2)}\n`)
        console.log(`C-UI-10 REAL GUARD PASS: ${missing}`)
      } finally { await controller.dispose() }
    } else if (selectedCase === "signout") {
      await seam.open(fixtures.signout.operationId)
      assert.equal(requests, 0, "Opening and selecting sends nothing")
      const logout = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: {
        cookie: `smithers_session=${cookie}; __csrf=${csrf}`, "X-CSRF-Token": csrf, Origin: origin
      } })
      assert.equal(logout.status, 204)
      assert.ok(logout.headers.get("set-cookie")?.includes("smithers_session="))
      assert.equal(sql(`SELECT count(*) FROM auth_sessions WHERE session_key='${hash}'`), "0")
      await seam.send({ intent: "send", operationId: fixtures.signout.operationId })
      const exchange = structuredClone(seam.get().model.exchange!)
      assert.equal(requests, 1)
      assert.equal(exchange.response?.status, fixtures.signout.status)
      assert.deepEqual(JSON.parse(exchange.response!.body), fixtures.signout.body)
      assert.deepEqual(exchange.failure, { class: "permission", code: fixtures.signout.body.code, message: fixtures.signout.body.message, status: 401 })
      assert.equal(seam.get().busy, false, "Typed failure settles Send without a crash")
      // Apply the cleared browser credential and the existing account lifecycle.
      activeCookie = ""
      seam.endAccount()
      assert.equal(seam.get().model.exchange, undefined)
      // The same seam's transport reads activeCookie on every request.
      await seam.open(fixtures.signout.operationId)
      await seam.send({ intent: "send", operationId: fixtures.signout.operationId })
      assert.equal(requests, 2)
      assert.equal(sentCookies[1], `__csrf=${csrf}`)
      assert.ok(!sentCookies[1]!.includes(cookie))
      assert.equal(seam.get().model.exchange?.response?.status, 401)
      writeFileSync(join(outputDir, "signout.role-receipt.json"), `${JSON.stringify({ revision,
        layer: "real backend and PostgreSQL through DebugApiSeam", logoutStatus: logout.status,
        remainingSessionRows: 0, exchange, laterRequestUsesDeadSession: false }, null, 2)}\n`)
      console.log("C-UI-10 REAL SIGNOUT PASS: logout revokes Ben; 401 permission/unauthenticated; later Send has no dead session")
    } else {
      assert.equal(selectedCase, "write")
      const count = () => sql(`SELECT count(*) FROM repository_secrets WHERE repository_id=${repo.id}`)
      assert.equal(count(), "0")
      const values = { body: JSON.stringify(fixtures.write.body) }
      await seam.open(fixtures.write.operationId)
      assert.equal(requests, 0)
      await seam.send({ intent: "send", operationId: fixtures.write.operationId, values })
      assert.equal(requests, 0, "Ben Send awaits Confirm before transport")
      assert.equal(count(), "0")
      assert.ok(seam.get().confirmation)
      await seam.send({ intent: "confirm", operationId: fixtures.write.operationId, confirmation: seam.get().confirmation, values })
      assert.equal(requests, 1)
      const benExchange = structuredClone(seam.get().model.exchange!)
      const benRows = count()
      assert.equal(benExchange.response?.status, 403)
      assert.equal(benRows, "0", "Ben refusal has no SQL effect")
      activeCookie = miaCookie
      await seam.open(fixtures.write.operationId)
      await seam.send({ intent: "send", operationId: fixtures.write.operationId, values })
      assert.equal(requests, 1, "Mia Send awaits Confirm before transport")
      assert.equal(count(), "0")
      await seam.send({ intent: "confirm", operationId: fixtures.write.operationId, confirmation: seam.get().confirmation, values })
      assert.equal(requests, 2)
      const exchange = seam.get().model.exchange!
      const receipt = { revision, layer: "real backend and PostgreSQL through DebugApiSeam", ben: {
        requestsBeforeConfirm: 0, requestsAfterConfirm: 1, status: benExchange.response?.status,
        body: JSON.parse(benExchange.response!.body), failure: benExchange.failure, rows: Number(benRows)
      }, mia: { requestsBeforeConfirm: 0, requestsAfterConfirm: 1, status: exchange.response?.status,
        body: JSON.parse(exchange.response!.body), failure: exchange.failure, rows: Number(count()) } }
      writeFileSync(join(outputDir, "write.role-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`)
      console.log(`C-UI-10 REAL WRITE OBSERVED: ${JSON.stringify(receipt)}`)
      assert.deepEqual(JSON.parse(benExchange.response!.body), fixtures.write.denied, "Ben's literal role refusal, rather than a transport refusal")
      assert.deepEqual(benExchange.failure, { ...fixtures.write.denied, status: 403 })
      assert.equal(exchange.response?.status, 201, "Mia's real backend response")
      assert.equal(exchange.failure, undefined)
      const metadata = JSON.parse(exchange.response!.body)
      assert.deepEqual(Object.keys(metadata).sort(), ["created_at", "hosts", "main_only", "match_headers", "name", "updated_at"])
      assert.equal(metadata.name, fixtures.write.body.name)
      assert.equal(metadata.main_only, false)
      assert.deepEqual(metadata.hosts, [])
      assert.deepEqual(metadata.match_headers, [])
      assert.ok(Number.isFinite(Date.parse(metadata.created_at)))
      assert.ok(Number.isFinite(Date.parse(metadata.updated_at)))
      assert.equal(count(), "1")
      assert.equal(sql(`SELECT name||'|'||main_only||'|'||(octet_length(value_encrypted)>0) FROM repository_secrets WHERE repository_id=${repo.id}`), `${fixtures.write.body.name}|false|true`)
      assert.ok(!exchange.response!.body.includes(fixtures.write.body.value))
      console.log("C-UI-10 REAL WRITE PASS: Ben confirmation -> 403 permission, zero SQL rows; Mia confirmation -> 201 SecretMetadata, one encrypted SQL row")
    }
  } finally { seam.dispose() }
} finally { await session.close() }
