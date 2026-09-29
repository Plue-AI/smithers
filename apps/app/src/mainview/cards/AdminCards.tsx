/*
 * The admin cards: the access-request queue and the service health readout.
 * Both exist once their read has settled, so they wear "done" (§28.3): a read
 * that hung must not look like one that rendered everything.
 */
import { Button, StatusPill } from "@smthrs/ui"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"
import type { Card } from "../state/AppState"
import { dateLabel, dayLabel } from "../Timestamps"
import type { CardFamily } from "./CardFamily"
import { settledPill } from "./CardFamily"

/* A failed approval; the admin route's own words stay behind Details. Approve stays on each row to try again. */
const APPROVE_FAILED: UserFailureCopy = { fault: "infra", sentence: "Smithers could not approve that request. Not your fault.", actions: [] }

/*
 * A health row's detail by status: a passing or unconfigured probe's detail is
 * the diagnostic itself; a failing probe's is error text, behind Details.
 */
const HEALTH_FAILURES: Readonly<Record<Extract<Card, { kind: "admin-health" }>["payload"]["services"][number]["status"], UserFailureCopy | null>> = {
  ok: null,
  unconfigured: null,
  failed: { fault: "infra", sentence: "This service failed its health check. Not your fault.", actions: [] }
}

type HealthStatus = keyof typeof HEALTH_FAILURES

const HealthDetail = ({ name, status, detail }: { readonly name: string; readonly status: HealthStatus; readonly detail: string }) => {
  const copy = HEALTH_FAILURES[status]
  return copy === null ? <> — {detail}</> : (
    <FailureNotice role="status" data-testid={`admin-health-${name}-failure`} failure={describedFailure(`AdminHealth.${status}`, copy, detail)} />
  )
}

const RequestQueueCardBody = ({
  card,
  onQueueApprove
}: {
  readonly card: Extract<Card, { kind: "request-queue" }>
  readonly onQueueApprove: (login: string) => void
}) => {
  const { requests, approving, error } = card.payload
  if (requests.length === 0) {
    return <p className="smithers-card-note">The queue is empty — nobody is waiting.</p>
  }
  return (
    <div className="queue-card">
      <ul className="queue-list">
        {requests.map((entry) => (
          <li key={entry.login} className="queue-row">
            <span className="queue-login">{entry.login}</span>
            {entry.note !== null ? <span className="queue-note">{entry.note}</span> : null}
            <span className="queue-at">{dayLabel(entry.createdAt)}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={approving !== null}
              onClick={() => onQueueApprove(entry.login)}
            >
              {approving === entry.login ? "Approving…" : "Approve"}
            </Button>
          </li>
        ))}
      </ul>
      {error === undefined ? null : (
        <FailureNotice className="sui-approval-error" data-testid="queue-approve-failure"
          failure={describedFailure("AdminApproveFailed", APPROVE_FAILED, error)} />
      )}
    </div>
  )
}

const AdminHealthCardBody = ({ card }: { readonly card: Extract<Card, { kind: "admin-health" }> }) => {
  const { services, queueDepth, charges, checkedAt } = card.payload
  return (
    <div className="admin-health">
      <ul className="admin-health-services">
        {services.map((service) => (
          <li key={service.name} data-status={service.status}>
            <StatusPill
              status={service.status === "ok" ? "done" : service.status === "failed" ? "failed" : "pending"}
            />{" "}
            <strong>{service.name}</strong>
            <HealthDetail name={service.name} status={service.status} detail={service.detail} />
          </li>
        ))}
      </ul>
      <p className="smithers-card-note">
        {queueDepth === null
          ? "Request queue depth: unread."
          : `Request queue: ${queueDepth} waiting.`} {charges === null
          ? "Charges: unread."
          : `Charges: $${charges.lifetimeChargedUsd} across ${charges.chargeCount} turn${
            charges.chargeCount === 1 ? "" : "s"
          }.`} Read at {dateLabel(checkedAt)}.
      </p>
    </div>
  )
}


export const adminCardFamily: CardFamily<"request-queue" | "admin-health"> = {
  "request-queue": {
    render: (card, actions) => <RequestQueueCardBody card={card} onQueueApprove={actions.onQueueApprove} />,
    pill: settledPill
  },
  "admin-health": {
    render: (card) => <AdminHealthCardBody card={card} />,
    pill: settledPill
  }
}
