import { fixtures } from "@smthrs/rpc/fixtures/Branch"
import { BranchView } from "./BranchView"
import type { ViewStory } from "./stories"
export const stories: ViewStory[] = Object.entries(fixtures).flatMap(([key, fixture]) => (key === "active" ? ["activity", "files", "terminals"] : ["activity"]).map(tab => ({
  name: `branch-${key}-${tab}`,
  expect: tab === "activity" ? fixture.expect.filter(text => text !== "Checks" && text !== "flows/todo/instructions/implementer.md") : [fixture.model.name],
  actions: fixture.actions,
  render: (callbacks, allowed = fixture.actions) => <BranchView {...fixture} {...callbacks} actions={fixture.actions.filter(action => allowed.some(value => value.tag === action.tag && value.label === action.label))} view={{ ...fixture.view, tab }} />,
})))
