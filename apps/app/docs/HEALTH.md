# Agent and flow health

The app shows execution state, semantic activity, health, attention, and the
freshness of the observation together. A live terminal process can have unknown
activity. Silence and terminal output are not evidence that an agent is idle,
working, or waiting for input.

The workflow Control service owns run state and approval decisions. The local
daemon owns terminal lifecycle. Health checks observe those subjects and cannot
declare them completed, approve a request, or resume them.

## Configure a TypeScript host

`@smthrs/control/Health` exports the shared Effect API. Register a checker and
bind its ID to a flow ID in `Application.Config.health`, or to a role/harness ID
in the local server's `LocalServerOptions.health`. A plain terminal uses the
binding key `terminal`. Callbacks execute in the host that owns the subject;
remote clients do not execute the gateway's checks locally.

```ts
import * as Health from "@smthrs/control/Health"
import { Effect, Schema } from "effect"

const Settings = Schema.Struct({ worker: Schema.String })

// The application's worker supplies this Effect from its actual protocol or
// durable state. No terminal-text heuristic or timer determines the answer.
declare const readWorkerActivity: (
  worker: string
) => Effect.Effect<Health.ProbeReport, unknown>

const checker: Health.HealthChecker<typeof Settings.Type> = {
  id: "worker.activity",
  configSchema: Settings,
  probe: (_subject, config) => readWorkerActivity(config.worker)
}

const health: Health.HealthConfig = {
  checkers: [checker],
  bindings: {
    "my-flow-or-agent-role": {
      checkerId: "worker.activity",
      config: { worker: "build-worker" },
      policy: { intervalMs: 2_000, timeoutMs: 1_000, ttlMs: 8_000, stallAfterMs: 120_000 }
    }
  },
  limits: { maxSubjects: 64, maxConcurrentProbes: 4 }
}
```

The report contains `activity: "working" | "idle" | "needs-input" | "unknown"`
and an optional closed reason code. For example, a worker's real human-input
request can return `{ activity: "needs-input", reason: "awaiting-reply" }`.
`idle` alone does not mean the user owes input. Reasons such as `unreachable`
can mark an observation unhealthy. Run health also uses the runtime's durable
progress and failure evidence.

Production flow monitors allow two minutes without progress by default before
classifying a stall. Configure `stallAfterMs` per binding for the work's expected
latency. A known timer, event, quota, or approval wait remains a wait; it does
not become stalled simply because it is quiet.

Checks may use Effect services; provide their requirements before registration.
The host validates configuration and reports, controls deadlines, bounds
concurrency, and backs off failed probes. Unknown checker IDs use the lifecycle
fallback, which reports unknown activity. Invalid configured policies or config
fail host startup with a safe configuration error.

This is trusted host TypeScript, at the same trust level as the application.
The read-only callback context is not a sandbox. Effect interruption cannot
forcibly interrupt arbitrary synchronous JavaScript. The browser never submits
functions and the app does not automatically evaluate repository configuration.
The packaged native app uses its compiled host configuration; this API is not
a browser preference for executing arbitrary TypeScript.

## Local session evidence

Session checks receive process liveness, exit code, and an opaque monotonic
output cursor. They receive neither the PID nor terminal output by default.
A binding can explicitly opt into `exposeOutput: true` for an adapter that
understands a particular harness protocol; the host supplies at most 4 KiB of
plain-text tail. The adapter remains responsible for interpreting that protocol
correctly. Terminal contents and arbitrary exceptions never enter status DTOs.

With `AI_GATEWAY_API_KEY` set in the daemon's process, the host binds the
registered `jev.session` checker with `exposeOutput: true` for every session
subject key it resolves (`terminal`, each harness ID, each agent role ID), so the
session's 4 KiB output tail is sent to the Vercel AI Gateway with zero data
retention and Jev answers whether the agent is working, idle, or waiting on a
person. Without the key nothing is bound and the lifecycle default keeps
answering unknown activity. A binding supplied in `LocalServerOptions.health`
wins for its own subject, and a caller that binds `jev.session` itself must
supply the key.

There is no fallback to another model. Once the checker is bound, a missing key,
a gateway refusal, a timeout, a dead socket, or a body that does not answer the
question fails the probe with a typed `JevProbeError`, which the host records as
`outcome: "error"` with reason `probe-error`. The subject then reads stale with
unknown activity and unknown health rather than healthy, and the binding's
backoff spaces the retries.

The daemon stamps owner incarnation, observation time, expiry, and evidence
cursor. It discards a report if the process changes lifecycle while its check
is running. Observations commit to `local-health.sqlite` using the existing
Smithers SQL journal before they reach HTTP list snapshots (the `pty.status`
frames retired with the terminal tabs, smithersai/smithers#2229). Unchanged observations coalesce until their half-TTL renewal;
the UI keeps the last committed timestamp during that interval. Every 256
local observations the journal checkpoints the latest observation and compacts
the earlier heartbeat payloads. The shared
journal retains deduplication tombstones, so total disk usage still grows; this
is not a hard disk quota or a deletion policy for old sessions. A fresh daemon
does not use old observations to revive a missing process.

## Display and diagnostics

Agent cards, run cards, run-list rows, and process tabs use the same status presentation.
Expired observations lose semantic activity even while the app is disconnected.
Known approval, timer, event, and quota waits retain their authoritative meaning.
An unknown process exit outcome is not displayed as successful completion.

The existing run-summary pump and PTY topic carry the additive status DTO; there
is no extra status RPC or network poll. One controller-owned expiry deadline
updates the persisted projections, including hidden tabs, through system
transitions in the existing client journal. Canonical subjects are `run:<runId>`
and `session:<sessionId>`; the client rejects a status for another subject or a
different authoritative lifecycle. Activity labels distinguish Working, Idle,
Needs input, Activity unknown, and Stale. The existing Open, Steer, and approval
flows remain the keyboard-accessible actions; a health observation cannot invoke
them. Process-tab labels expose the same status as an accessible description.

The browser regression lane can opt into `SMITHERS_E2E_HEALTH=1`, which installs
a test-host-only Effect checker for explicit shell records. The real-terminal
test exercises semantic working/idle/input observations and a nonzero exit
through the actual daemon, journal, authenticated socket, dispatcher and UI.

Flow evidence is recorded as `control.status.observed` and appears through the
existing authenticated run-summary projection. Local observations use that same
event type and schema. Derived gateway projections keep bounded recent health
observations while preserving the source cursor, so heartbeats do not exhaust
their event budget. Raw run-event history retains its existing limits and host
retention policy. `smithers.health.probes` counts outcomes and
`smithers.health.probe_duration_ms` measures probe latency; probe spans are named
`smithers.health.probe`. Fields contain bounded states and reason codes, not
terminal contents, credentials, or raw checker errors.

Health attention does not imply notification delivery. Existing Alerts policies
can consume the evidence with a configured real sink. Native/APNs delivery still
needs the forwarding, inbox/outbox, provider, and device-registration work in the
[Plue approval and notification audit](../../../../plue/docs/research/agent-approvals-notifications-audit.md).

The [Fable design](../../../docs/design/agent-flow-health.md) records the
architecture and reviewed implementation constraints.
