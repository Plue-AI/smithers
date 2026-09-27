/*
 * CN-18: the backing services answer a health probe.
 *
 *   bun scripts/canary/workers-health.ts [--timeout <ms>]
 *
 * apps/app/scripts/canary-seam-probe.ts already probes the seams THROUGH the
 * product Worker, which is the right test for "is the product honest about its
 * upstreams". It cannot tell a healthy upstream from a proxy that never called
 * one, and it says nothing at all about the five Workers apps/server does not
 * proxy (connectors-catalog, cron, status, sync, webhooks). This probe is the
 * other half: it calls each Worker directly, at its own origin, with no
 * credential. When both pass, the seam and the service behind it are both good;
 * when this one fails and the seam probe passes, the product is masking an
 * outage.
 *
 * Three states per Worker, never conflated:
 *
 *   healthy         it answered its contract (see workers-manifest.ts).
 *   unhealthy       it answered wrongly, answered 5xx, or did not answer.
 *   not-configured  this deployment declares it unset ($CANARY_WORKER_ORIGINS).
 *                   Not a failure — canary-seam-probe.ts models the same
 *                   honesty for the deliberately-unset gateway seam.
 *
 * Exit 1 when any Worker is unhealthy, and also when NOTHING was configured — a
 * run that asserted nothing must not report PASS. Exit 2 when the probe could
 * not run at all, which is a different fact from a Worker being down.
 */
import {
  BACKING_WORKERS,
  expandTargets,
  healthUrl,
  ORIGIN_OVERRIDE_ENV,
  withOriginOverrides
} from "./workers-manifest.ts"
import type { BackingWorker } from "./workers-manifest.ts"

/** The slice of Response this probe uses, so a test can hand it a fake. */
export interface ProbeResponse {
  readonly status: number
  text(): Promise<string>
}

export type ProbeFetch = (
  url: string,
  init: { readonly signal: AbortSignal; readonly headers: Record<string, string> }
) => Promise<ProbeResponse>

export type HealthState = "healthy" | "unhealthy" | "not-configured"

/**
 * What came back in the body.
 *
 *   none     Nothing was read: the Worker is unset, or reading the body failed.
 *            Every contract fails closed on it.
 *   text     The raw body, kept for the responds contract, which reads it to
 *            rule out Cloudflare's edge error page (see cloudflareEdgeError).
 *   json     Parsed JSON, for the ok-json contract.
 *   invalid  A body that was supposed to be JSON and is not.
 */
export type HealthBody =
  | { readonly kind: "none" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "invalid"; readonly text: string }

/** What the probe read back. */
export interface HealthObservation {
  readonly worker: BackingWorker
  /** undefined when the request never completed. */
  readonly status: number | undefined
  readonly body: HealthBody
  readonly transportError: string | undefined
  readonly elapsedMs: number
}

export interface HealthVerdict {
  readonly name: string
  readonly state: HealthState
  readonly detail: string
}

const DEFAULT_TIMEOUT_MS = 8_000

/** Cap what a stranger's response body can print into CI logs. */
const excerpt = (text: string, limit = 120): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * How much of a response body the probe keeps. Cloudflare's edge error bodies
 * are a few hundred bytes of JSON or plain text and its HTML pages run to
 * roughly 20 KiB with their markers in the first 2 KiB, so this holds every
 * shape cloudflareEdgeError looks for while bounding what a stranger's Worker
 * can make this process allocate.
 */
const MAX_BODY_CHARS = 16_384

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Report the error code when a body came from Cloudflare's edge rather than
 * from a Worker.
 *
 * This is the whole of CN-18. The edge answers for a hostname with nothing
 * deployed behind it, and it answers with the same status a live Worker uses.
 * Measured 2026-08-19: an undeployed *.workers.dev host answered HTTP 404, and
 * so did the live chat Worker at /. Status cannot separate them. Body can.
 *
 * The edge content-negotiates its error, so there is no single body to match.
 * All three shapes were captured from the same undeployed host on 2026-08-19 by
 * varying only the request headers:
 *
 *   json   What THIS probe receives, because it sends `accept: application/json`
 *          and a compressed encoding. An RFC 9457 problem document that names
 *          itself: `"cloudflare_error": true`, a `type` under
 *          developers.cloudflare.com, and the triple `"error_code": 1042`,
 *          `"error_name": "workers_dev_script_not_found"`, `"ray_id"`. Any one
 *          of those three signals is conclusive on its own.
 *   plain  `error code: NNNN` and nothing else. What an uncompressed non-browser
 *          request gets, and the historical shape most Cloudflare documentation
 *          still shows.
 *   page   HTML. Two generations are in service: the classic branded error page,
 *          keyed by the `cf-error-details` and `cf-error-code` hooks Cloudflare's
 *          own stylesheet targets, and the newer workers.dev "Page not found"
 *          page, which carries no error code and is keyed by its title together
 *          with the workers.cloudflare.com favicon it loads. The classic page is
 *          what the edge serves for WAF and rate-limit blocks, which arrive as
 *          403 and 429 — statuses a responds Worker is otherwise allowed to
 *          answer with.
 *
 * Keyed on the shape and on Cloudflare's self-identification, never on a
 * particular error number: Cloudflare assigns a code per failure mode and adds
 * new ones, but every code is rendered through these templates. Every match is
 * anchored — the plain form must be the entire body, and the JSON form must be
 * a top-level object with an edge-authored field — so a Worker that quotes the
 * phrase inside a larger message is not mistaken for the edge.
 */
