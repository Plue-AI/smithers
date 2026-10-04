import { fixtures } from "@smthrs/rpc/fixtures/DebugApi"
import type { DebugApiViewProps } from "@smthrs/rpc/DebugApiCard"
import { DebugApiView } from "./DebugApiView"
export const stories: import("./stories").ViewStory[] = Object.entries(fixtures).map(([name, story]) => {
  const ops = story.model.operations
  const groups = [...new Set(ops.map(o => o.group))]
  return {
    name, actions: story.actions, expect: story.expect,
    interactions: groups.flatMap((g, gi) => ops.filter(o => o.group === g).map((o, oi) => ({
      selector: `nav section:nth-of-type(${gi + 1}) button:nth-of-type(${oi + 1})`, patch: { selected: o.id }
    }))),
    render: (callbacks, actions = story.actions) => <DebugApiView {...story} actions={actions as DebugApiViewProps["actions"]} {...callbacks} />
  }
})
