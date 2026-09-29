/*
 * Wave 7: the CANARY seam probe — launch-seam-probe.ts adapted for
 * https://canary.smithers.sh, where two things differ from the local stack:
 *
 *   1. NO signed-in session exists yet (identity has no GitHub OAuth creds —
 *      will's click). The identity/billing seams must answer their honest
 *      signed-out shapes (401/Unauthorized), never a 501, never a fake session.
 *   2. The insecure static gateway proxy was removed in 1.0. Its former raw
 *      mounts must answer 410, even if legacy deployment secrets remain.
 *
 *   3. The turn seam is session-gated on any deployment that has an identity
 *      seam (it spends the model credential and meters real dollars). Signed
 *      out, the PASS shape is the honest 401 — a 200 here would mean the live
 *      model is reachable by anyone on the internet. Pass the storage state
 *      that launch-mint-session.ts writes to run the LIVE metered turn instead.
 *
 *   bun scripts/canary-seam-probe.ts [product-origin] [storage-state.json]
 */
import { readFileSync } from "node:fs"

const origin = process.argv[2] ?? "https://canary.smithers.sh"
const storageStatePath = process.argv[3]
const cookie = storageStatePath === undefined
  ? undefined
  : (JSON.parse(readFileSync(storageStatePath, "utf8")) as {
    cookies: Array<{ name: string; value: string }>
  }).cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ")

let failures = 0
const check = (label: string, ok: boolean, detail: string): void => {
  if (ok) {
    console.log(`ok: ${label} — ${detail}`)
  } else {
    failures += 1
    console.log(`FAIL: ${label} — ${detail}`)
  }
}

// 1. Identity seam: signed-out honesty, never a 501, never an invented session.
const session = await fetch(`${origin}/api/user`)
const sessionBody = await session.text()
check(
  "identity seam /api/user answers signed-out honestly (no 501, no fake login)",
  session.status === 401 && !sessionBody.includes("\"login\""),
  `HTTP ${session.status} ${sessionBody.trim().slice(0, 120)}`
)
const scopes = await fetch(`${origin}/api/auth/scopes`)
check(
  "identity seam /api/auth/scopes serves the scope copy",
  scopes.status === 200,
  `HTTP ${scopes.status}`
)
await scopes.body?.cancel()
const oauthStart = await fetch(`${origin}/api/auth/github/start`, { redirect: "manual" })
const oauthStartBody = await oauthStart.text()
const oauthLocation = oauthStart.headers.get("location")
// Wave 8: either honest state passes — OAuth configured upstream redirects to
// GitHub's authorize page; unconfigured/erroring answers 5xx (the seam renders
// a branded HTML page for browsers, JSON for machines). Never a wrong-app
// redirect, never a fake success.
check(
  "OAuth start is honest in either upstream state (github.com redirect when on, 5xx naming the gap when off)",
  (oauthLocation !== null && oauthLocation.startsWith("https://github.com/")) ||
    (oauthStart.status >= 500 && oauthLocation === null),
  `HTTP ${oauthStart.status} ${oauthLocation ?? oauthStartBody.trim().slice(0, 140)}`
)

// 2. Billing seam: unsigned read is the honest 401 (session gate), not a 501.
const balance = await fetch(`${origin}/api/billing/balance`)
const balanceBody = await balance.text()
check(
  "billing seam /api/billing/balance unsigned -> honest 401 (never 501)",
  balance.status === 401,
  `HTTP ${balance.status} ${balanceBody.trim().slice(0, 140)}`
)

// 3. The watched-repos seam: unsigned is honest (401 from identity's own check), not a 501.
const watched = await fetch(`${origin}/api/identity/watched`)
const watchedBody = await watched.text()
check(
  "identity seam /api/identity/watched unsigned -> honest refusal (never 501)",
  watched.status !== 501 && watched.status !== 200,
  `HTTP ${watched.status} ${watchedBody.trim().slice(0, 140)}`
)

// 4. Chat seam. With a session: one LIVE streamed turn through the deployed
//    product (Cerebras, metered against deployed billing on the smithers-canary
//    account). Without one: the turn must REFUSE — this route spends the
//    deployment's model credential, so an anonymous 200 is money leaking to the
//    open internet, not a passing probe.
const turn = await fetch(`${origin}/api/agent/turn`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
  body: JSON.stringify({
    runId: `canary-seam-probe-${Date.now()}`,
    messages: [{ role: "user", content: "Say the word ok and nothing else." }],
    instructions: "Answer briefly."
  })
})
const turnBody = await turn.text()
if (cookie === undefined) {
  check(
    "chat seam /api/agent/turn REFUSES anonymously (401 — the live model is not world-reachable)",
    turn.status === 401,
    `HTTP ${turn.status} ${turnBody.trim().slice(0, 140)}`
  )
} else {
  check(
    "chat seam /api/agent/turn streamed LIVE to a terminal frame",
    turn.status === 200 && turnBody.includes("\"type\":\"done\""),
    `HTTP ${turn.status}, ${turnBody.split("\n").filter((l) => l.trim() !== "").length} NDJSON lines, done frame: ${
      turnBody.includes("\"type\":\"done\"")
    }`
  )
}

// 5. Raw gateway forwarding must stay retired. The per-user workflow relay
//    has its own session/target tests; this check must not provision a run.
const gateway = await fetch(`${origin}/health`)
const gatewayBody = await gateway.json() as { code?: string }
check(
  "static gateway proxy stays retired",
  gateway.status === 410 && gatewayBody.code === "gateway_proxy_removed",
  `HTTP ${gateway.status}`
)

// 6. Admin surface: a signed-out probe is byte-identical to an unknown route.
const adminProbe = await fetch(`${origin}/api/admin/health`)
const unknownProbe = await fetch(`${origin}/api/definitely-not-a-route`)
const adminBody = await adminProbe.text()
const unknownBody = await unknownProbe.text()
check(
  "admin surface is non-enumerable signed-out (404 byte-identical)",
  adminProbe.status === 404 && adminBody === unknownBody,
  `admin HTTP ${adminProbe.status} vs unknown HTTP ${unknownProbe.status}, byte-identical: ${adminBody === unknownBody}`
)

// 7. The SPA itself serves.
const spa = await fetch(`${origin}/`)
check("SPA serves", spa.status === 200, `HTTP ${spa.status}`)
await spa.body?.cancel()

if (failures > 0) {
  console.log(`\nCANARY SEAM PROBE FAILED: ${failures} check(s).`)
  process.exit(1)
}
console.log(
  `\nCANARY SEAM PROBE PASS: every seam honest — signed-out refusals, ${
    cookie === undefined ? "turn seam closed to anonymous callers" : "live metered chat"
  }, static gateway proxy retired.`
)