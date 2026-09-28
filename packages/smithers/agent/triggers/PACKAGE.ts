import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  testProgram: Smithers.file("//packages/smithers/flows/database/scripts/test-matrix.mjs"),
  deps: [],
  tests: Smithers.glob("test/**/*.ts"),
  cwd: "packages/smithers/agent/triggers"
})

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/agent/triggers",
  include: ["src/**"],
  checks: [
    {
      id: "webhook-signature-verification",
      title: "Every webhook request is authenticated over its raw bytes before any decode or dispatch",
      threat:
        "An unauthenticated internet sender starts flows or signals runs on the host by forging or omitting the webhook signature.",
      lookFor: [
        "A path in makeSignatureVerifier that returns Effect.void when the header is absent, empty, or the expected signature has zero bytes.",
        "A comparison of signature bytes that exits early or loops over the supplied length instead of constantTimeEqual over the expected length.",
        "A verifier or ingest path that reads raw.body or headers after the snapshot is taken, so verified and decoded bytes can differ.",
        "Webhook.ingest reaching Channels.ingest without verify running first, or self-registering an unregistered channel."
      ],
      paths: ["src/Webhook.ts", "src/Channel.ts"]
    },
    {
      id: "webhook-refusal-leak",
      title: "Webhook refusals reveal nothing about the credential or resolver to the sender",
      threat:
        "An unauthenticated sender learns credential reference names, resolver errors, or signature lengths from refusal messages or timing.",
      lookFor: [
        "A refusal message that forwards a custom verify or expected() error text instead of the fixed 'did not verify' message.",
        "An Unauthorized or TriggerError returned to the caller whose message or cause includes the CredentialRef or the resolved secret."
      ],
      paths: ["src/Webhook.ts", "src/TriggerError.ts"]
    },
    {
      id: "channel-no-authority",
      title: "A channel's inbound mapping can only request a start or a signal, never grants or an execution envelope",
      threat:
        "A verified webhook sender escalates a start into a run with extra capabilities or signals a run and step that the channel author never intended.",
      lookFor: [
        "Inbound or Start/Signal shapes, or the map in toControlChannel, carrying capabilities, envelope, grants, or approval fields into Control.",
        "Signal payload values forwarded to Control without Schema.Json decoding."
      ],
      paths: ["src/Webhook.ts", "src/Channel.ts"]
    },
    {
      id: "scheduler-no-self-approval",
      title: "Scheduled launches never approve their own parked plans or build their own envelope",
      threat: "Whoever registers a trigger runs a flow that requires human approval without that approval.",
      lookFor: [
        "layerControlRunner or runApprovedPlan calling an approve operation, or constructing an envelope other than plan.envelope from control.plan.",
        "An unbounded retry of a parked plan instead of the parkedAttempts limit."
      ],
      paths: ["src/Scheduler.ts"]
    },
    {
      id: "trigger-sql-parameterized",
      title: "Every trigger store query binds values as parameters",
      threat:
        "A trigger author or webhook-derived id injects SQL that reads or rewrites other triggers' rows or fire ledgers.",
      lookFor: [
        "sql.unsafe, sql.literal, or string concatenation building SQL from trigger ids, flow ids, cron text, run ids, or error text.",
        "Dialect-specific fragments interpolated from anything other than a fixed internal choice."
      ],
      paths: ["src/SqlTriggerStore.ts", "src/migrations/**"]
    },
    {
      id: "trigger-row-decode",
      title: "Stored trigger rows are decoded through a schema before use",
      threat:
        "Anyone able to write the triggers table makes the scheduler launch arbitrary flow input or crash every listing with one corrupt row.",
      lookFor: [
        "JSON.parse of input_json or a cast of an overlap/catch_up column that is not followed by schema validation.",
        "A decode failure that fails the whole listing or scheduler loop instead of the single row."
      ],
      paths: ["src/SqlTriggerStore.ts", "src/TriggerStore.ts", "src/Trigger.ts"]
    },
    {
      id: "schedule-resource-bounds",
      title: "Cron and catch-up work is bounded regardless of the declared expression",
      threat:
        "A trigger author exhausts scheduler CPU and memory for every tenant with a dense or unsatisfiable cron or a huge catch-up window.",
      lookFor: [
        "An occurrence search in Cron.ts, CatchUp.ts, DueOccurrences.ts, or DispatchReader.ts that runs without the maxOccurrences or maxCatchUp cap.",
        "An unsatisfiable cron that throws a defect instead of unsatisfiable_cron.",
        "A fires page size or cursor from Control that is not range-checked before the store read."
      ],
      paths: ["src/Cron.ts", "src/CatchUp.ts", "src/internal/**", "src/DispatchReader.ts"]
    },
    {
      id: "fire-claim-exactly-once",
      title: "One occurrence launches at most one run across racing schedulers",
      threat:
        "Two scheduler processes double-launch a flow occurrence, duplicating side effects such as payments or deploys.",
      lookFor: [
        "A claim path in SqlTriggerStore.ts or ClaimDecision.ts whose UPDATE lacks the active_run_id or reservation guard, or ignores affectedRows.",
        "An idempotency key for Control that is not derived from trigger id and occurrence."
      ],
      paths: ["src/SqlTriggerStore.ts", "src/ClaimDecision.ts", "src/Scheduler.ts", "src/Overlap.ts"]
    },
    {
      id: "cancel-own-runs-only",
      title: "The scheduler cancels only runs its own trigger launched",
      threat:
        "A trigger's cancel overlap policy or losing-reservation cleanup cancels another user's unrelated run through Control.",
      lookFor: [
        "A runner.cancel call in cancelActive or the stale_owner path whose run id is not the trigger's own recorded active_run_id or launch result.",
        "A run id read from the store or a fire record passed to cancel without checking it belongs to that trigger id.",
        "A reservation id (isReservation) passed to Control.cancel as if it were a run id."
      ],
      paths: ["src/Scheduler.ts", "src/internal/ActiveRuns.ts", "src/SqlTriggerStore.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
