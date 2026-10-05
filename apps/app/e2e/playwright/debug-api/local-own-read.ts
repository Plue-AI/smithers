// Bun owns the native install; Playwright's Node worker cannot run Bun.spawn.
import { startLocalOwn } from "../../../scripts/mode-matrix/local-own"
import { createDebugApiSeam, type OpenApiDocument } from "../../../src/mainview/state/seams/DebugApiSeam"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parse } from "yaml"
import { strict as assert } from "node:assert"
import fixtures from "./role-cases.fixture.json"

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
  let requests = 0
  const sentCookies: string[] = []
  const seam = createDebugApiSeam({ origin, document: async () => parse(readFileSync(resolve("../../docs/api/openapi.yaml"), "utf8")) as OpenApiDocument,
    gates: () => ({ view: true, catalog: true, authorizer: true }),
    fetch: (url, init) => { requests++; const headers = new Headers(init.headers); headers.set("cookie", `${activeCookie ? `smithers_session=${activeCookie}; ` : ""}__csrf=${csrf}`); headers.set("X-CSRF-Token", csrf); sentCookies.push(headers.get("cookie")!); return fetch(url, { ...init, headers }) } })
  try {
    if (selectedCase === "read") {
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
    } else if (selectedCase === "signout") {
      await seam.open(fixtures.signout.operationId)
      assert.equal(requests, 0, "Opening and selecting sends nothing")
      const logout = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: {
        cookie: `smithers_session=${cookie}; __csrf=${csrf}`, "X-CSRF-Token": csrf
      } })
      assert.equal(logout.status, 204)
      assert.ok(logout.headers.get("set-cookie")?.includes("smithers_session="))
      assert.equal(sql(`SELECT count(*) FROM auth_sessions WHERE session_key='${hash}'`), "0")
      await seam.send({ intent: "send", operationId: fixtures.signout.operationId })
      const exchange = structuredClone(seam.get().model.exchange!)
      assert.equal(requests, 1)
      assert.equal(exchange.response?.status, fixtures.signout.status)
      assert.deepEqual(JSON.parse(exchange.response!.body), fixtures.signout.body)
      assert.deepEqual(exchange.failure, { class: "permission", message: fixtures.signout.body.message, status: 401 })
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
      const values = { "path:owner": repo.owner, "path:repo": repo.name, body: JSON.stringify(fixtures.write.body) }
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
      assert.equal(benExchange.failure?.class, "permission", "Ben's real backend error class")
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
