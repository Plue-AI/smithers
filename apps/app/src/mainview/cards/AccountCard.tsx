import { flowAction } from "../flows/FlowAction"
/*
 * The account card (factory mock 21, design session §6c): read-only seam
 * facts about the signed-in person, and the Sign out door. The login
 * always renders (the identity seam holds it); the
 * GitHub App permissions section renders only when the identity worker answered.
 * OAuth requests only read:user for the profile. The
 * boxes section only when the workspaces seam has listed any. Nothing else
 * exists here: no billing, usage or seat rows, because no seam holds them.
 */
import { Button } from "@smthrs/ui"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "../FailureNotice"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

/* A failed permissions read; the read's own words stay behind Details. */
const PERMISSIONS_FAILED: UserFailureCopy = { fault: "infra", sentence: "Smithers could not load your permissions. Not your fault.", actions: ["retry"] }

export const AccountCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "account" }>
  readonly onRunCommand: RunCommand
}) => (
  <div className="world-card-list">
    <table className="secrets-table" aria-label="Account">
      <tbody>
        <tr data-testid="account-login">
          <th scope="row">{card.payload.provider === "github" ? "GitHub" : "Account"}</th>
          <td>{card.payload.provider === "github" ? "Connected as " : ""}@{card.payload.login}</td>
        </tr>
      </tbody>
    </table>
    {card.payload.provider !== "github" ? null : <>
      <p className="secrets-scope">GitHub scopes</p>
      <table className="secrets-table" aria-label="GitHub scopes">
        <tbody><tr><th scope="row">read:user</th><td>See your GitHub profile.</td></tr></tbody>
      </table>
    </>}
    {card.payload.provider !== "github" || card.payload.scopes.length === 0 ? null : (
      <>
        <p className="secrets-scope">GitHub App permissions</p>
        <table className="secrets-table" aria-label="GitHub App permissions">
          <tbody>
            {card.payload.scopes.map((row) => (
              <tr key={row.scope} data-testid={`account-scope-${row.scope}`}>
                <th scope="row">{row.scope}</th>
                <td>{row.plain}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    )}
    {card.payload.boxes.length === 0 ? null : (
      <>
        <p className="secrets-scope">Boxes</p>
        <table className="secrets-table" aria-label="Boxes">
          <tbody>
            {card.payload.boxes.map((box) => (
              <tr key={box.id} data-testid={`account-box-${box.id}`}>
                <th scope="row">{box.repoId}</th>
                <td>{box.name}</td>
                <td>{box.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    )}
    {card.payload.refresh?.state === "failed" && <FailureNotice data-testid="account-permissions-failure"
      failure={describedFailure("AccountPermissionsFailed", PERMISSIONS_FAILED, card.payload.refresh.error)}
      actions={{ retry: flowAction(onRunCommand, "account.show") }} />}
    <Button size="sm" variant="outline"  {...flowAction(onRunCommand, "sign-out")}>
      Sign out
    </Button>
  </div>
)

export const accountCardFamily: CardFamily<"account"> = {
  account: {
    render: (card, actions) => <AccountCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
