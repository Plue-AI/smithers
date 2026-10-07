/** Probe the canonical HTTP contracts used by every application mode. */
import { readFileSync } from "node:fs"
import { APP_BOOTSTRAP_PATH, AppBootstrapSchema } from "@smthrs/rpc/AppBootstrap"
import { AUTHENTICATED_USER_PATH, ApplicationUserSchema } from "@smthrs/rpc/ApplicationAuth"
import { conversationProbe, PROMPT_PATH, promptBody } from "../../server/scripts/canary/conversation-probe"
import { csrfHeaders } from "../../server/scripts/canary/uptime-checks"

export async function probeCanonicalSeams(origin: string, cookie?: string): Promise<readonly string[]> {
  const failures: string[] = []
  const request = (path: string, init?: RequestInit) => fetch(new URL(path, origin), { redirect: "manual", signal: AbortSignal.timeout(90_000), ...init })
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label) }
  const bootstrap = await request(APP_BOOTSTRAP_PATH)
  check("bootstrap", bootstrap.status === 200 && AppBootstrapSchema.safeParse(await bootstrap.json().catch(() => null)).success)
  for (const path of [AUTHENTICATED_USER_PATH, "/api/user/repos", "/api/billing/balance"]) {
    const response = await request(path)
    check(`anonymous ${path}`, response.status === 401)
    await response.body?.cancel()
  }
  const oauth = await request("/api/auth/github")
  const location = oauth.headers.get("location")
  let destination: URL | undefined
  try { if (location) destination = new URL(location, origin) } catch {}
  check("OAuth configured", [302, 303, 307, 308].includes(oauth.status) && destination !== undefined && (
    destination.origin === "https://github.com" && destination.pathname === "/login/oauth/authorize" ||
    destination.origin === "https://smithers.sh" && destination.pathname === "/api/auth/github"
  ))
  await oauth.body?.cancel()
  const runId = `canary-seam-${crypto.randomUUID()}`
  if (cookie) {
    const identity = await request(AUTHENTICATED_USER_PATH, { headers: { cookie } })
    const user = ApplicationUserSchema.safeParse(await identity.json().catch(() => null))
    const permitted = identity.status === 200 && user.success && user.data.is_admin === false
    check("scoped identity", permitted)
    if (!permitted) return failures
  }
  if (!cookie) {
    const turn = await request(PROMPT_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: promptBody(runId) })
    check("anonymous prompt", turn.status === 401)
    await turn.body?.cancel()
  } else {
    try {
      const turn = await conversationProbe({ origin, key: runId, headers: { cookie, ...csrfHeaders(cookie) }, signal: AbortSignal.timeout(90_000), fetch, sleep: ms => Bun.sleep(ms) })
      check("completed host turn", turn.status === 202 && turn.state === "completed" && turn.frames.some(frame => frame.type === "done"))
    } catch { check("completed host turn", false) }
  }
  const spa = await request("/")
  check("SPA", spa.status === 200 && (spa.headers.get("content-type") ?? "").includes("text/html"))
  await spa.body?.cancel()
  return failures
}

if (import.meta.main) {
  const origin = process.argv[2] ?? "https://canary.smithers.sh"
  const state = process.argv[3]
  const cookie = state ? (JSON.parse(readFileSync(state, "utf8")) as { cookies: Array<{ name: string; value: string; domain: string }> }).cookies
    .filter(c => new URL(origin).hostname === c.domain.replace(/^\./, "") || new URL(origin).hostname.endsWith(c.domain.startsWith(".") ? c.domain : `.${c.domain}`))
    .map(c => `${c.name}=${c.value}`).join("; ") : undefined
  const failures = await probeCanonicalSeams(origin, cookie)
  console.log(failures.length ? `CANARY SEAM PROBE FAILED: ${failures.join(", ")}` : "CANARY SEAM PROBE PASS")
  process.exitCode = failures.length ? 1 : 0
}
