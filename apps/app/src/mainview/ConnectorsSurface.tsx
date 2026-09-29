import { dynamicFlowProps, flowAction } from "./flows/FlowAction"
import { Badge, Button, Separator } from "@smthrs/ui"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "./FailureNotice"
import { useLiveQuery } from "@tanstack/react-db"
import { FolderGit2, GitPullRequest, Plug, Server } from "lucide-react"
import type { KeyboardEvent } from "react"
import { useController } from "./ControllerContext"
import { rovingKeyDown } from "./RovingKeyDown"
import { SurfaceHeader } from "./SurfaceChrome"

/** A failed local connect keeps only the reducer's message, so it is the Details of one sentence. */
export const CONNECTOR_FAILURE: UserFailureCopy = {
  fault: "infra",
  sentence: "Smithers could not connect this repository. Not your fault.",
  actions: []
}

/*
 * The connect surface (Wave 10, §2e): extension-store grammar — a compact
 * list of connector rows: icon, name, repository count when known, one action
 * (Connect / Connected ✓ / Coming soon). No paragraphs, no prose blocks.
 * Keyboard-complete: arrows move between rows, Enter is the row's action.
 * Sign-in IS the GitHub connector (§2a′): a valid session reads Connected.
 */
export function ConnectorsSurface() {
  const controller = useController()
  const { collections } = controller.store
  const { data: operationRows } = useLiveQuery(collections.connectorOperations)
  const { data: identityRows } = useLiveQuery(collections.identitySessions)

  const { data: gitHubAppStatusRows } = useLiveQuery(collections.githubAppStatuses)
  const { data: repositoryRows } = useLiveQuery(collections.repositories)
  // A public catalog row is readable by anyone; only the signed-in inventory is connected.
  const connectedRepositories = repositoryRows
    .filter((row) => row.catalog !== true)
    .map((row) => row.id)
    .sort((left, right) => left.localeCompare(right))
  const installedRepositories = gitHubAppStatusRows.filter((row) => row.installed && row.configured).length
  const operation = operationRows.find((candidate) => candidate.id === "connector-operation") ??
    collections.connectorOperations.get("connector-operation")
  const identity = identityRows[0]
  const signedIn = identity?.state === "signed-in"
  const githubAvailable = controller.commands.find(signedIn ? "auth.sign-out" : "auth.sign-in") !== undefined
  const cloudAvailable = controller.commands.find("repos.import") !== undefined

  interface StoreRow {
    readonly key: string
    readonly icon: "github" | "cloud"
    readonly name: string
    readonly repositoryCount?: number
    readonly action:
      | {
        readonly kind: "button"
        readonly label: string
        readonly flow: string
      }
      | { readonly kind: "badge"; readonly label: string; readonly variant: "success" | "outline" }
  }

  const rows: ReadonlyArray<StoreRow> = [
    ...(githubAvailable ? [{
      /*
       * Lane sync: signed in, the row's act is github.app — the App status
       * read that renders the connector-setup card. Signed out, sign-in IS
       * still the GitHub connector (§2a′). The count is only what the app
       * has read — a repository never checked is not claimed.
       */
      key: "github",
      icon: "github",
      name: "GitHub",
      ...(installedRepositories > 0 ? { repositoryCount: installedRepositories } : {}),
      action: signedIn
        ? { kind: "button", label: "Check the App", flow: "github.app" }
        : { kind: "button", label: "Connect", flow: "auth.sign-in" }
    } satisfies StoreRow] : []),
    ...(cloudAvailable ? [{
      /*
       * repos.import mirrors a GitHub repository into Smithers Cloud and is
       * tracked by the repo-import card.
       *
       * §1.1: importing needs a session, and pressing it signed out only
       * defers into the GitHub row above. Offering it as available work
       * made the signed-out app look like it had several ways in when it
       * has one; signed out it states what it needs instead.
       */
      key: "cloud",
      icon: "cloud",
      name: "Smithers Cloud repository",
      action: signedIn
        ? { kind: "button", label: "Import", flow: "repos.import" }
        : { kind: "badge", label: "Needs GitHub", variant: "outline" }
    } satisfies StoreRow] : [])
  ]

  const rowIcon = (icon: StoreRow["icon"]) =>
    icon === "github" ?
      <GitPullRequest size={16} aria-hidden="true" /> :
      <Server size={16} aria-hidden="true" />

  const onRowsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    /*
     * Buttons only: a status Badge also carries data-row-action (it is the
     * row's action slot) but is deliberately not a control — roving onto it
     * would call focus() on a non-focusable element and strand the ring.
     */
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(".connect-store-row button[data-row-action]")
    )
    const move = rovingKeyDown(event.key, {
      count: items.length,
      current: items.indexOf(document.activeElement as HTMLElement)
    })
    if (move.kind !== "move") return
    event.preventDefault()
    items[move.index]?.focus()
  }

  return (
    <section data-keyboard-pane="Connectors" className="connectors-surface embedded-pane" aria-label="Smithers connectors">
      <SurfaceHeader
        icon={<Plug size={17} />}
        title="Connectors"
        closeCommand="chat"
        onClose={() => controller.runCommand("chat")}
      />

      <main className="connectors-content">
        {operation?.error ?
          <FailureNotice data-testid="connector-failure" failure={describedFailure("ConnectorFailed", CONNECTOR_FAILURE, operation.error)} /> :
          null}

        <div className="connect-store-list" role="list" aria-label="Connectors" onKeyDown={onRowsKeyDown}>
          {rows.map((row) => (
            <div className="connect-store-row" role="listitem" key={row.key}>
              <span className="connect-store-icon">{rowIcon(row.icon)}</span>
              <span className="connect-store-text">
                <strong>{row.name}</strong>
                {row.repositoryCount === undefined ? null : <span>{row.repositoryCount} {row.repositoryCount === 1 ? "repository" : "repositories"}</span>}
              </span>
              {row.action.kind === "button" ?
                (
                  <Button
                    size="sm"
                    variant="outline"
                    {...dynamicFlowProps(row.action.flow)}
                    data-row-action
                    onClick={() =>
                      row.action.kind === "button"
                        ? controller.runCommand(row.action.flow)
                        : undefined}
                  >
                    {row.action.label}
                  </Button>
                ) :
                (
                  /*
                   * §21.2: a status badge is not interactive. Giving it a tab
                   * stop put a control in the ring that does nothing when
                   * activated, so a keyboard user pays a keystroke for it and
                   * gets no act back.
                   */
                  <Badge variant={row.action.variant} data-row-action>
                    {row.action.label}
                  </Badge>
                )}
            </div>
          ))}
        </div>

        <Separator />

        <section className="connected-repositories" aria-labelledby="connected-repositories-title">
          <div className="connected-repositories-heading">
            <div>
              <h2 id="connected-repositories-title">Connected repositories</h2>
            </div>
          </div>

          {connectedRepositories.length > 0 ?
            (
              <ul className="connected-repository-list" role="list" aria-labelledby="connected-repositories-title">
                {connectedRepositories.map((id) => (
                  <li className="connected-repository" role="listitem" key={id}>
                    <FolderGit2 size={16} aria-hidden="true" />
                    <span>{id}</span>
                  </li>
                ))}
              </ul>
            ) :
            (
              /*
               * §11.6: the zero case names its one move, import; signed out
               * the GitHub row above comes first.
               */
              <div className="connector-empty">
                <FolderGit2 size={20} />
                <div>
                  <strong>No repositories connected</strong>
                  {signedIn && cloudAvailable ?
                    (
                      <Button
                        size="sm"
                        variant="outline"
                        {...flowAction(controller.runCommand, "repos.import")}
                      >
                        Import a repository
                      </Button>
                    ) :
                    null}
                </div>
              </div>
            )}
        </section>
      </main>

    </section>
  )
}
