import { useSyncExternalStore } from "react"
import type { CodeEditorViewProps } from "@smthrs/rpc/FileCard"
import type { ViewStory } from "./stories"
import { CodeEditorSurface as CodeSurface } from "../CodeEditorSurface"
import { fixtures as fileFixtures } from "@smthrs/rpc/fixtures/File"
const fileStates = { deleted: fileFixtures.deleted, renamed: fileFixtures.renamed, outside: fileFixtures.outside, comparing: { ...fileFixtures.comparing, comparison: { version: "git:7d1e0c2", text: 'export default Flow.make("todo", { description: "Build" })\n' } },
  comparing_empty: { ...fileFixtures.comparing, comparison: { version: "git:7d1e0c2", text: "" } },
  comparing_hostile: { ...fileFixtures.comparing, expect: ['<script>window.__pwned=1</script>'], model: { ...fileFixtures.comparing.model, path: '<script>window.__pwned=1</script>', content: { kind: "text" as const, text: '<img src=x onerror="window.__pwned=1">' } }, comparison: { version: "git:7d1e0c2", text: '<script>window.__pwned=1</script>' } }, deleted_readonly: { ...fileFixtures.deleted, actions: [] }, renamed_readonly: { ...fileFixtures.renamed, actions: [] }, outside_readonly: { ...fileFixtures.outside, actions: [] }, restore_disabled: { ...fileFixtures.deleted, actions: fileFixtures.deleted.actions.map(action => ({ ...action, disabled: { reason: "Waiting for a machine" } })) } }
export const stories: ViewStory[] = Object.entries(fileStates).map(([name, story]) => ({ name, expect: story.expect, actions: story.actions, render: (callbacks, actions = story.actions) => <CodeSurface {...story} actions={actions as CodeEditorViewProps["actions"]} {...callbacks} /> }))

// Deliver new props through the existing runner without recreating the editor.
let reloaded = false
const subscribeReload = (notify: () => void) => {
  const reload = () => { reloaded = true; notify() }
  window.addEventListener("story-reload", reload)
  return () => window.removeEventListener("story-reload", reload)
}
const reloadText = "const first = 1\nconst second = 2\n" + Array.from({ length: 80 }, (_, index) => `const line${index + 3} = ${index + 3}\n`).join("")
function ReloadStory(callbacks: Parameters<ViewStory["render"]>[0]) {
  const updated = useSyncExternalStore(subscribeReload, () => reloaded, () => false)
  return <CodeSurface {...fileFixtures.comparing} {...callbacks} actions={[]} gestures={{}}
    model={{ ...fileFixtures.comparing.model, digest: updated ? "sha256:next" : "sha256:current",
      content: { kind: "text", text: updated ? reloadText.replace("second = 2", "second = 3") : reloadText } }}
    comparison={{ version: "git:7d1e0c2", text: "const snapshot = 7\n" }} />
}
stories.push({ name: "comparing_reload", expect: ["const first = 1", "const snapshot = 7"], render: callbacks => <ReloadStory {...callbacks} /> })
