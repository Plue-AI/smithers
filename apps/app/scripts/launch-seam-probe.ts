/*
 * Wave 6: the seam probe. Against a running product Worker it exercises every
 * configured backend seam end to end and fails on ANY 501 ("not configured")
 * or seam-level auth refusal — the proof that the local full stack is wired
 * with zero unconfigured seams before the launch checklist runs.
 *
 *   bun scripts/launch-seam-probe.ts <product-origin> <storage-state.json>
 *
 * The storage state is the one launch-mint-session.ts writes; the probe
 * replays its session cookie exactly like the browser would.
 */
import { readFileSync } from "node:fs"

const [origin, storageStatePath] = process.argv.slice(2)
if (origin === undefined || storageStatePath === undefined) {
  console.error("usage: bun scripts/launch-seam-probe.ts <product-origin> <storage-state.json>")
  process.exit(2)
}

const storageState = JSON.parse(readFileSync(storageStatePath, "utf8")) as {
  cookies: Array<{ name: string; value: string }>
}
const cookie = storageState.cookies.map((c) => `${c.name}=${c.value}`).join("; ")

let failures = 0
const check = (label: string, ok: boolean, detail: string): void => {
  if (ok) {
    console.log(`ok: ${label} — ${detail}`)
  } else {
    failures += 1
    console.log(`FAIL: ${label} — ${detail}`)
  }
}
// Reads the body exactly once and returns it; records the 501 verdict.
const no501 = async (label: string, response: Response): Promise<string> => {
  const body = await response.text()
  check(label, response.status !== 501, `HTTP ${response.status} ${body.trim().slice(0, 160)}`)
  return body
}

// 1. Identity seam: the session route answers a definitive signed-in session.
const session = await fetch(`${origin}/api/user`, { headers: { cookie } })
const sessionBody = await no501("identity seam /api/user", session)
{
  const body = JSON.parse(sessionBody || "{}") as { login?: string; allowlisted?: boolean }
  check(
    "identity session is signed in + allowlisted",
    typeof body.login === "string" && body.allowlisted === true,
    sessionBody.trim().slice(0, 160)
  )
}
const scopes = await fetch(`${origin}/api/auth/scopes`)
await no501("identity seam /api/auth/scopes", scopes)

// 2. Billing seam: a signed-in balance read answers dollars, not a 501/401.
const balance = await fetch(`${origin}/api/billing/balance`, { headers: { cookie } })
const balanceBody = await no501("billing seam /api/billing/balance", balance)
{
  const body = JSON.parse(balanceBody || "{}") as { balance?: { totalUsd?: number | string } }
  const total = Number(body.balance?.totalUsd)
  check(
    "billing balance reads dollars",
    balance.status === 200 && Number.isFinite(total),
    `HTTP ${balance.status} totalUsd=${String(body.balance?.totalUsd)}`
  )
}

// 3. The watched-repos seam: the durable selection answers (never a 501).
const watched = await fetch(`${origin}/api/identity/watched`, { headers: { cookie } })
await no501("identity seam /api/identity/watched", watched)

// 4. Chat seam: one streamed turn completes (delta … done), never a 501/401.
const turn = await fetch(`${origin}/api/agent/turn`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({
    runId: `seam-probe-${Date.now()}`,
    messages: [{ role: "user", content: "Say the word ok and nothing else." }],
    instructions: "Answer briefly."
  })
})
const turnBody = await no501("chat seam /api/agent/turn", turn)
check(
  "chat turn streamed to a terminal frame",
  turn.status === 200 && turnBody.includes("\"type\":\"done\""),
  `HTTP ${turn.status}, ${turnBody.split("\n").length} NDJSON lines, done frame: ${
    turnBody.includes("\"type\":\"done\"")
  }`
)

/*
 * 5. The insecure static gateway proxy is retired, not merely unconfigured.
 * A decision uses the session-validated /api/workflow/rpc relay, which needs
 * a provisioned workspace and parked run this probe has no business creating.
 */
const gatewayHealth = await fetch(`${origin}/health`, { headers: { cookie } })
const gatewayBody = await gatewayHealth.json() as { code?: string }
check("static gateway proxy stays retired", gatewayHealth.status === 410 && gatewayBody.code === "gateway_proxy_removed", `HTTP ${gatewayHealth.status}`)

// 6. Admin surface: a signed-in NON-admin probe is byte-identical to an
// unknown route (404, never 403, never a 501).
const adminProbe = await fetch(`${origin}/api/admin/health`, { headers: { cookie } })
const unknownProbe = await fetch(`${origin}/api/definitely-not-a-route`, { headers: { cookie } })
const adminBody = await adminProbe.text()
const unknownBody = await unknownProbe.text()
check(
  "admin surface is non-enumerable for non-admins (404 byte-identical, no 501)",
  // 404 is the whole assertion: it is neither the 403 that would confirm the
  // route exists nor the 501 an unimplemented seam would answer.
  adminProbe.status === 404 && adminBody === unknownBody,
  `admin HTTP ${adminProbe.status} vs unknown HTTP ${unknownProbe.status}, byte-identical: ${adminBody === unknownBody}`
)

// 7. The SPA itself serves.
const spa = await fetch(`${origin}/`)
check("SPA serves", spa.status === 200, `HTTP ${spa.status}`)
await spa.body?.cancel()

if (failures > 0) {
  console.log(`\nSEAM PROBE FAILED: ${failures} check(s) — the stack has an unconfigured or refusing seam.`)
  process.exit(1)
}
console.log("\nSEAM PROBE PASS: zero 501s, every configured seam answered end to end.")