# bug-worker

Cloudflare Worker behind `https://bug.smithers.sh` that receives bug reports
from `smithers bug` (and anyone else) and stores them in KV.

## The payload

The current and 0.x CLI envelopes are accepted and stored without conversion.
Installed 0.x CLIs still target this endpoint with `title` and an object-valued
`platform`, so the intake retains both forms.

### rc.0, what `smithers bug` posts today

`packages/smithers/src/Command.ts` builds this through `Bug.report`, which scrubs
credentials out of every string, and POSTs it to `Bug.defaultEndpoint`. `runs`
is whatever `Control.list` returned; `digest` appears only when `--run` names a
run.

```jsonc
{
  "summary": "the review step exhausted its correction budget",
  "version": "1.0.0-rc.0",
  "platform": "darwin-arm64",
  "node": "22.19.0",
  "runs": [
    {
      "runId": "run-01JQ…",
      "flowId": "flows/build-and-review",
      // One of the seven rc.0 statuses: accepted, running, parked,
      // waiting-approval, cancelled, completed, failed.
      "status": "failed",
      "createdAt": 1788000000000,
      "updatedAt": 1788000042000
    }
  ],
  "digest": { "runId": "run-01JQ…", "events": [{ "sequence": 3, "kind": "control.run.failed" }] }
}
```

### 0.x, and anything hand-written

```jsonc
{
  "title": "Run run-01JQ… failed: the review step exhausted its correction budget",
  "body": "It failed the same way twice on a clean checkout.",
  "smithersVersion": "0.35.0",
  "platform": { "os": "darwin", "arch": "arm64", "nodeVersion": "v22.19.0" },
  "createdAtMs": 1788000050000,
  "run": { "runId": "r-123", "workflowName": "build-and-review", "status": "failed", "events": [] }
}
```

0.x sent `workflowName` and `workflowPath` instead of `flowId`, a five-status
vocabulary, and events keyed `seq`/`timestampMs`/`type`.

At least one of `summary` or `title` must contain non-whitespace text. Each
headline, when supplied and non-null, must be a string of 1 to 500 characters.
`platform` may be a string or an object with arbitrary fields. Optional fields
may be omitted or null; unknown fields are preserved.

`tests/smithersBugPayload.test.ts` pins both shapes, including a POST/admin-GET
round trip of the 0.x example, and builds current run DTOs through
`@smthrs/control`'s schemas. `tests/bugWorker.test.ts` also round-trips a
title-only report.

## Routes

- `POST /api/bugs` — zod-validated report: a non-blank `summary` or `title` is
  required, every other key is optional, and the object stays loose. 256KB cap
  (stream-counted, so a missing/spoofed content-length can't buffer past the
  cap), rate limits of 20 valid reports/hour per client and 2000/hour across all
  clients; a 400 or 413 never spends the budget. A request carrying the
  `x-bug-admin` token skips both budgets, and an all-clients refusal logs
  `bug_report.global_limit`. Each budget is an atomic
  `RateLimiter` Durable Object counter, so a concurrent burst cannot race past
  it. A client is Cloudflare's `cf-connecting-ip` (`x-forwarded-for` is
  ignored), charged per /64 for IPv6.
  Stores `bug:<id>` and returns `{ id, url }`. No auth: reporting must be
  zero-friction. CORS allows POST from anywhere.
- `GET /api/bugs/:id` — maintainers only; requires the `x-bug-admin` header
  to match the `BUG_ADMIN_TOKEN` binding.
- `GET /healthz`

## Test

```sh
pnpm -C apps/bug-worker test
```

Tests run the real fetch handler against an in-memory KV binding with real
TTL semantics (`tests/helpers/memoryKv.ts`); no route mocking.
`tests/smithersBugPayload.test.ts` is the contract with the CLI's `bug` verb.

## Deploy

Not run by CI. Set `CLOUDFLARE_API_TOKEN`, `ALCHEMY_PASSWORD`,
`BUG_ADMIN_TOKEN` through your usual secret mechanism (a gitignored `.env`,
or the runner's secret store); never type them on the command line, where
shell history keeps them in plaintext. A deploy without one fails rather than
removing the live binding.

The first Alchemy 2 run takes over the Worker and KV namespace Alchemy 1
created. Read the plan, then deploy:

```sh
pnpm -C apps/bug-worker run plan --adopt
pnpm -C apps/bug-worker run deploy --adopt
```

Every later run, from any machine, drops the flag:

```sh
pnpm -C apps/bug-worker run plan
pnpm -C apps/bug-worker run deploy
```

Both run stage `prod` against the account's shared `alchemy-state-store`
Worker. The stack pins the live physical names: Worker
`smithers-bug-worker-smithers-bug-worker-williamcory`, KV namespace
`smithers-bug-worker-bug-reports-williamcory`, and hostnames
`bug.smithers.sh` and `bugs.smithers.sh`. Alchemy detaches any live hostname
the stack does not declare.
