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

// Reuse the Branch fixtures for boundary states; no second model or schema.
const active = fixtures.active
stories.push(
  {
    name: "branch-asking",
    expect: ["Asks", "Use existing retry helper?"],
    actions: active.actions,
    render: (callbacks, allowed = active.actions) => <BranchView {...active} {...callbacks}
      actions={active.actions.filter(action => allowed.some(value => value.tag === action.tag && value.label === action.label))}
      model={{ ...active.model, activity: [...active.model.activity,
        { ...active.model.activity[2]!, id: "question-2", text: "Use existing retry helper?" }], }} />,
  },
  {
    name: "branch-active-maximized",
    expect: ["Implement card projections", "Asked", "Answer", "Steer"],
    actions: active.actions,
    render: (callbacks, allowed = active.actions) => <BranchView {...active} {...callbacks}
      actions={active.actions.filter(action => allowed.some(value => value.tag === action.tag && value.label === action.label))}
      view={{ maximized: true, tab: "activity" }} />,
  },
  {
    name: "branch-no-actions",
    expect: ["flows/todo/flow.ts:12", "watching Implement"],
    actions: [],
    render: callbacks => <BranchView {...active} {...callbacks} actions={[]} gestures={{}}
      model={{ ...active.model, activity: active.model.activity.map(entry => ({ ...entry, actions: [] })) }} />,
  },
  {
    name: "branch-disabled-gestures",
    expect: ["Access refused"],
    actions: [],
    render: callbacks => <BranchView {...active} {...callbacks} actions={[]}
      model={{ ...active.model, activity: [] }} gestures={{
        item: { tag: "todo", label: "Open TODO", disabled: { reason: "Access refused" } },
        file: { tag: "file", label: "Open file", disabled: { reason: "Access refused" } },
        terminal: { tag: "terminal.watch", label: "Watch", disabled: { reason: "Access refused" } },
      }} />,
  },
  {
    name: "branch-hostile",
    expect: ['<script>window.__branchPwned=1</script><img src=x onerror="window.__branchPwned=1">'],
    actions: [],
    render: callbacks => {
      const hostile = '<script>window.__branchPwned=1</script><img src=x onerror="window.__branchPwned=1">'
      return <BranchView {...active} {...callbacks} actions={[]} gestures={{}} model={{ ...active.model,
        name: hostile, presence: [{ ...active.model.presence[0]!, where: { kind: "file", path: hostile } }],
        activity: [{ ...active.model.activity[0]!, text: hostile, actions: [] }],
        changed_files: [{ path: hostile, change: "added", authors: [] }],
      }} />
    },
  },
)
