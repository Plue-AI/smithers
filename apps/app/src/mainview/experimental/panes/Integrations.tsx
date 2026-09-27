/*
 * Mock: Integrations. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.integrations`. Self-contained on purpose — see ../Pane.ts.
 *
 * A provider is a typed client plus a door, and the door is the interesting
 * half: the HMAC over the exact delivered bytes, the cursor that decides what
 * a poll replays, and the closed set of codes an adapter may raise. Fields
 * belong to `core/Signature`, `core/ExternalEvent`, `core/IntegrationError`,
 * `core/CursorStore`, `linear/Webhook`, `telegram/Source`, the
 * `smithers_integration_cursors` table, and `@smthrs/errors`.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Bars, Code, Facts, Rail, Section, Split, Steps, Table } from "../Primitives"

const PROVIDERS = [
  { id: "linear", label: "linear", note: "refused", tone: "bad" as const },
  { id: "telegram", label: "telegram", note: "offset 918 447 210", tone: "info" as const }
]

const DOORS = [
  {
    id: "linear",
    header: "linear-signature",
    prefix: "—",
    digest: "b41e0c9d…77af",
    bytes: "2 048",
    verdict: "invalid-signature",
    tone: "bad" as const,
    source_id: "linear",
    cursor: "2026-09-18T14:12:07.412Z",
    updated_at_ms: "14:12:08Z",
    raw: `POST /hooks/linear
linear-signature: b41e0c9d…77af
linear-delivery: 5a91c7d2-2f10-49c8-b0aa-c2f9e4d8a013
content-length: 2048

{ "webhookTimestamp": 1758201127412, "type": "Issue", "action": "update" }`,
    steps: [
      { id: "s1", label: "verifySignature", note: "HMAC-SHA256 over raw body", tone: "ok" as const },
      { id: "s2", label: "webhookTimestamp", note: "skew 4 052 s > 60 s", tone: "bad" as const },
      { id: "s3", label: "ExternalEvent.decode", note: "not reached", tone: "muted" as const }
    ],
    event: {
      source: "linear",
      eventName: "integration:linear:issue.update",
      correlationId: "issue:ENG-1194",
      dedupeKey: "5a91c7d2-2f10-49c8-b0aa-c2f9e4d8a013#integration:linear:issue.update#issue:ENG-1194",
      receivedAtMs: "—",
      idempotencyKey: "linear:5a91c7d2-2f10-49c8-b0aa-c2f9e4d8a013"
    }
  },
  {
    id: "telegram",
    header: "—",
    prefix: "—",
    digest: "getUpdates(offset)",
    bytes: "—",
    verdict: "polled",
    tone: "info" as const,
    source_id: "telegram",
    cursor: "918447210",
    updated_at_ms: "14:34:51Z",
    raw: `GET /bot<redacted>/getUpdates?offset=918447210&timeout=25

{ "ok": true, "result": [ { "update_id": 918447210, "message": { … } } ] }`,
    steps: [
      { id: "s1", label: "CursorStore.get", note: "918447210", tone: "ok" as const },
      { id: "s2", label: "poll", note: "1 update", tone: "ok" as const },
      { id: "s3", label: "onBatch", note: "handled", tone: "ok" as const },
      { id: "s4", label: "CursorStore.set", note: "918447211 after the batch", tone: "ok" as const }
    ],
    event: {
      source: "telegram",
      eventName: "integration:telegram:message",
      correlationId: "chat:-1001883042117",
      dedupeKey: "telegram:918447210:message",
      receivedAtMs: "14:34:51Z",
      idempotencyKey: "telegram:918447210:message"
    }
  }
]

const CODES = [
  { id: "INVALID_INPUT", details: "{ field } · { maxLength } · { maxAgeSeconds }", raised: 3 },
  { id: "INTEGRATION_ERROR", details: "{ reason, …providerSafeDetails }", raised: 41 },
  { id: "TELEGRAM_API_ERROR", details: "{ method, errorCode, retryAfterSeconds }", raised: 6 },
  { id: "TELEGRAM_INIT_DATA_INVALID", details: "{ authDate }", raised: 1 },
  { id: "UNSUPPORTED", details: "—", raised: 0 }
]

const REASONS = [
  { label: "invalid-signature", value: 18, display: "18", tone: "bad" as const },
  { label: "poll-failed", value: 9, display: "9", tone: "warn" as const },
  { label: "permission-denied", value: 7, display: "7", tone: "warn" as const },
  { label: "decode-failed", value: 4, display: "4", tone: "warn" as const },
  { label: "delivery-failed", value: 2, display: "2", tone: "muted" as const },
  { label: "credentials-missing", value: 1, display: "1", tone: "muted" as const },
  { label: "invalid-config", value: 0, display: "0", tone: "muted" as const },
  { label: "listener-conflict", value: 0, display: "0", tone: "muted" as const }
]

export const Pane = pane({
  id: "integrations",
  title: "Integrations",
  summary: "Webhook doors, their verification and their cursors",
  packages: ["@smthrs/integrations"],
  render: (context) => <IntegrationsBody {...context} />
})

function IntegrationsBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const provider = typeof props.provider === "string" ? props.provider : "linear"
  const door = DOORS.find((row) => row.id === provider) ?? DOORS[0]!
  return (
    <Split
      left={
        <>
          <Section title="Providers"><Rail items={PROVIDERS} selected={provider} onSelect={(id) => runCommandSet("provider", id)} /></Section>
          <Section title="smithers_integration_cursors">
            <Facts rows={[
              { label: "source_id", value: door.source_id, mono: true },
              { label: "cursor", value: door.cursor, mono: true },
              { label: "updated_at_ms", value: door.updated_at_ms, mono: true },
              { label: "committed", value: "after onBatch" }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Delivery" right={<Badge tone={door.tone}>{door.verdict}</Badge>}>
            <Code>{door.raw}</Code>
            <Facts rows={[
              { label: "header", value: door.header, mono: true },
              { label: "prefix", value: door.prefix, mono: true },
              { label: "signed bytes", value: door.bytes, mono: true },
              { label: "digest", value: door.digest, mono: true },
              { label: "idempotencyKey", value: door.event.idempotencyKey, mono: true }
            ]} />
          </Section>
          <Section title="Door"><Steps steps={door.steps} /></Section>
          <Section title="ExternalEvent">
            <Facts rows={[
              { label: "source", value: door.event.source, mono: true },
              { label: "eventName", value: door.event.eventName, mono: true },
              { label: "correlationId", value: door.event.correlationId, mono: true },
              { label: "dedupeKey", value: door.event.dedupeKey, mono: true },
              { label: "receivedAtMs", value: door.event.receivedAtMs, mono: true }
            ]} />
          </Section>
          <Section title="SmithersError" right="5 codes">
            <Table
              columns={[
                { key: "id", label: "code", mono: true },
                { key: "details", label: "details", mono: true },
                { key: "raised", label: "raised", right: true }
              ]}
              rows={CODES}
            />
          </Section>
          <Section title="IntegrationError.reason"><Bars rows={REASONS} /></Section>
        </>
      }
    />
  )
}
