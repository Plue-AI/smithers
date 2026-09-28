import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Semaphore from "effect/Semaphore"
import { runDurable } from "./Boundary"
import { answeredJson, DurableStorage, namespaceCall, storageLayer } from "./DurableStorage"
import type { NativeNamespace, NativeStorage } from "./DurableStorage"
import { WORKER_FAILURES } from "@smthrs/rpc/WorkerFailureCodes"
import type { WorkerFailureCode } from "@smthrs/rpc/WorkerFailureCodes"
import { CryptoFailure } from "./Failures"
/**
 * A per-login ceiling on model calls, because every one of them spends model
 * dollars.
 *
 * The unit is ONE CALL TO A MODEL-SPENDING ROUTE, not one thing the user typed.
 * That distinction became load-bearing when the browser Agent Chain became the
 * only chat backend: the loop runs in the page and authors a fresh link over
 * `/api/model/stream` for each step of a turn, bounded at 32 links, so one
 * message can spend many units where the old server-side turn spent exactly
 * one. The ceiling below is sized in those units.
 *
 * Chat is complimentary during the alpha (DESIGN.md §1): a $0 balance never
 * pauses the composer, and the zero-balance guard in the client covers workflow
 * launch, not chat. That is a deliberate product decision and this module does
 * not touch it. What it adds is the thing a comped seam has no other defence
 * against: a runaway client, a stuck retry loop, or a lifted session cookie can
 * post turns as fast as the network allows, and the first anyone would know is
 * the invoice.
 *
 * So this is an ABUSE ceiling, not a billing pause. It sits far above what a
 * person chatting hard reaches in an hour, and its refusal says so — an alpha
 * user who trips it has hit a bug, not a paywall, and must never be told to go
 * buy something.
 *
 * Each ceiling has its own Durable Object: hourly and daily per validated
 * login, plus one shared signed-in bucket. A client cannot name its own
 * bucket. Fixed windows, not a rolling log — the
 * ceiling is loose enough that the boundary effect (up to 2x across a window
 * edge) does not matter, and one counter is far cheaper than a timestamp list.
 */

/**
 * Model calls one login may start per window.
 *
 * A heavy hour of conversation is about sixty messages, and a chain turn
 * authors a handful of links for each — so sixteen calls a message is already a
 * pessimistic reading of a hard hour. A thousand keeps the same ten-times
 * headroom the ceiling has always had, and still stops a lifted cookie posting
 * as fast as the network allows: at the alpha's rate card a spent window is
 * about a dollar, which is a bug someone notices rather than an invoice nobody
 * saw coming.
 */
export const TURN_WINDOW_MAX = 1000

/** The window the ceiling applies over. */
export const TURN_WINDOW_MS = 60 * 60 * 1000

/**
 * A ceiling: how many model calls one bucket may start per window, and whose
 * bucket it is. The kind picks the refusal's wording, because a login that
 * trips its ceiling has hit a bug, a visitor who trips theirs has reached
 * the end of what exploring offers, and a visitor refused by the
 * deployment-wide bucket has done nothing at all.
 */
export interface TurnCeiling {
  /**
   * `recommend` is the command recommender's ceiling (recommend.ts): the
   * same counter, spent on a route that costs a small model call and that
   * chat never depends on, so its refusal says suggestions paused and
   * nothing else. `erase` is the deletion outbox's address bucket, which a
   * browser retries on its own.
   */
  readonly kind: "login" | "login-daily" | "login-all" | "anonymous" | "anonymous-all" | "recommend" | "erase"
  readonly max: number
  readonly windowMs: number
}

/** The per-login ceiling above. */
export const LOGIN_CEILING: TurnCeiling = { kind: "login", max: TURN_WINDOW_MAX, windowMs: TURN_WINDOW_MS }

/** Five full hourly budgets per login bounds a loop that persists all day. */
export const LOGIN_DAILY_CEILING: TurnCeiling = {
  kind: "login-daily",
  max: 5000,
  windowMs: 24 * 60 * 60 * 1000
}

/** Ten full daily budgets bounds a loop spread across signed-in accounts. */
export const LOGIN_ALL_CEILING: TurnCeiling = {
  kind: "login-all",
  max: 50_000,
  windowMs: LOGIN_DAILY_CEILING.windowMs
}

/** Colons cannot occur in a GitHub login; the existing hourly key stays intact. */
export const loginDailyKey = (login: string): string => `login:daily:${login}`
export const LOGIN_ALL_KEY = "login:all"

