import { createRoot } from "react-dom/client"
import { setupStories } from "./SetupView.stories"
import { settingsStories } from "./SettingsView.stories"
import "../../styles/tokens.css"
import "../../styles/views.css"
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "light"
document.body.style.margin = "16px"
const stories = [...setupStories, ...settingsStories]
const story = stories.find(item => item.id === params.get("story")) ?? stories[0]!
createRoot(document.getElementById("root")!).render(story.render())
