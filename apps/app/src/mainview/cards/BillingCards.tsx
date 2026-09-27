import { timeLabel } from "../Timestamps"
import { flowAction } from "../flows/FlowAction"
import { flowArgs } from "../flows/FlowArgs"
import { refusalFromStored } from "@smthrs/rpc/Refusal"
import { refusalLead } from "@smthrs/rpc/RefusalCopy"
import { useCallback, useSyncExternalStore } from "react"
import { creditDollars } from "../state/seams/BillingSeam"
import { UpgradeDoor, upgradePlanKey } from "./WorkspaceCard"
import type { CardProjectionAuthority, RunCommand } from "./CardFamily"

/*
 * The billing cards: the balance readout and the admin's promotional grant
 * confirm. Money moves only through the billing service; the cards report.
 */
import { Button } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import type { CardFamily } from "./CardFamily"

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

const quantity = (value: number) => value === -1 ? "Unlimited" : String(value)
const idle = (seconds: number) => seconds === 0 ? "Never sleeps" : seconds < 3600 ? `${seconds / 60} min` : `${seconds / 3600} h`

type BillingPlansCard = Extract<Card, { kind: "billing-plans" }>

/** Max is not sold: it shows only to an account already on it. */
export const offeredPlans = <Plan extends { readonly key: string }>(plans: ReadonlyArray<Plan>, planKey: string | null): ReadonlyArray<Plan> =>
  plans.filter(plan => plan.key !== "max" || plan.key === planKey)

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

export const BillingPlansCardBody = ({ card, onRunCommand, creditBalanceCents = null, creditResetsAt = null }: {
  readonly card: BillingPlansCard; readonly onRunCommand: RunCommand
  readonly creditBalanceCents?: number | null; readonly creditResetsAt?: string | null
}) => {
  const { plans, planKey, sandbox, checkout } = card.payload
  const refusal = card.payload.refusal ? refusalFromStored(card.payload.refusal) : null
  const columns = [...offeredPlans(plans, planKey)].sort((a, b) => a.price_cents - b.price_cents)
  const included = plans.find(plan => plan.key === planKey)?.limits.monthly_credit_cents ?? 0
  const credited = columns.some(plan => plan.limits.monthly_credit_cents !== undefined)
  const resets = creditResetsAt === null || Number.isNaN(Date.parse(creditResetsAt)) ? null : creditResetsAt
  return <div className="world-card-list">
    {refusal === null ? null : <div role="alert">
      <p>{refusalLead(refusal)}</p><p>{refusal.message}</p>
      {checkout ? <UpgradeDoor refusal={refusal} onRunCommand={onRunCommand} disabled={ upgradePlanKey(refusal) === planKey || plans.find(plan => plan.key === upgradePlanKey(refusal))?.checkout_available === false} /> : null}
    </div>}
    {creditBalanceCents === null ? null : <p data-testid="billing-credit-line">
      Credit left: <strong data-testid="billing-credit">{creditDollars(creditBalanceCents)}</strong>
      {included > 0 ? <> · Included: <span data-testid="billing-credit-included">{creditDollars(included)}</span> per month</> : null}
      {included > 0 && resets !== null ? <> · Resets <time data-testid="billing-credit-reset" dateTime={resets}>{day.format(new Date(resets))}</time></> : null}
    </p>}
    {columns.length === 0 ? null : <div style={{ overflowX: "auto" }}><table className="secrets-table billing-plans">
      <thead><tr><th scope="col">Plan</th>{columns.map(plan => <th scope="col" key={plan.key}
        aria-current={plan.key === planKey ? "true" : undefined}
        style={plan.key === planKey ? { background: "var(--surface)", outline: "2px solid currentColor", outlineOffset: "-2px" } : undefined}>
        {plan.display_name} {dollars.format(plan.price_cents / 100)}{plan.price_cents === 0 ? "" : " per month"}
        {plan.key === planKey ? " · Current plan" : ""}
      </th>)}</tr></thead>
      <tbody>
        {credited ? <tr><th scope="row">Model credit per month</th>{columns.map(plan => <td key={plan.key}>{creditDollars(plan.limits.monthly_credit_cents ?? 0)}</td>)}</tr> : null}
        <tr><th scope="row">Running sandboxes</th>{columns.map(plan => <td key={plan.key}>{quantity(plan.limits.concurrent_sandboxes)}</td>)}</tr>
        <tr><th scope="row">Idle sleep</th>{columns.map(plan => <td key={plan.key}>{idle(plan.limits.idle_timeout_secs)}</td>)}</tr>
        <tr><th scope="row">Sandbox-hours per day</th>{columns.map(plan => <td key={plan.key}>{quantity(plan.limits.hours_per_day)}</td>)}</tr>
        {checkout ? <tr><th scope="row">Upgrade</th>{columns.map(plan => <td key={plan.key}>{plan.key === "free" || plan.key === "max" ? null :
          <Button size="sm" disabled={!checkout || !plan.checkout_available || plan.key === planKey}
            {...flowAction(onRunCommand, "billing.upgrade", flowArgs("billing.upgrade", { plan: plan.key }))}>
            Upgrade to {plan.display_name}
          </Button>}
        </td>)}</tr> : null}
      </tbody>
    </table></div>}
    {sandbox === null ? null : <p>
      In use: {sandbox.concurrentInUse} / {quantity(sandbox.concurrentSandboxes)} · Hours today: {Number((sandbox.secondsUsedToday / 3600).toFixed(2))} / {quantity(sandbox.hoursPerDay)} · Resets at <time dateTime={sandbox.dayResetsAt}>{timeLabel(Date.parse(sandbox.dayResetsAt))}</time>
    </p>}
  </div>
}

