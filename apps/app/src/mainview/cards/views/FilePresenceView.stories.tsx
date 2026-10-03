import type { CodeEditorViewProps } from "@smthrs/rpc/FileCard"
import { fixtures } from "@smthrs/rpc/fixtures/File"
import { FilePresenceView } from "./FilePresenceView"
import type { ViewStory } from "./stories"
const { live, saved, outside, text, binary, too_large, live_separate } = fixtures
const unsaved = fixtures.unsaved
export const fileStories = { live, live_separate, no_binding: live, saved, unsaved, outside, text, binary, too_large,
  five_editors: { ...live, model: { ...live.model, editors: [...live.model.editors, ...live.model.editors, live.model.editors[0]!] } },
  unsaved_one: { ...unsaved, model: { ...unsaved.model, unsaved: { count: 1, text: "Recovered text" } }, expect: ["Recovered text"] },
  disabled_reapply: { ...unsaved, actions: [{ tag: "file.reapply" as const, label: "Reapply", args: { path: unsaved.model.path }, disabled: { reason: "Reconnect first" }, primary: true }] },
}
export const stories: ViewStory[] = Object.entries(fileStories).map(([name, story]) => ({ name, expect: story.expect, actions: story.actions, interactions: story.model.unsaved ? [{ selector: ".code-notice button:not([data-flow])", action: null }] : [], render: (callbacks, actions) => <FilePresenceView {...story} actions={(actions as CodeEditorViewProps["actions"]) ?? story.actions} {...callbacks} /> }))
