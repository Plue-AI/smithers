import { fixtures } from "@smthrs/rpc/fixtures/Flow"
import type { FlowViewProps } from "@smthrs/rpc/FlowCard"
import { FlowView } from "./FlowView"

export const flowStories = {
  ...fixtures,
  proposed_selected: { ...fixtures.proposed, model: { ...fixtures.proposed.model, versions: [fixtures.proposed.model.versions[1]!] } },
  merged_failed_selected: { ...fixtures.merged_failed, model: { ...fixtures.merged_failed.model, versions: [fixtures.merged_failed.model.versions[0]!] } },
  previous_selected: { ...fixtures.previous, model: { ...fixtures.previous.model, versions: [fixtures.previous.model.versions[1]!] }, expect: ["Previous", "Run"] },
  disabled: { ...fixtures.active, actions: [{ tag: "flow.run" as const, label: "Run", disabled: { reason: "No machine available" } }], expect: ["No machine available"] },
  no_actions: { ...fixtures.active, actions: [], expect: ["Implement", "planner"] },
  added_false: { ...fixtures.repository, model: { ...fixtures.repository.model, versions: [{ id: "v1", state: "active" as const, steps: [{ id: "run", label: "Run checks", added: false }] }] } }
}
// Proposed fixture includes both versions: exercise the local selection in the shared harness.
export const stories: import("./stories").ViewStory[] = Object.entries(flowStories).map(([name, story]) => ({
  name, actions: story.actions, interactions: story.model.versions.map((_version, index) => ({ selector: `.mvp-version:nth-child(${index + 1})` })), expect: story.expect,
  render: (callbacks, actions = story.actions) => <FlowView {...story} actions={actions as FlowViewProps["actions"]} {...callbacks} />
}))