export const cloudflareEdgeError = (text: string): string | undefined => {
  const flat = text.trim()

  const plain = /^error code:\s*(\d{3,5})$/i.exec(flat)
  if (plain !== null) return plain[1]

  if (flat.startsWith("{")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(flat) as unknown
    } catch {
      parsed = undefined
    }
    if (isRecord(parsed)) {
      const type = typeof parsed.type === "string" ? parsed.type : ""
      // Each disjunct is something only the edge writes. `error_name` is
      // not one of them on its own — a Worker could ship that key — so it
      // counts only alongside the numeric code and the Ray ID.
      const authored = parsed.cloudflare_error === true ||
        type.startsWith("https://developers.cloudflare.com/") ||
        (typeof parsed.error_code === "number" &&
          typeof parsed.error_name === "string" &&
          typeof parsed.ray_id === "string")
      if (authored) {
        const code = parsed.error_code
        return typeof code === "number" || typeof code === "string" ? String(code) : "unnumbered"
      }
    }
    return undefined
  }

  if (/cf-error-details|cf-error-code/i.test(flat)) {
    const numbered = /class="cf-error-code"[^>]*>\s*(\d{3,5})/i.exec(flat) ?? /error code:?\s*(\d{3,5})/i.exec(flat)
    // The page without a readable number is still the edge, so it still fails.
    return numbered?.[1] ?? "unnumbered"
  }

  // The newer workers.dev placeholder. Both markers are required: the title
  // alone is a phrase any Worker could return, and the favicon host alone
  // could appear in a Worker's own page.
  if (/<title>\s*Page not found\s*<\/title>/i.test(flat) && flat.includes("workers.cloudflare.com/favicon.ico")) {
    return "unnumbered"
  }

  return undefined
}

/**
 * Name the failure the way an operator would triage it. A timeout, a DNS
 * failure, and a refused connection have different owners, so they must not
 * collapse into one "fetch failed".
 */
export const describeTransportError = (error: unknown, timeoutMs: number): string => {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return `timed out after ${timeoutMs}ms`
    const cause = (error as { cause?: unknown }).cause
    const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined
    if (typeof code === "string") return `${error.message} (${code})`
    return error.message
  }
  return typeof error === "string" ? error : "unknown transport error"
}

/** Read one Worker. An unset Worker is not fetched at all. */
export const probeWorker = async (
  worker: BackingWorker,
  options: { readonly fetch: ProbeFetch; readonly timeoutMs?: number; readonly now?: () => number }
): Promise<HealthObservation> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? Date.now
  const url = healthUrl(worker)
  if (url === undefined) {
    return { worker, status: undefined, body: { kind: "none" }, transportError: undefined, elapsedMs: 0 }
  }

  const started = now()
  let response: ProbeResponse
  try {
    response = await options.fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      // No credential, no cookie: health is a public fact about these
      // Workers, and a probe that needed a secret could not run in CI.
      headers: { accept: "application/json", "user-agent": "smithers-canary-workers-health" }
    })
  } catch (error) {
    return {
      worker,
      status: undefined,
      body: { kind: "none" },
      transportError: describeTransportError(error, timeoutMs),
      elapsedMs: now() - started
    }
  }

  // The `responds` contract KEEPS the body. It used to drain and drop it, on
  // the theory that routability was the whole assertion; a *.workers.dev
  // hostname with no Worker behind it answers HTTP 404, byte-identical in
  // status to the healthy chat Worker's own 404, so the status alone reported
  // a deleted Worker as healthy (CN-18, proved live 2026-08-19). The body is
  // what tells the edge apart from the Worker.
  if (worker.contract === "responds") {
    const read = await response.text().then(
      (value) => ({ ok: true, text: value.slice(0, MAX_BODY_CHARS) }),
      () => ({ ok: false, text: "" })
    )
    return {
      worker,
      status: response.status,
      // A body that could not be read leaves the edge-error check unable to
      // run, so it stays `none` and the verdict fails closed. Guessing here
      // would restore the exact hole this contract was widened to close.
      body: read.ok ? { kind: "text", text: read.text } : { kind: "none" },
      transportError: undefined,
      elapsedMs: now() - started
    }
  }

  const text = (await response.text().catch(() => "")).slice(0, MAX_BODY_CHARS)
  let body: HealthBody
  try {
    body = { kind: "json", value: JSON.parse(text) as unknown }
  } catch {
    body = { kind: "invalid", text }
  }
  return { worker, status: response.status, body, transportError: undefined, elapsedMs: now() - started }
}

