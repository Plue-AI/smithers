import { fixtures } from "@smthrs/rpc/fixtures/DebugApi"
import type { DebugApiViewProps } from "@smthrs/rpc/DebugApiCard"
import { DebugApiView } from "./DebugApiView"
export const stories: import("./stories").ViewStory[] = Object.entries(fixtures).map(([name, story]) => ({
  name, actions: story.actions, expect: story.expect,
  render: (callbacks, actions = story.actions) => <DebugApiView {...story} actions={actions as DebugApiViewProps["actions"]} {...callbacks} />
}))