/**
 * Turns one signed-out visitor may start per day while exploring a public
 * catalog repository (smithers.sh/smithersai/smithers, PUBLIC-REPOSITORIES.md).
 *
 * An anonymous turn spends the deployment's own model credential and is never
 * attributed to an account, so unlike the login ceiling this is a COST cap,
 * not an abuse guard: twenty questions is a real look at a codebase, and the
 * refusal names sign-in as the way to keep going. The bucket is a salted hash
 * of the client IP (`anonymousTurnKey`): a visitor cannot name their own
 * bucket, and the store never holds a raw address.
 */
export const ANONYMOUS_TURN_MAX = 20

/** The anonymous window: one day. */
export const ANONYMOUS_TURN_WINDOW_MS = 24 * 60 * 60 * 1000

export const ANONYMOUS_CEILING: TurnCeiling = {
  kind: "anonymous",
  max: ANONYMOUS_TURN_MAX,
  windowMs: ANONYMOUS_TURN_WINDOW_MS
}

/**
 * Turns ALL signed-out visitors together may start per day.
 *
 * The per-address bucket alone is not a cost cap: an IPv6 visitor holds a
 * whole /64 and a pool of IPv4 proxies is cheap, so a caller who rotates
 * addresses gets a fresh twenty each time. This second bucket
 * (`ANONYMOUS_ALL_KEY`) is spent beside the per-address one on every
 * anonymous turn and bounds what exploring can cost the deployment in a day
 * no matter how many addresses ask. Three hundred is fifteen full visitors'
 * worth, or about a dollar at the alpha's rate card.
 */
export const ANONYMOUS_ALL_TURN_MAX = 300

/**
 * The deployment-wide anonymous bucket. `all` is never a hex digest, so it
 * cannot collide with a per-address key.
 */
export const ANONYMOUS_ALL_KEY = "anonymous:all"

export const ANONYMOUS_ALL_CEILING: TurnCeiling = {
  kind: "anonymous-all",
  max: ANONYMOUS_ALL_TURN_MAX,
  windowMs: ANONYMOUS_TURN_WINDOW_MS
}

/**
 * Turn erasures one address may request per hour. Erasure needs no session,
 * and an unseen leg is fenced with a new tombstone object, so this bucket is
 * what bounds the objects a caller can create. The browser outbox sends at
 * most 32 per pass and keeps any refused obligation for its next pass.
 */
export const ERASE_CEILING: TurnCeiling = { kind: "erase", max: 600, windowMs: TURN_WINDOW_MS }

/** The erasure bucket: the anonymous address digest under its own prefix. */
export const eraseTurnKey = (request: Request, salt: string | undefined): Effect.Effect<string> =>
  Effect.map(anonymousTurnKey(request, salt), key => `erase:${key}`)

interface TurnLimitWindow {
  /** When the current window opened. */
  readonly start: number
  /** Turns admitted since it opened. */
  readonly count: number
}

const WINDOW_KEY = "window"

/**
 * What a spend check answered. `retryAt` is set only when refused.
 * `unavailable` marks a refusal because the bucket's object could not answer,
 * not because the bucket is spent.
 */
export interface TurnBudget {
  readonly allowed: boolean
  readonly remaining: number
  readonly retryAt?: number
  readonly unavailable?: true
}