/** The account's credit is the billing row's live fact, read beside the card's plans. */
const ObservedBillingPlans = ({ card, accounts, onRunCommand }: {
  readonly card: BillingPlansCard; readonly onRunCommand: RunCommand
  readonly accounts: NonNullable<CardProjectionAuthority["collections"]["billingAccounts"]>
}) => {
  const subscribe = useCallback((notify: () => void) => {
    const subscription = accounts.subscribeChanges(notify)
    return () => subscription.unsubscribe()
  }, [accounts])
  const readCredit = () => accounts.get("billing")?.creditBalanceCents ?? null
  const readResets = () => accounts.get("billing")?.creditResetsAt ?? null
  return <BillingPlansCardBody card={card} onRunCommand={onRunCommand}
    creditBalanceCents={useSyncExternalStore(subscribe, readCredit, readCredit)}
    creditResetsAt={useSyncExternalStore(subscribe, readResets, readResets)} />
}

const BalanceCardBody = ({ card }: { readonly card: Extract<Card, { kind: "balance" }> }) => (
  <>
    {card.payload.introUsd !== null ?
      <p className="smithers-balance-intro">You have ${card.payload.introUsd} of usage on us.</p> :
      null}
    <p className="smithers-balance-total">
      {card.payload.allowedToStartWork
        ? `$${card.payload.totalUsd} left.`
        : "Balance is at $0 — new work is paused; everything already here stays readable."}
    </p>
    {card.payload.chargeCount > 0 ?
      (
        <p className="smithers-card-note">
          ${card.payload.lifetimeChargedUsd} spent across {card.payload.chargeCount} turn
          {card.payload.chargeCount === 1 ? "" : "s"} so far.
        </p>
      ) :
      null}
  </>
)


const GrantConfirmCardBody = ({
  card,
  onGrantConfirm,
  onGrantCancel
}: {
  readonly card: Extract<Card, { kind: "grant-confirm" }>
  readonly onGrantConfirm: (id: string) => void
  readonly onGrantCancel: (id: string) => void
}) => {
  const { login, amountUsd, phase, grantId, error } = card.payload
  return (
    <div className="grant-card">
      <p className="grant-what">
        Grant <strong>${amountUsd}</strong> of promotional balance to <strong>{login}</strong>.
      </p>
      <p className="smithers-card-note">
        The grant is recorded with your login as the requester and a fresh timestamp; the billing service answers before
        anything is treated as done.
      </p>
      {phase === "confirm" || phase === "failed" ?
        (
          <div className="reco-actions">
            <Button size="sm" onClick={() => onGrantConfirm(card.id)}>
              {phase === "failed" ? "Try again" : "Post the grant"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onGrantCancel(card.id)}>
              Cancel
            </Button>
          </div>
        ) :
        null}
      {phase === "sending" ? <p className="sui-approval-pending">Posting the grant…</p> : null}
      {phase === "granted" ?
        (
          <p className="smithers-card-note">
            Granted{grantId !== undefined ? ` — ${grantId}` : ""}.
          </p>
        ) :
        null}
      {phase === "failed" && error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
    </div>
  )
}


export const billingCardFamily: CardFamily<"balance" | "grant-confirm" | "billing-plans"> = {
  "billing-plans": {
    render: (card, actions) => actions.projectionStore?.collections.billingAccounts === undefined
      ? <BillingPlansCardBody card={card} onRunCommand={actions.onRunCommand} />
      : <ObservedBillingPlans card={card} accounts={actions.projectionStore.collections.billingAccounts} onRunCommand={actions.onRunCommand} />,
    pill: () => "done"
  },
  balance: {
    render: (card) => <BalanceCardBody card={card} />,
    pill: (card) => {
      if (card.payload.state === "empty") return "failed"
      if (card.payload.state === "low") return "pending"
      return "done"
    }
  },
  "grant-confirm": {
    render: (card, actions) => (
      <GrantConfirmCardBody card={card} onGrantConfirm={actions.onGrantConfirm} onGrantCancel={actions.onGrantCancel} />
    ),
    pill: (card) => {
      if (card.payload.phase === "granted") return "done"
      if (card.payload.phase === "sending") return "running"
      return "waiting-approval"
    }
  }
}
