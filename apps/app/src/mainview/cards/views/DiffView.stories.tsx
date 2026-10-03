import { fixtures } from "@smthrs/rpc/fixtures/Diff"
import type { DiffViewProps } from "@smthrs/rpc/DiffCard"
import { DiffView } from "./DiffView"
import type { ViewStory } from "./stories"
export const diffStories = {
  ...fixtures,
  multiple_hunks: { ...fixtures.item_base, expect: ["one", "same", "old"], model: { ...fixtures.item_base.model, path: "x.ts", hunks: [
    { old_start: 0, new_start: 1, lines: [{ op: "+" as const, text: "one" }] },
    { old_start: 4, new_start: 5, lines: [{ op: " " as const, text: "same" }, { op: "-" as const, text: "old" }] },
  ] } },
  hostile: { ...fixtures.fork, expect: ['<script>alert("diff")</script>', '$(touch /tmp/never)'], model: { ...fixtures.fork.model, hunks: [{ old_start: 0, new_start: 1, lines: [{ op: "+" as const, text: '<script>alert("diff")</script>' }, { op: "+" as const, text: '$(touch /tmp/never)' }] }] } },
}
export const stories: ViewStory[] = Object.entries(diffStories).map(([name, story]) => ({
  name, expect: story.expect, actions: story.actions,
  render: (callbacks, actions = story.actions) => <DiffView {...story} actions={actions as DiffViewProps["actions"]} {...callbacks} />,
}))