/** A positive integer ceiling parameter, or the default when absent or malformed. */
const ceilingParam = (url: URL, name: string, fallback: number): number => {
  const value = Number(url.searchParams.get(name))
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const answer = (body: TurnBudget): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

/* ------------------------------------------------------------------------ */
/* The Durable Object                                                        */
/* ------------------------------------------------------------------------ */

/**
 * One bucket's request: `POST /spend?max=&windowMs=` admits or refuses a
 * turn. The caller names the ceiling
 * with each request; the login ceiling is the default so an unadorned call
 * keeps its old meaning. One bucket only ever sees one ceiling, because the
 * key already says whose it is. A storage failure is the object's own 500.
 */
export const turnRateLimiterRequest = (request: Request): Effect.Effect<Response, never, DurableStorage> =>
  Effect.gen(function*() {
    const storage = yield* DurableStorage
    const now = yield* Clock.currentTimeMillis
    const url = new URL(request.url)
    if (url.pathname !== "/spend") return new Response("not found", { status: 404 })
    const max = ceilingParam(url, "max", TURN_WINDOW_MAX)
    const windowMs = ceilingParam(url, "windowMs", TURN_WINDOW_MS)
    const stored = yield* storage.get<TurnLimitWindow>(WINDOW_KEY)
    const open = stored !== undefined && now - stored.start < windowMs ? stored : { start: now, count: 0 }
    if (open.count >= max) {
      // Refused turns do not extend the window: a client that keeps
      // hammering cannot push its own reset further away.
      return answer({ allowed: false, remaining: 0, retryAt: open.start + windowMs })
    }
    const next = { start: open.start, count: open.count + 1 }
    yield* storage.put(WINDOW_KEY, next)
    return answer({ allowed: true, remaining: max - next.count })
  }).pipe(
    Effect.catchTag(
      "StorageFailure",
      (failure) =>
        Effect.succeed(
          Response.json({ status: "error", code: "storage_failed" satisfies WorkerFailureCode, message: failure.message }, {
            status: 500
          })
        )
    )
  )

/**
 * A spend reads the window and writes it back. The object's requests run one
 * at a time, so a burst can never read the same count twice and admit past
 * the ceiling.
 */
export class TurnRateLimiter {
  private readonly spends = Semaphore.makeUnsafe(1)
  constructor(private readonly ctx: { readonly storage: NativeStorage }) {}

  fetch(request: Request): Promise<Response> {
    return runDurable(this.spends.withPermit(turnRateLimiterRequest(request)).pipe(Effect.provide(storageLayer(this.ctx.storage))))
  }
}

/* ------------------------------------------------------------------------ */
/* The Worker-side service                                                   */
/* ------------------------------------------------------------------------ */

export interface TurnLimitsShape {
  /** Spend one turn from `key`'s budget under `ceiling` (the login ceiling by default). */
  readonly spend: (key: string, ceiling?: TurnCeiling) => Effect.Effect<TurnBudget>
}

export class TurnLimits extends Context.Service<TurnLimits, TurnLimitsShape>()("smithers-server/TurnLimits") {}

const isBudget = (value: unknown): value is TurnBudget =>
  typeof value === "object" && value !== null &&
  typeof (value as { allowed?: unknown }).allowed === "boolean" &&
  typeof (value as { remaining?: unknown }).remaining === "number"

/**
 * The ceiling over the TURN_LIMITS namespace.
 *
 * Fails OPEN when no namespace is bound. A deployment without the binding is
 * local dev or a stub stack, where there is no real model credential to
 * protect; refusing every turn there would break the e2e suites to guard
 * nothing. The binding is declared in `wrangler.jsonc`, so the deployed Worker
 * always has it.
 *
 * When a bound object cannot be reached or answers something unreadable, a
 * signed-in ceiling (hourly, daily, or global) or an erasure's ceiling admits:
 * our own infrastructure hiccuping must never lock a person out. Signed-in
 * limits deliberately fail open to keep Chat usable; credit metering (#1759)
 * bounds spend during an outage (#1912). The anonymous and recommend ceilings are COST
 * caps on the deployment's credentials, so they refuse as `unavailable`
 * instead: a flood that knocks the shared bucket over must not lift the cap.
 */
const COST_CEILINGS: ReadonlySet<TurnCeiling["kind"]> = new Set(["anonymous", "anonymous-all", "recommend"])

const UNAVAILABLE: TurnBudget = { allowed: false, remaining: 0, unavailable: true }

export const turnLimitsLayer = (namespace: NativeNamespace | undefined): Layer.Layer<TurnLimits> => {
  const spend = Effect.fn("TurnLimits.spend")(function*(key: string, ceiling: TurnCeiling = LOGIN_CEILING) {
    const open: TurnBudget = { allowed: true, remaining: ceiling.max }
    if (namespace === undefined) return open
    const budget = yield* namespaceCall(
      "turnLimits.spend",
      namespace,
      key,
      new Request(`https://turn-limit.internal/spend?max=${ceiling.max}&windowMs=${ceiling.windowMs}`, { method: "POST" })
    ).pipe(
      Effect.flatMap((response) => answeredJson("turnLimits.spend", "The turn limiter", response)),
      Effect.catch((failure) =>
        Effect.sync(() => {
          // A rejected fetch, a refusal, or an unreadable answer is an
          // infrastructure fault, not a signal about this user: log the
          // cause (a refusal names its status and body).
          console.error("turn-limit spend failed:", failure.cause)
          return undefined
        }))
    )
    if (isBudget(budget)) return budget
    return COST_CEILINGS.has(ceiling.kind) ? UNAVAILABLE : open
  })
  return Layer.succeed(TurnLimits, { spend })
}

/* ------------------------------------------------------------------------ */
/* The anonymous bucket                                                      */
/* ------------------------------------------------------------------------ */

/**
 * The part of a client address that names its bucket. An IPv4 address is
 * its own bucket. An IPv6 visitor normally holds a whole /64, so the bucket
 * is the /64 prefix: the first four hextets, expanded so `2001:db8::1` and
 * `2001:0db8:0:0::2` land in the same bucket. Anything unparseable is
 * bucketed as written rather than refused.
 */
export const anonymousBucketAddress = (ip: string): string => {
  const address = ip.trim().toLowerCase()
  if (!address.includes(":")) return address
  // An IPv4-mapped address (`::ffff:198.51.100.9`) is an IPv4 visitor.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped !== null) return mapped[1]!
  const [head = "", tail = ""] = address.split("::", 2)
  const heads = head === "" ? [] : head.split(":")
  const tails = tail === "" ? [] : tail.split(":")
  const hextets = [...heads, ...Array(Math.max(0, 8 - heads.length - tails.length)).fill("0"), ...tails]
  return `${hextets.slice(0, 4).map((hextet) => hextet.replace(/^0+(?=.)/, "")).join(":")}::/64`
}

/** SHA-256 of `text` as lowercase hex. WebCrypto refusing SHA-256 is a defect, not a route outcome. */
export const sha256Hex = (text: string): Effect.Effect<string> =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    catch: (cause) => new CryptoFailure({ operation: "digest SHA-256", cause })
  }).pipe(
    Effect.map((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")),
    Effect.orDie
  )

/**
 * The bucket an anonymous turn spends from: a salted SHA-256 of the client
 * address Cloudflare reports (`anonymousBucketAddress`, so one IPv6 /64 is
 * one bucket). The `anonymous:` prefix can never collide with a GitHub
 * login, so a visitor's bucket is never a user's. `salt` is the
 * deployment's ANONYMOUS_TURN_SALT secret; without one the hash is still
 * not an address, only linkable across deployments that also have none.
 */
export const anonymousTurnKey = (request: Request, salt: string | undefined): Effect.Effect<string> => {
  const ip = anonymousBucketAddress(request.headers.get("cf-connecting-ip") ?? "")
  return Effect.map(sha256Hex(`${salt ?? ""}\n${ip}`), (digest) => `anonymous:${digest}`)
}

/* ------------------------------------------------------------------------ */
/* The refusal                                                               */
/* ------------------------------------------------------------------------ */

const waitLabel = (seconds: number): string =>
  seconds >= 2 * 60 * 60 ? `${Math.ceil(seconds / 3600)} hours` : `${Math.ceil(seconds / 60)} minutes`

/**
 * The refusal a spent budget answers with. For a login: a bug report, never a
 * sales pitch. For a visitor: the end of exploring, and the one way on. For
 * a visitor refused by the deployment-wide bucket: the same way on, and that
 * they did nothing wrong. A cost ceiling whose object could not answer is an
 * infra 503 that blames Smithers, never the caller's own limit.
 */
export const turnLimitResponse = (
  budget: TurnBudget,
  isolationHeaders: Record<string, string>,
  ceiling: TurnCeiling = LOGIN_CEILING
): Response => {
  if (budget.unavailable === true) {
    return new Response(
      JSON.stringify({
        status: "error",
        code: "service_temporarily_unavailable" satisfies WorkerFailureCode,
        message: ceiling.kind === "recommend"
          ? "Command suggestions are paused while Smithers recovers. Not your fault. Chat keeps working. Nothing was charged."
          : "Exploring without signing in is paused while Smithers recovers. Not your fault. Sign in with GitHub to keep going. Nothing was charged."
      }),
      {
        status: WORKER_FAILURES.service_temporarily_unavailable.status,
        headers: { "content-type": "application/json", ...isolationHeaders }
      }
    )
  }
  const retryAt = budget.retryAt ?? Date.now() + ceiling.windowMs
  const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))
  return new Response(
    JSON.stringify({
      status: "error",
      code: "turn_rate_limited" satisfies WorkerFailureCode,
      message: ceiling.kind === "erase"
        ? `Saved turn cleanup resumes in about ${waitLabel(seconds)}.`
        : ceiling.kind === "recommend"
        ? `Command suggestions have reached their daily limit. Chat keeps working; suggestions come back in about ${
          waitLabel(seconds)
        }. Nothing was charged.`
        : ceiling.kind === "anonymous"
        ? `That is ${ceiling.max} turns today without signing in, which is as far as exploring goes. Sign in with GitHub to keep going, or come back in about ${
          waitLabel(seconds)
        }. Nothing was charged.`
        : ceiling.kind === "anonymous-all"
        ? `Exploring without signing in has reached its daily limit for everyone, not just you. Sign in with GitHub to keep going, or come back in about ${
          waitLabel(seconds)
        }. Nothing was charged.`
        : ceiling.kind === "login-daily"
        ? `Chat's daily limit of ${ceiling.max} model calls has been reached. Try again in about ${waitLabel(seconds)}. Nothing was charged.`
        : ceiling.kind === "login-all"
        ? `Chat has reached its daily limit for everyone. Try again in about ${waitLabel(seconds)}. Nothing was charged.`
        : `That is more than ${ceiling.max} model calls in an hour, which no conversation reaches by hand — something is looping. Chat resumes on its own in about ${
          waitLabel(seconds)
        }. Nothing was charged and your balance is untouched.`,
      retryAt: new Date(retryAt).toISOString()
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(seconds),
        ...isolationHeaders
      }
    }
  )
}
