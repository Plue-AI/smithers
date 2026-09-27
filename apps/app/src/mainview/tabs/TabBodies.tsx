import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { MAIN_TAB_ID } from "../state/AppState"
import { CardTabBody } from "./CardTabBody"

/*
 * Every non-main tab's body (docs/LOCAL-APP.md "Cards", "Open in tab"). All of
 * them stay mounted; the inactive ones are `hidden`, never unmounted, so a
 * card's scroll position and editors survive switching. The main tab's body
 * is the chat itself and lives in App.tsx under the same `tab-body` wrapper.
 */
export function TabBodies() {
  const controller = useController()
  const { collections } = controller.store
  const { data: tabRows } = useLiveQuery((q) => q.from({ tab: collections.tabs }).orderBy(({ tab }) => tab.ordinal))
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: collections.sessions }).select(({ session }) => ({ id: session.id, activeTabId: session.activeTabId }))
  )
  const activeTabId = sessionRows[0]?.activeTabId ?? MAIN_TAB_ID

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
            <CardTabBody cardId={tab.cardId} />
          </div>
        )
      )}
    </>
  )
}
