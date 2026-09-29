# Worker errors

Durable Object transport failures use the route's JSON contract:

- Turn-budget checks admit the call with the configured ceiling as remaining
  budget and log the cause. Unreadable responses use the same fallback.
- Turn registration and cancellation return HTTP 502 with `status: "error"`
  and a `message`. A failed registration never starts a model request. A
  failed cancellation does not establish whether the turn is still running.
- Admin client-error reads return HTTP 200 with `status: "ok"`, an empty log,
  and a `note` stating that the log is unavailable. The cause is logged.

The Worker entrypoint catches unexpected route failures, logs the cause, and
return HTTP 500 with `status: "error"`, a generic `message`, and the isolation
headers every JSON answer carries. A client that disconnects interrupts the
route's fiber — its finalizers run, the upstream fetch aborts — and reads
HTTP 499; an interruption is never restated as a 500. The native adapter
(`src/index.ts`, also the deployed entry) goes through `runRequest` and maps
the fiber's exit with `responseFromExit` in `src/Boundary.ts`.
This boundary covers response creation; errors after a streaming response
has been returned remain the stream handler's responsibility.

## Seam failure log

A failure that answers no request writes one JSON line,
`{ "event": "worker_seam_failure", "seam": …, "cause": … }`
(`logSeamFailure` in `src/RefusalLog.ts`), and Workers Logs
(`wrangler.jsonc` `observability`) keeps it: a turn journal or model vault
Durable Object's own storage failure. `cause` holds the failure's tag, its
operation, seam or reason, and its cause's message, cut at 500 characters;
the model vault's causes are fixed words or a tag and never a message.

`UPSTREAM_TIMEOUT_MS` bounds upstream response headers, defaulting to 20,000
milliseconds when unset or invalid. The model turn and stream routes, admin
forwards and health reads, identity, billing and Cloud proxies
share `fetchWithDeadline` in `src/Http.ts`, read through
`ServerConfig.upstreamTimeoutMs` (`src/Config.ts`). The deadline covers
headers only: a streaming body continues past it, and caller cancellation
(fiber interruption) remains effective and aborts the upstream fetch.

Model and admin forward deadlines return HTTP 504 `upstream_timeout` with
`status: "error"` and the fixed `message`
`${seam} took too long to answer. Try again in a moment.`
(`upstreamUnreachable` in `src/Responses.ts`). The effective duration is
operator evidence: the `worker_refusal` log line's `cause` names it
(`UpstreamTimeout` in `src/Failures.ts`). Turn deadlines also settle the
cancellation registry.

A refusal body never carries operator evidence. The app renders `message`
verbatim, so an unset variable name, a native cause, a storage operation or
an upstream's HTTP status goes to the log line through `operatorRefusal`,
`routeRefusal`'s `detail`, `storageRefusal` or `cloudTokenResponse`, and the
body holds one fixed sentence. A Durable Object's own storage failure
answers `storageFailureAnswer`: a `worker_seam_failure` line and the fixed
`storage_failed` sentence.
Client disconnects on model routes remain HTTP 499 (`src/Boundary.ts`).
`/api/workflow/{provision,rpc}` wait `WORKFLOW_UPSTREAM_DEADLINE_MS`
(255,000 ms, `src/workflows.ts`) instead: the backend answers a Plan or Run
only when the box has, and allows it four minutes.

An upstream refusal body is read up to 16 KiB (`REFUSAL_DETAIL_MAX_BYTES`
in `src/Http.ts`). Past that, or when the body breaks off, the read is
cancelled and the route states the refusal without the upstream's detail.
A box answer on `/api/workflow/{provision,rpc}` is read up to 4 MiB
(`WORKFLOW_ANSWER_MAX_BYTES` in `src/workflows.ts`). Past that, the route
answers `upstream_malformed`; a body that breaks off answers
`upstream_unreachable`.

Admin health retains its HTTP 200 partial report: timed-out health checks
have `status: "failed"` and a detail naming the effective deadline. An
unavailable balance or request queue remains `null`.

Turn cancellation registrations carry a unique generation. Internal `/state`,
`/cancel`, and `/settle` calls require `x-turn-generation`; stale or absent
values cannot read or change a replacement registration. The public cancel
route still accepts `{ runId }`: it resolves the owner's current generation
through `/current` before attempting cancellation. A replacement between
those calls returns `not-found` instead of cancelling the replacement.

The terminal frame, headers deadline, disconnect, and stream finalization
share one settlement. Settlement runs under `waitUntil`, including when the
client disconnects; the deployed entry in `src/index.ts` hands the router
the platform execution context from workerd's `ctx`. Settlement failures are logged;
the ten-minute stale registration window remains the recovery backstop.

Turn polling backs off from 500 milliseconds to 5 seconds without resetting
on upstream data. A poll also runs after 256 chunks; monitoring stops after
eight minutes or 600 registry reads. A monitoring failure or
exhausted poll allowance aborts upstream, settles the registration, and emits
a terminal `done` frame with `reason: "stop"` and an explanatory `error`.
Registry read failures and stream cleanup rejections are logged.
