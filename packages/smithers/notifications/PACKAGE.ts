import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/notifications"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd
})

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "webhook-credential-containment",
      title: "Webhook sink headers never leave the configured http(s) origin or reach an error, log, or journal",
      threat:
        "A redirecting or hostile pager endpoint, or anyone reading logs and journals, obtains the bearer credential a deployment put in layerWebhook headers.",
      lookFor: [
        "webhookUrl accepting a scheme other than http: or https:, or parsing a url that differs from the one POSTed to.",
        "followingNoRedirects not forcing redirect: \"manual\" on every request, or a caller-supplied RequestInit able to override it.",
        "The sink using an injected HttpClient (for example one wrapped with followRedirects) instead of its own FetchHttpClient.layer.",
        "An AlertError or failed-delivery journal payload that embeds the url, the request, the headers, or the HttpClientError cause instead of only its reason tag.",
        "Caller headers set after Idempotency-Key so a deployment header can replace the dedupe key."
      ],
      paths: ["src/layerWebhook.ts", "src/AlertSink.ts", "src/AlertRuntime.ts"]
    },
    {
      id: "webhook-bounded-delivery",
      title: "A webhook delivery always ends within its timeout and releases the response",
      threat:
        "A slow or never-answering pager endpoint hangs the alert tick forever, so every later alert for every run goes silent.",
      lookFor: [
        "Effect.timeout applied outside Effect.scoped or not at all, so an unread body or a hung request outlives the bound.",
        "A 3xx or other non-2xx status counted as delivered instead of sink_rejected.",
        "A sink failure that escapes the tick as a defect instead of being recorded as flows.alerts.failed."
      ],
      paths: ["src/layerWebhook.ts", "src/AlertRuntime.ts"]
    },
    {
      id: "steer-payload-classification",
      title: "Only payloads that are genuinely steering items reach the model as instructions",
      threat:
        "A webhook or system-event producer whose payload happens to carry a body string gets its text inserted into another run's transcript as an operator message, or widens that run's tool set.",
      lookFor: [
        "SteerPayload.decode classifying a kindless record with extra fields beyond body as a Message.",
        "A ToolsPayload decode that accepts tool names without the consumer checking them against an allow-list.",
        "decode or encode returning a structure that still aliases the caller's arrays or objects.",
        "A SeatPayload that accepts an arbitrary model seat string without any bound or validation at this seam.",
        "decode applied to a system-event or webhook-provenance notification, so a machine producer's {kind: \"Tools\"} or {kind: \"Seat\"} payload changes another run's tools or model."
      ],
      paths: ["src/SteerPayload.ts", "src/Notification.ts"]
    },
    {
      id: "notification-admission-validation",
      title: "admit validates, copies, and bounds every notification before journaling it",
      threat:
        "A producer submitting a deeply nested, cyclic, or oversized payload crashes the notifying process or journals a record every replay skips.",
      lookFor: [
        "tooDeep running after the schema decode or the copy, so a hostile depth overflows the stack first.",
        "copied or freeze recursing without the depth bound on a payload that has not passed tooDeep.",
        "A NotificationError message or path that includes the offending payload value rather than only the issue tag and field path.",
        "No bound on payload byte size or array length before canonicalize and digestSync run."
      ],
      paths: ["src/NotificationQueue.ts", "src/Notification.ts"]
    },
    {
      id: "notification-identity-isolation",
      title: "Journal identities for admissions, drains, and alerts cannot be forged across ids, lineages, or runs",
      threat:
        "A producer choosing a notification id, lineage id, boundary, run id, or condition name containing separators collides with another notification's journal identity and suppresses or replays it.",
      lookFor: [
        "admissionSource, drainSource, or the alert record sourceId joining a caller-chosen component without encoding it.",
        "coalescingKey or drainKey concatenating components without encodeURIComponent.",
        "A duplicate admission accepted when its fingerprint differs from the committed one, or a legacy row without a fingerprint accepted for new content.",
        "drain delivering notifications whose targetLineageId differs from the drain input's lineage."
      ],
      paths: ["src/NotificationQueue.ts", "src/NotificationState.ts", "src/AlertPolicy.ts", "src/AlertRuntime.ts"]
    },
    {
      id: "notification-capacity-enforcement",
      title: "The pending capacity is enforced inside one journal transaction across processes",
      threat:
        "Two processes or a flooding producer admit past capacity, growing a run's pending queue and journal without bound.",
      lookFor: [
        "The capacity check read from a fold outside journal.transact or cached before the transaction's commit.",
        "A fold published to FoldCache before journal.whenCommitted, so a rolled-back admission is later treated as committed.",
        "Coalescing that replaces an event across targetLineageId values or across runs."
      ],
      paths: ["src/NotificationQueue.ts", "src/NotificationState.ts", "src/internal/foldCache.ts"]
    },
    {
      id: "notification-record-forgery",
      title: "Only records the queue itself wrote are replayed as admissions and promotions",
      threat:
        "Code that can append journal entries to a run, such as a flow or agent step, forges a flows/notifications/Admitted record carrying a human-steer, so the model reads attacker text as an operator instruction.",
      lookFor: [
        "NotificationEvent.fromEntry accepting an entry by eventType alone without checking its sourceId is /notifications/admission/ or /notifications/drain/.",
        "The NotificationQueue fold or Projection.derive applying a decoded Admitted record whose decision was never produced by applyAdmission.",
        "A forged Promoted record whose ids remove another lineage's pending notifications, dropping an operator steer."
      ],
      paths: ["src/NotificationEvent.ts", "src/NotificationQueue.ts", "src/Projection.ts", "src/NotificationState.ts"]
    },
    {
      id: "alert-journal-evidence-spoofing",
      title: "Alert conditions and delivery suppression are decided only from records the alerter trusts",
      threat:
        "Code that can append journal entries to a run, such as a flow or agent step, closes a failed or stalled condition or forges a flows.alerts.delivered record, silencing the operator's page.",
      lookFor: [
        "observe or the delivered set trusting any entry with a matching eventType or payload field regardless of its sourceId or writer.",
        "A detector without eventTypes that lets any payload carrying status or health close the condition.",
        "A detector field read through the prototype chain instead of Object.hasOwn.",
        "Policy decoding that admits a NaN, negative, or non-integer afterMs."
      ],
      paths: ["src/AlertPolicy.ts", "src/AlertRuntime.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
