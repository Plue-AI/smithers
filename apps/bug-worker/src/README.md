# @smthrs/bug-worker — src

Cloudflare Worker source for the bug.smithers.sh intake (routes, caps, and
deploy instructions live in `../README.md`).

- `worker.ts` — the entry point and fetch router: permissive CORS,
  `POST /api/bugs` with a 256KB body cap, and admin-only `GET /api/bugs/:id`.
  `createBugWorker(deps)` exists so tests can inject a clock; the default
  export uses `Date.now`.
- `repoRequests.ts`, `repoClaims.ts` — route handlers.
  Only `worker.ts` imports them; they import the leaf modules below and never
  `worker.ts` or each other. `tests/moduleGraph.test.ts` pins this.
- `repoDelivery.ts` — readiness email delivery: `queueDelivery` for routes
  and `sweepDeliveries`, the scheduled sweep that is the only sender, bounded
  by a five-minute budget.
- `sendMail.ts` — one Resend send, typed `rejected` (the recipient's message)
  or `unavailable` (provider, network, or configuration).
- `sha256.ts`, `publicBaseUrl.ts`, `appUrl.ts` — hashing, the Worker's public
  origin, and the allowed app-URL check shared by routes and the sweep.
- `repoForks.ts` — forks a newly nominated repository into the community
  organization and records the outcome.
- `RepoCompletion.ts` — Durable Object that is the only authority for a
  repository's published app URL; KV `repo-ready:` mirrors it.
- `deps.ts` — `BugWorkerDeps`, the clock and fetch every route takes as
  arguments.
- `checkRateLimit.ts` — hourly budget per bucket and the client address it is
  charged to (`cf-connecting-ip`, IPv6 per /64).
- `RateLimiter.ts` — Durable Object holding one bucket's atomic hourly count.
- `durableState.ts` — the transactional storage surface both Durable Objects use.
- `newToken.ts` — 128-bit hex confirmation and cancellation tokens.
- `isOperator.ts` — timing-safe `x-bug-admin` check against `BUG_ADMIN_TOKEN`.
- `readBodyBounded.ts` — streamed body read that aborts once the byte cap is
  exceeded, so a lying content-length can't buffer the platform cap.
- `repoName.ts` — normalizes a GitHub URL or `owner/repo` to a lowercase
  repository root.
- `bugReportSchema.ts` — loose zod schema requiring a non-blank `summary` or
  `title` (1 to 500 characters). Accepts current string and 0.x object platform
  values, preserves unknown fields, and stores either envelope without conversion.
- `newBugId.ts` — sortable ulid-ish id (base32 ms timestamp + 16 random chars).
- `env.ts` — `BugWorkerEnv`/`BugKv` binding interfaces; tests satisfy them with
  `tests/helpers/memoryKv.ts`.

Rate limits are atomic: every bucket is a `RateLimiter` Durable Object, so a
concurrent burst gets exactly the budget.
