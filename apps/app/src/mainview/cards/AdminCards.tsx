/*
 * The admin service health readout. It exists once its read has settled, so
 * it wears "done" (§28.3): a read that hung must not look like one that
 * rendered everything.
 */
import { StatusPill } from "@smthrs/ui"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"
import type { Card } from "../state/AppState"
import { dateLabel } from "../Timestamps"
import type { CardFamily } from "./CardFamily"
import { settledPill } from "./CardFamily"

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

const AdminHealthCardBody = ({ card }: { readonly card: Extract<Card, { kind: "admin-health" }> }) => {
  const { services, charges, checkedAt } = card.payload
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
        {charges === null
          ? "Charges: unread."
          : `Charges: $${charges.lifetimeChargedUsd} across ${charges.chargeCount} turn${
            charges.chargeCount === 1 ? "" : "s"
          }.`} Read at {dateLabel(checkedAt)}.
      </p>
    </div>
  )
}


export const adminCardFamily: CardFamily<"admin-health"> = {
  "admin-health": {
    render: (card) => <AdminHealthCardBody card={card} />,
    pill: settledPill
  }
}
