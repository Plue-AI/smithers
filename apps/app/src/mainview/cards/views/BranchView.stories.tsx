import { fixtures } from "@smthrs/rpc/fixtures/Branch"
import { BranchView } from "./BranchView"
import type { ViewStory } from "./stories"

export const stories: ViewStory[] = Object.entries(fixtures).map(([key, fixture]) => {
  const tab = "tab" in fixture.view ? fixture.view.tab : "activity"
  return {
    name: `branch-${key.replace(/_(files|terminals)$/, "")}-${tab}`,
    expect: fixture.expect,
    actions: fixture.actions,
    render: (callbacks, allowed = fixture.actions) => <BranchView
      {...fixture}
      {...callbacks}
      actions={fixture.actions.filter(action => allowed.some(value => value.tag === action.tag && value.label === action.label))}
      view={{ ...fixture.view, tab }}
    />,
  }
})
