import type { CodeEditorViewProps } from "@smthrs/rpc/FileCard"
import { fixtures } from "@smthrs/rpc/fixtures/File"
import { CodeEditorView } from "./CodeEditorView"
import { authorRanges } from "../liveAttribution"
import type { EditorBinding } from "@smthrs/ui/adapters/code-editor"
import type { ViewStory } from "./stories"
const { live, saved, outside, text, binary, too_large, live_separate } = fixtures
const unsaved = fixtures.unsaved
export const fileStories = { live, live_separate, no_binding: live, saved, unsaved, outside, text, binary, too_large,
  missing_reapply: { ...unsaved, actions: [] },
  five_editors: { ...live, model: { ...live.model, editors: [...live.model.editors, ...live.model.editors, live.model.editors[0]!] } },
  unsaved_one: { ...unsaved, model: { ...unsaved.model, unsaved: { count: 1, text: "Recovered text" } }, expect: ["Recovered text"] },
  disabled_reapply: { ...unsaved, actions: [{ tag: "file.reapply" as const, label: "Reapply", args: { path: unsaved.model.path }, disabled: { reason: "Reconnect first" }, primary: true }] },
}
function storyBinding(name: string, model: CodeEditorViewProps["model"]): EditorBinding | undefined {
  if (model.mode !== "live" || model.content.kind !== "text") return undefined
  const text = model.content.text
  // Fixed fixture attribution exercises the production CodeMirror extension.
  if (name === "live_separate") return { text, extensions: authorRanges.of([
    { from: 0, to: 13, actor: model.authors[0]! },
    { from: 14, to: 27, actor: model.authors[1]! },
    { from: 28, to: 43, actor: model.authors[2]! }
  ]) }
  return { text, extensions: authorRanges.of(model.authors.map((actor, index) => ({ actor, from: index * 6, to: Math.min(text.length, (index + 1) * 6) }))) }
}
export const stories: ViewStory[] = Object.entries(fileStories).map(([name, story]) => ({ name, expect: story.expect, actions: story.actions, interactions: story.model.unsaved ? [{ selector: ".code-notice button:not([data-flow])", action: null }] : [], render: (callbacks, actions) => <CodeEditorView {...story} binding={name === "no_binding" ? undefined : storyBinding(name, story.model)} actions={(actions as CodeEditorViewProps["actions"]) ?? story.actions} {...callbacks} /> }))
