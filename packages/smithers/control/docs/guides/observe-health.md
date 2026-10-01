# Configure observational health

`Health` separates authoritative lifecycle from observed activity, derived health,
human attention, and reading freshness. A live process is not proof of semantic
work, and an approval wait always remains an approval wait.

Register trusted TypeScript checkers through the native CLI's
`Application.Config.health`, binding checker IDs to flow IDs. The desktop local
server accepts the same configuration for role and harness IDs. Pure flow bodies
and browser requests do not contain executable health functions.

```ts
import * as Health from "@smthrs/control/Health"
import { Effect, Schema } from "effect"

const Settings = Schema.Struct({ worker: Schema.String })
declare const inspectWorker: (id: string) => Effect.Effect<Health.ProbeReport, unknown>

const checker: Health.HealthChecker<typeof Settings.Type> = {
  id: "worker.activity",
  configSchema: Settings,
  probe: (_context, config) => inspectWorker(config.worker)
}

const health: Health.HealthConfig = {
  checkers: [checker],
  bindings: {
    "build/review": {
      checkerId: "worker.activity",
      config: { worker: "reviewer" },
      policy: { intervalMs: 5_000, timeoutMs: 2_000, ttlMs: 20_000, stallAfterMs: 120_000 }
    }
  },
  limits: { maxSubjects: 128, maxConcurrentProbes: 8 }
}
```

Reports contain `activity` (`working`, `idle`, `needs-input`, or `unknown`) and an
optional closed reason code. Silence and changing terminal output do not establish
any of these semantics. The lifecycle defaults return unknown activity. Explicit
`no-progress` or `unreachable` reasons may mark health unhealthy. Known engine
timer, event, quota, and approval waits retain their authoritative meaning.

A run parked on `released` reports `health: "awaiting-human"`,
`attention: "needs-resume"`, and reason `released`, whatever a probe says. Its
owner released executions while still alive, usually because the run lease
lapsed on a stalled host, and nothing restarts them until an operator runs
`smthrs runs resume <run>`.

## Detect a session waiting on a person

`jev.session` is registered in every host, so a binding is the whole opt-in. It is
registration, not a binding: a host that never names it keeps the lifecycle
default it had.

```ts
import * as Health from "@smthrs/control/Health"

const health: Health.HealthConfig = {
  bindings: { terminal: { checkerId: "jev.session", exposeOutput: true } }
}
```

The desktop local server writes that binding itself: with a subscription evaluator configured
in its process it binds `jev.session` with `exposeOutput: true` for every session
subject it resolves, so a session's output tail is sent to the gateway with zero
data retention; without the key its configuration is exactly what a caller passed,
and a subject a caller bound keeps that caller's checker. The native CLI host
observes runs rather than sessions, so it never binds this checker.

The checker sends the session's `alive`, `exitCode`, and the newest 4 KiB of its
output to Jev, TypeSafe's decision model, through the Vercel AI Gateway, with zero
data retention. Jev answers one choice question (`working`, `idle`, `needs-input`)
and one boolean question about whether the output ends waiting for a person, both
in one request that returns in about 300 ms. `exposeOutput: true` is required:
without it the host sends no tail and the probe answers unknown.

An answer becomes a report only at confidence 0.7 or above. TypeSafe claims 76%
agreement with a human rater, so a Jev that is merely leaning is a coin flip
dressed as a reading: a false `needs-input` pages a person who is not needed, and
a false `idle` retires an agent that is still working. `needs-input` carries the
reason `prompt-detected`, which the rollup turns into `attention: "needs-input"`.
A reading below the floor is Jev's own answer and stays `unknown`.

## When Jev cannot answer

A host that binds `jev.session` supplies its existing evaluator through
`Health.makeRegistry(config, kind, evaluator)` or
`JevSessionChecker.makeJevSessionChecker({ evaluator })`. Native hosts resolve
that judge from their subscription seats. No separate gateway credential is
read. Without a judge the probe fails with `unconfigured` and remains
`probe-error`.

An unavailable subscription, a plan refusal, a rate limit, a dead socket, an unreadable body and
the call's own 45 s deadline fail the probe the same way, with the reason that
names the fault: `http` carrying the provider's status, `unreachable`, `timeout`,
or `malformed`. `Health.evaluate` records any failing probe as `outcome: "error"`
with reason `probe-error` and no report, so the rollup reads the subject `stale`
with activity `unknown`, health `unknown`, and reason `probe-error`, and the
binding's `backoff` spaces the retries from five up to sixty seconds. A monitor
that cannot see is worse when it looks calm, so it says so.

Two cases are not Jev failing and keep the lifecycle answer: a session that is no
longer alive, and a session whose output tail the host did not expose. There is
nothing to ask about either one.

The native host admits at most 128 subjects and eight simultaneous probes by
default. It scans every five seconds, checks each subject every five seconds,
times out a probe after two seconds, expires observations after twenty seconds,
and allows two minutes of missing flow progress before classifying it as stalled.
Failure backoff starts at five seconds and caps at sixty seconds. Per-binding
policies and host limits are validated before monitoring starts. Unknown checker
IDs use the lifecycle fallback; malformed configured policies or checker-specific
configuration fail startup.

The host stamps ownership, lifecycle, timing, and evidence position. Reports from
a changed owner are discarded. A successful observation is recorded under
`control.status.observed` before publication. Equal evidence positions are ordered
by durable journal sequence, never by comparing opaque owner identities. Unchanged
observations are coalesced and renewed before expiry. The gateway's existing
run-summary projection carries `statusRollup`, and clients expire its semantic
activity independently if the host stops answering.

Native flow monitoring reads events incrementally; the callback receives at most
256 recent execution events per beat. Observer/notification bookkeeping does not
count as progress. Derived gateway projections retain bounded recent health
observations while preserving their original journal cursor, so repeated probes
do not exhaust the projection's event budget. Raw run-event history keeps its
existing resource limits and durable journal retention remains the host's policy.

`Health.evaluate` is transport-neutral for other trusted hosts. It returns a
validated observation as an Effect; the host checks ownership again, commits it,
and passes `{ observation, sequence }` to `Health.rollup`. `Health.makeRegistry`
and `registry.resolve(key)` are synchronous constructors. Callback Effects must
have their service requirements provided before registration.

These callbacks are trusted host code, not sandboxed plugins. Read-only context
types do not constrain captured ambient authority, and cooperative Effect
interruption cannot preempt arbitrary synchronous JavaScript. Status output omits
raw exceptions, terminal contents, and arbitrary metrics. Probe outcomes and
latency are measured by `smithers.health.probes` and
`smithers.health.probe_duration_ms`; the probe span is `smithers.health.probe`.

Checker output never authorizes a control mutation. Production observation starts
with `autoHeal: []`. Existing Alerts policies can consume recorded status fields
with an explicitly configured real sink; a status observation alone does not
claim notification delivery.