export const workerHealthVerdict = (observation: HealthObservation): HealthVerdict => {
  const { worker, status, elapsedMs } = observation
  const name = worker.name
  if (worker.origin === undefined) {
    return {
      name,
      state: "not-configured",
      detail:
        `${name} is not configured on this deployment (no origin in workers-manifest.ts, or $${ORIGIN_OVERRIDE_ENV} declares it unset); nothing probed.`
    }
  }
  if (observation.transportError !== undefined) {
    return {
      name,
      state: "unhealthy",
      detail: `${name} ${worker.origin} did not answer: ${observation.transportError}`
    }
  }
  if (status === undefined) {
    return { name, state: "unhealthy", detail: `${name} ${worker.origin} did not answer.` }
  }

  const target = healthUrl(worker) ?? worker.origin
  if (worker.contract === "responds") {
    if (status >= 500) return { name, state: "unhealthy", detail: `${name} ${target} answered HTTP ${status}.` }
    if (observation.body.kind !== "text") {
      return {
        name,
        state: "unhealthy",
        detail:
          `${name} ${target} answered HTTP ${status} but its body was not read, so Cloudflare's edge error page cannot be ruled out.`
      }
    }
    const edgeCode = cloudflareEdgeError(observation.body.text)
    if (edgeCode !== undefined) {
      return {
        name,
        state: "unhealthy",
        detail:
          `${name} ${target} answered HTTP ${status}, but the body is Cloudflare's edge error page (error code ${edgeCode}), not the Worker's: ${
            excerpt(observation.body.text)
          }. Nothing is deployed on this route.`
      }
    }
    return {
      name,
      state: "healthy",
      detail: `${name} ${target} answered HTTP ${status} in ${elapsedMs}ms — ${worker.note}`
    }
  }

  if (status !== 200) {
    // Same edge/Worker distinction, reported for triage only: an ok-json
    // Worker already fails on any non-200, but "answered HTTP 404" and
    // "nothing is deployed there" send an operator to different places.
    const raw = observation.body.kind === "invalid" ? cloudflareEdgeError(observation.body.text) : undefined
    if (raw !== undefined) {
      return {
        name,
        state: "unhealthy",
        detail:
          `${name} ${target} answered HTTP ${status} from Cloudflare's edge (error code ${raw}), not from the Worker. Nothing is deployed on this route.`
      }
    }
    return { name, state: "unhealthy", detail: `${name} ${target} answered HTTP ${status}.` }
  }
  if (observation.body.kind === "invalid") {
    return {
      name,
      state: "unhealthy",
      detail: `${name} ${target} answered HTTP 200 but the body is not JSON: ${excerpt(observation.body.text)}`
    }
  }
  if (observation.body.kind !== "json") {
    return { name, state: "unhealthy", detail: `${name} ${target} answered HTTP 200 but no JSON body was read.` }
  }
  if (worker.contract === "application-bootstrap") {
    const body = observation.body.value
    const valid = isRecord(body) && body.apiVersion === 1 && typeof body.host === "string" &&
      typeof body.version === "string" && Array.isArray(body.capabilities) &&
      body.capabilities.includes("agent") && body.capabilities.includes("identity")
    return { name, state: valid ? "healthy" : "unhealthy", detail: `${name} ${target} ${valid ? "answered canonical application bootstrap" : "did not answer the canonical application contract"}` }
  }
  if (worker.contract === "status-ok-json") {
    const body = observation.body.value
    const checks = isRecord(body) && isRecord(body.checks) ? Object.entries(body.checks) : undefined
    const failing = checks?.filter(([, value]) => value !== "ok").map(([key]) => key) ?? []
    if (!isRecord(body) || body.status !== "ok" || checks === undefined || failing.length > 0) {
      return {
        name,
        state: "unhealthy",
        detail: `${name} ${target} answered HTTP 200 without status "ok" on every check${failing.length > 0 ? ` (${failing.join(", ")})` : ""}: ${excerpt(JSON.stringify(body))}`
      }
    }
  } else if (!isRecord(observation.body.value) || observation.body.value.ok !== true) {
    return {
      name,
      state: "unhealthy",
      detail: `${name} ${target} answered HTTP 200 without ok:true: ${excerpt(JSON.stringify(observation.body.value))}`
    }
  }
  return {
    name,
    state: "healthy",
    detail: `${name} ${target} ok in ${elapsedMs}ms — ${excerpt(JSON.stringify(observation.body.value))}`
  }
}

