/*
 * The secrets card: the secrets a repository's sessions may use, as metadata
 * only. plue never serves a value, so the card has nothing to mask: one row per
 * secret with its name, the hosts its egress binding covers (or "setup only"
 * when it is delivered as a placeholder without a binding), the header the
 * proxy swaps it into, and the updated time. The header line states the scope
 * plainly because every session in the repository may use these; personal
 * secrets are a later lane's second scope.
 */
import { Button } from "@smthrs/ui"
import { flowArgs } from "../flows/FlowArgs"
import { flowAction } from "../flows/FlowAction"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

/** The wire's ISO timestamp as a date, or the raw text when it does not parse. */
const updatedLabel = (updatedAt: string | null): string => {
  if (updatedAt === null) return ""
  const time = Date.parse(updatedAt)
  return Number.isNaN(time) ? updatedAt : new Date(time).toISOString().slice(0, 10)
}

export const SecretsCardBody = ({
  card, onRunCommand
}: {
  readonly card: Extract<Card, { kind: "secrets" }>
  readonly onRunCommand: RunCommand
}) => (
  <div className="world-card-list">
    <p className="world-card-path">{card.payload.repo}</p>
    <p className="secrets-scope" data-testid="secrets-scope">
      Repository secrets: every session in this repository may use them.
    </p>
    {card.payload.secrets.length === 0 ?
      <p className="world-card-empty">No secrets yet.</p> :
      (
        <table className="secrets-table" aria-label="Secrets">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Bound to</th>
              <th scope="col">Header</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {card.payload.secrets.map((secret) => (
              <tr key={secret.name} data-testid={`secret-${secret.name}`}>
                <td className="world-card-title">
                  {secret.name}
                  {secret.reconnect === true ?
                    <Button size="sm" {...flowAction(onRunCommand, "env.remove-token", card.payload.repo)}>Remove token</Button> :
                    null}
                </td>
                <td>{secret.hosts.length === 0 ? "setup only" : secret.hosts.join(", ")}</td>
                <td>{secret.matchHeaders.join(", ")}</td>
                <td>{updatedLabel(secret.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
  </div>
)

type AccountsCard = Extract<Card, { kind: "provider-accounts" }>
type Account = AccountsCard["payload"]["accounts"][number]

const PROVIDER_NAMES = { claude: "Claude", codex: "Codex" } as const

/** `limited until HH:MM` in local time while a usage limit parks the account. */
const accountState = (account: Account): string => {
  const until = account.limitedUntil === null ? Number.NaN : Date.parse(account.limitedUntil)
  if (!Number.isNaN(until)) {
    const at = new Date(until)
    return `limited until ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
  }
  return account.state === "refresh_failed" ? "reconnect" : account.state
}

/*
 * The account's coding-provider pool: rows per provider in the order sessions
 * try them, each with its state, a move within the order, and Revoke. A
 * pending Codex sign-in shows its code and where to enter it. A deployment
 * that does not offer coding accounts (`unavailable`) shows no connect buttons.
 */
export const ProviderAccountsCardBody = ({
  card, onRunCommand
}: {
  readonly card: AccountsCard
  readonly onRunCommand: RunCommand
}) => {
  const { accounts, pending, unavailable } = card.payload
  return (
    <div className="world-card-list">
      {unavailable ? null : (
        <div className="provider-accounts-actions">
          <Button size="sm" {...flowAction(onRunCommand, "secrets.connect")}>Add Claude</Button>
          <Button size="sm" {...flowAction(onRunCommand, "secrets.connect.codex")}>Add Codex</Button>
        </div>
      )}
      {pending === undefined ? null : (
        <p className="provider-accounts-pending" data-testid="codex-pending">
          <code>{pending.userCode}</code>{" "}
          <a href={pending.verificationUri} target="_blank" rel="noopener noreferrer">Open</a>
        </p>
      )}
      {(["claude", "codex"] as const).map((provider) => {
        const rows = accounts.filter((account) => account.provider === provider)
        if (rows.length === 0) return null
        return (
          <section key={provider} aria-label={PROVIDER_NAMES[provider]}>
            <h4 className="world-card-title">{PROVIDER_NAMES[provider]}</h4>
            <ul className="world-card-list">
              {rows.map((account, index) => {
                const name = account.email ?? account.label
                return (
                  <li key={account.id} className="world-card-row" data-testid={`account-${account.id}`}>
                    <span className="world-card-title">{name}</span>
                    <span className="world-card-path">{accountState(account)}</span>
                    <Button size="sm" aria-label={`Move ${name} up`} disabled={index === 0}
                      {...flowAction(onRunCommand, "secrets.move", flowArgs("secrets.move", { id: account.id, direction: "up" }))}>Up</Button>
                    <Button size="sm" aria-label={`Move ${name} down`} disabled={index === rows.length - 1}
                      {...flowAction(onRunCommand, "secrets.move", flowArgs("secrets.move", { id: account.id, direction: "down" }))}>Down</Button>
                    <Button size="sm" {...flowAction(onRunCommand, "secrets.revoke", account.id)}>Revoke</Button>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

export const secretsCardFamily: CardFamily<"secrets" | "provider-accounts"> = {
  secrets: { render: (card, actions) => <SecretsCardBody card={card} onRunCommand={actions.onRunCommand} />, pill: settledPill },
  "provider-accounts": {
    render: (card, actions) => <ProviderAccountsCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
