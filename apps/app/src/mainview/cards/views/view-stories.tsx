/// <reference types="vite/client" />
import { cloneElement, isValidElement, type ReactElement } from "react"
import { lintCopy, type CopyViolation } from "../productWords"
import { createRoot } from "react-dom/client"
import type { StoryModule, ViewStory } from "./stories"
import "../../index.css"
import "./view-stories.css"

const modules = import.meta.glob<StoryModule>("./*.stories.tsx", { eager: true })
const stories: ViewStory[] = Object.entries(modules).flatMap(([path, module]) => module.stories.map(story => ({ ...story, name: `${path.split("/").pop()!.replace(".stories.tsx", "")}/${story.name}` })))
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light"
document.body.style.cssText = "margin:0;background:var(--bg);color:var(--text)"
const record = (kind: string, value: unknown) => { window.dispatchEvent(new CustomEvent("story-callback", { detail: { kind, value } })) }
const root = createRoot(document.getElementById("root")!)
const viewFiles = Object.keys(import.meta.glob("./*View.tsx"))
const views = viewFiles.map(path => path.slice(2, -4)).sort()
const missing = views.filter(view => !Object.keys(modules).includes(`./${view}.stories.tsx`))
const fixtureNames = stories.filter(story => views.includes(story.name.split("/")[0]!)).map(story => story.name)

const renderStory = (name?: string, maximized?: boolean, theme: "light" | "dark" = "light") => {
  const selected = stories.find(story => story.name === name)
  document.documentElement.dataset.theme = theme
  let content = selected?.render({ onAction: (tag, args) => record("action", { tag, args }), onView: patch => record("view", patch) }, params.has("removeFirst") ? selected.actions?.slice(1) : undefined)
  if (maximized !== undefined && isValidElement(content)) {
    const element = content as ReactElement<{ view?: Record<string, unknown> }>
    content = cloneElement(element, { view: { ...element.props.view, maximized } })
  }
  root.render(<main>
    {selected ? <article key={selected.name} className="view-story" data-story={selected.name} data-maximized={String(maximized)} data-theme={theme}>{content}</article>
      : <nav aria-label="View stories">{stories.map(story => <p key={story.name}><a href={`?story=${encodeURIComponent(story.name)}`}>{story.name}</a></p>)}</nav>}
  </main>)
}

declare global {
  interface Window {
    viewStoryMatrix: {
      views: string[]; fixtures: string[]; missing: string[];
      render: (name: string, maximized: boolean, theme: "light" | "dark") => void;
      violations: () => ReadonlyArray<CopyViolation>;
    }
  }
}
// This entry is built only for the existing story/test harness, never the install.
window.viewStoryMatrix = { views, fixtures: fixtureNames, missing, render: renderStory,
  violations: () => lintCopy(document.querySelector(".view-story")!) }
performance.mark("view-story-mount")
renderStory(params.get("story") ?? undefined, params.has("maximized") ? params.get("maximized") === "1" : undefined, params.get("theme") === "dark" ? "dark" : "light")
