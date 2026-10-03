/// <reference types="vite/client" />
import { createRoot } from "react-dom/client"
import type { StoryModule, ViewStory } from "./stories"
import "../../styles/tokens.css"
import "../../styles/views.css"
import "./view-stories.css"

const modules = import.meta.glob<StoryModule>("./*View.stories.tsx", { eager: true })
const stories: ViewStory[] = Object.entries(modules).flatMap(([path, module]) => module.stories.map(story => ({ ...story, name: `${path.split("/").pop()!.replace(".stories.tsx", "")}/${story.name}` })))
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light"
document.body.style.cssText = "margin:0;background:var(--bg);color:var(--text)"
const selected = stories.find(story => story.name === params.get("story"))
const record = (kind: string, value: unknown) => { window.dispatchEvent(new CustomEvent("story-callback", { detail: { kind, value } })) }
performance.mark("view-story-mount")
createRoot(document.getElementById("root")!).render(<main>
  {selected ? <article className="view-story" data-story={selected.name}>{selected.render({ onAction: (tag, args) => record("action", { tag, args }), onView: patch => record("view", patch) }, params.has("removeFirst") ? selected.actions?.slice(1) : undefined)}</article>
    : <nav aria-label="View stories">{stories.map(story => <p key={story.name}><a href={`?story=${encodeURIComponent(story.name)}`}>{story.name}</a></p>)}</nav>}
</main>)
