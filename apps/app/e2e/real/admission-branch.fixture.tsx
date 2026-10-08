import "../../src/mainview/index.css"
import { useCallback, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { HomeCardSchema } from "@smthrs/rpc/HomeCard"
import { projectHome } from "../../src/mainview/runtime/HomeProjection"
import { LiveChannel } from "../../src/mainview/runtime/LiveChannel"
import { branchModel } from "../../src/mainview/state/seams/BranchSeam"
import { BranchView } from "../../src/mainview/cards/views/BranchView"
import { HomeView } from "../../src/mainview/cards/views/HomeView"

// Production readers and views over authenticated install subscriptions.
const branch = new URLSearchParams(location.search).get("branch")!
const live = new LiveChannel()
live.registerProjection("home", projectHome)
const useTopic = (topic: string) => useSyncExternalStore(
  useCallback((notify: () => void) => live.subscribe(topic, notify), [topic]),
  useCallback(() => live.getSnapshot(topic), [topic])
)
const actions = { actions: [], gestures: {}, view: { maximized: false }, onAction() {}, onView() {} }
function Mount() {
  const branchSnapshot = useTopic(`branch:${branch}`)
  const homeSnapshot = useTopic("home")
  const model = branchModel(branchSnapshot?.data, [], [], branch)
  const home = HomeCardSchema.safeParse(homeSnapshot?.data)
  return <>{model && <BranchView {...actions} model={model} />}{home.success && <HomeView {...actions} model={home.data} />}</>
}
createRoot(document.getElementById("root")!).render(<Mount />)
Object.assign(window, { admission: { cursor: () => live.getSnapshot(`branch:${branch}`)?.cursor } })
