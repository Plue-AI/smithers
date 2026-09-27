import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { MAIN_TAB_ID } from "../state/AppState"
import { ConfirmDialog } from "../SurfaceChrome"
import { SubagentCrumb, subagentCrumbOf } from "../SubagentGrid"
import { useCardRows } from "../state/useCardRows"
import { CardTabBody } from "./CardTabBody"
import { TerminalView } from "./TerminalView"

/*
 * Every non-main tab's body (docs/LOCAL-APP.md "Tabs"). All of them stay
 * mounted; the inactive ones are `hidden`, never unmounted, so a terminal's
 * scrollback and emulator survive switching. The main tab's body is the
 * chat itself and lives in App.tsx under the same `tab-body` wrapper.
 *
 * The close question for a live process tab renders here too: it is session
 * state (pendingTabCloseId), asked by /tab.close and answered by
 * /tab.close.confirm or /tab.close.cancel.
 */
export function TabBodies() {
  const controller = useController()
  const { collections } = controller.store
  const { data: tabRows } = useLiveQuery((q) => q.from({ tab: collections.tabs }).orderBy(({ tab }) => tab.ordinal))
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: collections.sessions }).select(({ session }) => ({
      id: session.id,
      activeTabId: session.activeTabId,
      pendingTabCloseId: session.pendingTabCloseId
    }))
  )
  const session = sessionRows[0]
  const activeTabId = session?.activeTabId ?? MAIN_TAB_ID
  // A local subagent's terminal wears the breadcrumb back to the conversation.
  const cards = useCardRows(collections.cards)
  const pendingClose = tabRows.find((tab) => tab.id === (session?.pendingTabCloseId ?? null))

  return (
    <>
      {tabRows.map((tab) =>
        tab.kind === "main" ? null : (
          <div
            key={tab.id}
            className="tab-body"
            data-keyboard-pane={tab.title}
            data-kind={tab.kind}
            data-testid={`tab-body-${tab.id}`}
            hidden={tab.id !== activeTabId}
          >
            {tab.kind === "card" ? <CardTabBody cardId={tab.cardId} /> : <TerminalCrumb cards={cards} tabId={tab.id} onRunCommand={controller.runCommand} />}
            {tab.kind === "card" ? null : <TerminalView tab={tab} />}
          </div>
        )
      )}
      <ConfirmDialog
        open={pendingClose !== undefined}
        title={`Close ${pendingClose?.title ?? "this session"}?`}
        body={pendingClose?.kind === "terminal" && pendingClose.workspaceId !== undefined
          // A workspace terminal's process lives in the cloud workspace: closing detaches; box.session.destroy ends it.
          ? "Closing detaches from the box session; it keeps running in the box."
          : "Its process is still running and will be stopped."}
        confirmLabel="Close session"
        destructive
        onConfirm={() => controller.runCommand("tab.close.confirm")}
        onCancel={() => controller.runCommand("tab.close.cancel")}
      />
    </>
  )
}

const TerminalCrumb = ({ cards, tabId, onRunCommand }: {
  readonly cards: Parameters<typeof subagentCrumbOf>[0]
  readonly tabId: string
  readonly onRunCommand: Parameters<typeof SubagentCrumb>[0]["onRunCommand"]
}) => {
  const crumb = subagentCrumbOf(cards, { tabId })
  return crumb === undefined ? null : <SubagentCrumb title={crumb.title} color={crumb.color} onRunCommand={onRunCommand} />
}
