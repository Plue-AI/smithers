import assert from "node:assert/strict"
import { generateKeyPairSync, verify } from "node:crypto"
import { mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { appAuth, appConfig, MintLimited, TOKEN_MARGIN } from "./github-app-auth.mjs"

const T0 = new Date("2026-09-29T00:00:00Z")

describe("GitHub App credentials", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const KEY = privateKey.export({ type: "pkcs1", format: "pem" })
  const TOKEN = "ghs_installationTokenForTests"
  const SLUG = "smitherspreviewrelease"

  // A stub GitHub REST API for the two App calls: installation lookup and token mint.
  const stubApi = ({ installed = true, expiresIn = 3600_000, clock = () => T0, mint = 201 } = {}) => {
    const calls = []
    const request = ({ url, method, jwt }) => {
      calls.push({ url, method, jwt })
      if (url.endsWith("/installation")) return installed ? { status: 200, body: JSON.stringify({ id: 42, app_slug: SLUG }) } : { status: 404, body: "{\"message\":\"Not Found\"}" }
      if (url.endsWith("/app/installations/42/access_tokens") && method === "POST") {
        if (mint === 429) return { status: 429, retryAfter: "120", body: "{\"message\":\"API rate limit exceeded\"}" }
        if (mint === 500) return { status: 500, body: "boom" }
        return { status: 201, body: JSON.stringify({ token: `${TOKEN}${calls.length}`, expires_at: new Date(clock().getTime() + expiresIn).toISOString() }) }
      }
      return { status: 500, body: "{}" }
    }
    return { calls, request }
  }
  const appEnv = () => {
    const dir = mkdtempSync(join(tmpdir(), "github-app-auth-"))
    writeFileSync(join(dir, "key.pem"), KEY, { mode: 0o600 })
    return { ISSUE_CLAIM_CACHE: join(dir, "cache"), ISSUE_CLAIM_APP_ID: "4163546", ISSUE_CLAIM_APP_KEY_FILE: join(dir, "key.pem") }
  }

  it("mints an installation token with an App JWT and caches it 0600", () => {
    const env = appEnv()
    const api = stubApi()
    const auth = appAuth("smithersai/plue", { env, now: () => T0, request: api.request })
    assert.deepEqual(auth, { identity: `app:${SLUG}`, token: `${TOKEN}2`, installation: 42 })
    assert.deepEqual(api.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
      ["GET /repos/smithersai/plue/installation", "POST /app/installations/42/access_tokens"])
    const [header, payload, signature] = api.calls[0].jwt.split(".")
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" })
    const claims = JSON.parse(Buffer.from(payload, "base64url"))
    assert.equal(claims.iss, "4163546")
    assert.ok(claims.exp - claims.iat <= 600)
    assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")))
    assert.equal(statSync(join(env.ISSUE_CLAIM_CACHE, "app-4163546-smithersai.json")).mode & 0o777, 0o600)
  })

  it("reuses the cached token until five minutes before expiry, then mints a new one", () => {
    const env = appEnv()
    let at = T0
    const api = stubApi({ clock: () => at })
    const auth = () => appAuth("smithersai/smithers", { env, now: () => at, request: api.request })
    assert.equal(auth().token, `${TOKEN}2`)
    at = new Date(T0.getTime() + 3600_000 - TOKEN_MARGIN - 1000)
    assert.deepEqual(auth(), { identity: `app:${SLUG}`, token: `${TOKEN}2`, installation: 42 })
    assert.equal(api.calls.length, 2, "a token with more than 5 minutes left is reused")
    at = new Date(T0.getTime() + 3600_000 - TOKEN_MARGIN + 1000)
    assert.equal(auth().token, `${TOKEN}4`)
    assert.equal(api.calls.length, 4)
  })

  it("answers the gh user when no App is configured or it is not installed for the owner", () => {
    assert.deepEqual(appAuth("o/r", { env: { ISSUE_CLAIM_APP_CONFIG: "/nonexistent.json" } }), { identity: "gh-user" })
    const missing = appAuth("acme/tool", { env: appEnv(), now: () => T0, request: stubApi({ installed: false }).request })
    assert.equal(missing.identity, "gh-user")
    assert.match(missing.reason, /not installed for acme\/tool/)
  })

  it("reports a rate-limited mint with its retry instant, and any other refusal as an error", () => {
    assert.throws(() => appAuth("o/r", { env: appEnv(), now: () => T0, request: stubApi({ mint: 429 }).request }),
      (error) => error instanceof MintLimited && error.retryAt === T0.getTime() + 120_000)
    assert.throws(() => appAuth("o/r", { env: appEnv(), now: () => T0, request: stubApi({ mint: 500 }).request }),
      (error) => !(error instanceof MintLimited) && /HTTP 500 boom/.test(error.message) && !error.message.includes(KEY))
  })

  it("reads the App from the config file, expanding ~", () => {
    const dir = mkdtempSync(join(tmpdir(), "github-app-auth-"))
    writeFileSync(join(dir, "app.json"), JSON.stringify({ app_id: 7, private_key_path: "~/key.pem" }))
    const config = appConfig({ ISSUE_CLAIM_APP_CONFIG: join(dir, "app.json") })
    assert.equal(config.id, "7")
    assert.ok(config.keyFile.endsWith("/key.pem") && !config.keyFile.startsWith("~"))
    writeFileSync(join(dir, "partial.json"), JSON.stringify({ app_id: 7 }))
    assert.equal(appConfig({ ISSUE_CLAIM_APP_CONFIG: join(dir, "partial.json") }), null)
  })
})