export interface HealthSummary {
  readonly healthy: number
  readonly unhealthy: number
  readonly notConfigured: number
  readonly exitCode: number
  readonly line: string
}

export const summarizeHealth = (verdicts: ReadonlyArray<HealthVerdict>): HealthSummary => {
  const healthy = verdicts.filter((verdict) => verdict.state === "healthy").length
  const unhealthy = verdicts.filter((verdict) => verdict.state === "unhealthy").length
  const notConfigured = verdicts.filter((verdict) => verdict.state === "not-configured").length
  // Targets, not Workers: identity and chat each answer on more than one
  // route, and every route the product configures is probed.
  const counts =
    `${healthy} healthy, ${unhealthy} unhealthy, ${notConfigured} not configured, of ${verdicts.length} targets`
  if (unhealthy > 0) {
    const names = verdicts.filter((verdict) => verdict.state === "unhealthy").map((verdict) => verdict.name)
    return { healthy, unhealthy, notConfigured, exitCode: 1, line: `CN-18 FAILED: ${counts} — ${names.join(", ")}` }
  }
  if (healthy === 0) {
    return {
      healthy,
      unhealthy,
      notConfigured,
      exitCode: 1,
      // A run that probed nothing is not a passing run. Without this, an
      // override that blanks the manifest reports a green CN-18 forever.
      line: `CN-18 ASSERTED NOTHING: ${counts}. Check $${ORIGIN_OVERRIDE_ENV}.`
    }
  }
  return { healthy, unhealthy, notConfigured, exitCode: 0, line: `CN-18 PASS: ${counts}` }
}

export const formatVerdictLine = (verdict: HealthVerdict): string => {
  if (verdict.state === "healthy") return `ok: ${verdict.detail}`
  if (verdict.state === "not-configured") return `skip: ${verdict.detail}`
  return `FAIL: ${verdict.detail}`
}

/** Probe every Worker concurrently and report, in manifest order. */
export const runWorkersHealth = async (options: {
  readonly fetch: ProbeFetch
  readonly env: Record<string, string | undefined>
  readonly timeoutMs?: number
  readonly now?: () => number
  readonly log: (line: string) => void
}): Promise<HealthSummary> => {
  const targets = expandTargets(withOriginOverrides(BACKING_WORKERS, options.env[ORIGIN_OVERRIDE_ENV]))
  const observations = await Promise.all(
    targets.map((worker) =>
      probeWorker(worker, { fetch: options.fetch, timeoutMs: options.timeoutMs, now: options.now })
    )
  )
  const verdicts = observations.map(workerHealthVerdict)
  for (const verdict of verdicts) options.log(formatVerdictLine(verdict))
  const summary = summarizeHealth(verdicts)
  options.log("")
  options.log(summary.line)
  return summary
}

if (import.meta.main) {
  const timeoutFlag = process.argv.indexOf("--timeout")
  const timeoutMs = timeoutFlag === -1 ? DEFAULT_TIMEOUT_MS : Number(process.argv[timeoutFlag + 1])
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error(`--timeout wants a positive number of milliseconds, got ${process.argv[timeoutFlag + 1]}`)
    process.exit(2)
  }
  try {
    const summary = await runWorkersHealth({
      fetch: (url, init) => fetch(url, init),
      env: process.env,
      timeoutMs,
      log: (line) => console.log(line)
    })
    process.exit(summary.exitCode)
  } catch (error) {
    // A rejected run means the probe never ran, which is a different thing
    // from a Worker being down. Exit 2, and print the reason rather than a
    // stack trace an operator has to read past.
    console.error(`CN-18 DID NOT RUN: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
