# @smthrs/bug-worker — src

Cloudflare Worker source for the bug.smithers.sh intake (routes, caps, and
deploy instructions live in `../README.md`).

- `worker.ts` — the entry point and fetch router: permissive CORS,
  `POST /api/bugs` with a 256KB body cap, and admin-only `GET /api/bugs/:id`.
  `createBugWorker(deps)` exists so tests can inject a clock; the default
  export uses `Date.now`.
- `publicBaseUrl.ts` — the origin returned in a stored report receipt.
- `deps.ts` — the injected clock.
- `checkRateLimit.ts` — hourly budget per bucket and the client address it is
  charged to (`cf-connecting-ip`, IPv6 per /64).
- `RateLimiter.ts` — Durable Object holding one bucket's atomic hourly count.
- `durableState.ts` — the transactional storage surface the rate-limit Durable Object uses.
- `isOperator.ts` — timing-safe `x-bug-admin` check against `BUG_ADMIN_TOKEN`.
- `readBodyBounded.ts` — streamed body read that aborts once the byte cap is
  exceeded, so a lying content-length can't buffer the platform cap.
- `bugReportSchema.ts` — loose zod schema requiring a non-blank `summary` or
  `title` (1 to 500 characters). Accepts current string and 0.x object platform
  values, preserves unknown fields, and stores either envelope without conversion.
- `newBugId.ts` — sortable ulid-ish id (base32 ms timestamp + 16 random chars).
- `env.ts` — `BugWorkerEnv`/`BugKv` binding interfaces; tests satisfy them with
  `tests/helpers/memoryKv.ts`.

Rate limits are atomic: every bucket is a `RateLimiter` Durable Object, so a
concurrent burst gets exactly the budget.
