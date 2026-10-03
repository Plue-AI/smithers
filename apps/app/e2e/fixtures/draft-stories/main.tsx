import { createRoot } from "react-dom/client"
import { draftStories, type DraftStoryName } from "../../../src/mainview/cards/views/DraftView.stories"
import { DraftView } from "../../../src/mainview/cards/views/DraftView"
import "../../../src/mainview/styles/tokens.css"
import "../../../src/mainview/styles/cards.css"
import "../../../src/mainview/styles/views.css"
import "./story.css"

const params = new URLSearchParams(location.search)
const name = params.get("story") as DraftStoryName
if (!(name in draftStories)) throw new Error("Unknown Draft story")
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light"
const calls: unknown[] = []
Object.assign(window, { draftCalls: calls })
const story = draftStories[name]
createRoot(document.getElementById("root")!).render(<DraftView {...story}
  actions={params.has("removeFirst") ? story.actions.slice(1) : story.actions}
  onAction={(...args) => calls.push(args)} onView={() => { throw new Error("Unexpected view patch") }} />)
