/*
 * The secrets card: a repository's CI secrets, the store /secrets.set, .delete,
 * .scope and .bind act on. Metadata only; no value exists to mask. One row per
 * secret: its name, whether it reaches only main, how many hosts it is bound to,
 * and Main only / Every run, Bind, Rotate and Delete. The value field of Add and
 * Rotate is write-only; Delete and widening to every run ask first.
 */
import { Button } from "@smthrs/ui"
import { flowArgs } from "../flows/FlowArgs"
import { flowAction } from "../flows/FlowAction"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

export const SecretsCardBody = ({
  card, onRunCommand
}: {
  readonly card: Extract<Card, { kind: "secrets" }>
  readonly onRunCommand: RunCommand
}) => (
  <div className="world-card-list">
    <p className="world-card-path">{card.payload.repo}</p>
    <Button size="sm" {...flowAction(onRunCommand, "secrets.set", flowArgs("secrets.set", { repo: card.payload.repo }))}>Add secret</Button>
    {card.payload.secrets.length === 0 ?
      null :
      (
        <table className="secrets-table" aria-label="Secrets">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Main only</th>
              <th scope="col">Hosts</th>
              <th scope="col" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {card.payload.secrets.map((secret) => (
              <tr key={secret.name} data-testid={`secret-${secret.name}`}>
                <td className="world-card-title">{secret.name}</td>
                <td>{secret.mainOnly ? "yes" : "no"}</td>
                <td>{secret.hosts.length}</td>
                <td>
                  <Button size="sm" aria-label={`${secret.mainOnly ? "Give to every run" : "Limit to main"} ${secret.name}`}
                    {...flowAction(onRunCommand, "secrets.scope", flowArgs("secrets.scope", {
                      name: secret.name, scope: secret.mainOnly ? "all" : "main-only", repo: card.payload.repo
                    }))}>{secret.mainOnly ? "Every run" : "Main only"}</Button>
                  <Button size="sm" aria-label={`Bind ${secret.name}`}
                    {...flowAction(onRunCommand, "secrets.bind", flowArgs("secrets.bind", { name: secret.name, repo: card.payload.repo }))}>Bind</Button>
                  <Button size="sm" aria-label={`Rotate ${secret.name}`}
                    {...flowAction(onRunCommand, "secrets.set", flowArgs("secrets.set", { name: secret.name, repo: card.payload.repo }))}>Rotate</Button>
                  <Button size="sm" aria-label={`Delete ${secret.name}`}
                    {...flowAction(onRunCommand, "secrets.delete", flowArgs("secrets.delete", { name: secret.name, repo: card.payload.repo }))}>Delete</Button>
                </td>
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
