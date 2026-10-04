import { fixtures } from "@smthrs/rpc/fixtures/DebugApi"
import type { DebugApiViewProps } from "@smthrs/rpc/DebugApiCard"
import { DebugApiView } from "./DebugApiView"
export const stories: import("./stories").ViewStory[] = Object.entries(fixtures).map(([name, story]) => ({
  name, actions: story.actions, expect: story.expect,
  interactions: [...new Set(story.model.operations.map(operation => operation.group))].flatMap(group => story.model.operations.filter(operation => operation.group === group)).map(operation => ({ selector: `nav section:nth-of-type(${[...new Set(story.model.operations.map(op => op.group))].indexOf(operation.group) + 1}) button:nth-of-type(${story.model.operations.filter(op => op.group === operation.group).indexOf(operation) + 1})`, patch: { selected: operation.id } })),
  render: (callbacks, actions = story.actions) => <DebugApiView {...story} actions={actions as DebugApiViewProps["actions"]} {...callbacks} />
}))
