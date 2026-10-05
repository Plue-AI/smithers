// Shell stories, not a card View. T-UI-07 / C-UI-12.
import { fixtures as branches } from "@smthrs/rpc/fixtures/BranchTreeNode"
import { fixtures as entries } from "@smthrs/rpc/fixtures/EntryRow"
import { fixtures as contexts } from "@smthrs/rpc/fixtures/ContextLine"
import { BranchTree, BranchCrumbs } from "../../BranchTree"
import { EntryRow } from "../../EntryRow"
import { ContextLine } from "../../ContextLine"
import { EarlierArchive } from "../../EarlierArchive"
import type { ViewStory } from "./stories"
import type { Action } from "@smthrs/rpc/CardAction"
import type { BranchTreeNodeCard } from "@smthrs/rpc/BranchTreeNodeCard"

const entryExpect: Record<keyof typeof entries, string[]> = {
  prompt: ["Ben", "Card model contracts"], tombstone: ["Card model contracts"],
  answer: ["Smithers for Ben", "TODO cards list every open wait", "Read TodoCard.ts and the spec", "Context · 2"],
  working: ["Coding agent for Ben", "Working", "Added typed TODO fields", "Context · 1"],
  needs_you: ["Needs you", "Answer"], in_review: ["In review", "Merge"],
  failed: ["Claude Code for Ben", "Failed", "Retry", "Repository access refused"],
  event: ["Smithers", "Source ready"], done: ["Merged"], private: ["Only you", "Drop T12"],
}
// spec §14.5.2: independent literal controls, never derived from fixture action arrays.
const entryActions: Partial<Record<keyof typeof entries, ViewStory["actions"]>> = {
  needs_you: [{ tag: "todo.answer", label: "Answer", args: { n: "12" } }],
  in_review: [{ tag: "merge", label: "Merge", args: { n: "12" } }],
  failed: [{ tag: "todo.retry", label: "Retry", args: { n: "12" }, disabled: { reason: "Repository access refused" } }],
}
function withAction(node: BranchTreeNodeCard, action?: Action): BranchTreeNodeCard {
  return { ...node, action: node.action ? action : undefined, children: node.children.map(child => withAction(child, action)) }
}
const branchExpect: Record<keyof typeof branches, string[]> = {
  main: ["main", "todo/12", "scratch/repro", "Earlier · 3"], item: ["todo/12", "In review"], scratch: ["scratch/repro"], earlier: ["Earlier · 3"],
}
const navigation: Record<keyof typeof branches, ViewStory["interactions"]> = {
  main: [{ selector: '[data-node="main"]', patch: { selected_branch: "main" } }, { selector: '[data-node="todo-12"]', patch: { selected_branch: "todo-12" } }, { selector: '[data-node="earlier"]', patch: { selected_branch: "earlier" } }],
  item: [{ selector: '[data-node="todo-12"]', patch: { selected_branch: "todo-12" } }],
  scratch: [], earlier: [{ selector: '[data-node="earlier"]', patch: { selected_branch: "earlier" } }],
}
export const stories: ViewStory[] = [
  { name: "branch-disabled", expect: ["scratch/repro", "Repository access refused"], actions: [{ tag: "branch", label: "Open", args: { name: "scratch/repro" }, disabled: { reason: "Repository access refused" } }], render: ({ onAction, onView }, actions = [{ tag: "branch", label: "Open", args: { name: "scratch/repro" }, disabled: { reason: "Repository access refused" } }]) => <BranchTree nodes={[withAction(branches.scratch.model, actions[0] as Action | undefined)]} view={{}} onAction={onAction} onView={onView} /> },
  { name: "context-empty", expect: ["Context · 0"], interactions: [{ selector: ".mvp-context-toggle", patch: { expanded: true } }], render: ({ onView }) => <ContextLine count={0} items={[]} expanded={false} onView={onView} /> },
  ...Object.entries(branches).map(([name, fixture]): ViewStory => ({
    name: `branch-${name}`, expect: branchExpect[name as keyof typeof branches],
    actions: name === "main" || name === "scratch" ? [{ tag: "branch", label: "Open", args: { name: "scratch/repro" } }] : [],
    interactions: navigation[name as keyof typeof branches],
    render: ({ onAction, onView }, actions) => <BranchTree nodes={[withAction(fixture.model, (actions ?? (name === "main" || name === "scratch" ? [{ tag: "branch", label: "Open", args: { name: "scratch/repro" } }] : []))[0] as Action | undefined)]} view={{ selected_branch: "todo-12" }} onAction={onAction} onView={onView} />,
  })),
  ...Object.entries(entries).map(([name, fixture]): ViewStory => ({
    name: `entry-${name}`, expect: entryExpect[name as keyof typeof entries], actions: entryActions[name as keyof typeof entries] ?? [],
    interactions: fixture.model.context ? [{ selector: ".mvp-context-toggle" }] : [],
    render: ({ onAction }, actions) => <EntryRow {...fixture.model} action={actions?.length === 0 ? undefined : fixture.model.action} onAction={onAction} />,
  })),
  ...Object.entries(contexts).map(([name, fixture]): ViewStory => ({
    name: `context-${name}`, expect: name === "collapsed" ? ["Context · 5"] : name === "one" ? ["Context · 1", "flow.ts"] : ["Context · 5", "flow.ts", "Factory decisions", "#3474", "T12", "Implement"],
    interactions: [{ selector: ".mvp-context-toggle", patch: { expanded: name === "collapsed" } }],
    render: ({ onView }) => <ContextLine {...fixture.model} onView={onView} />,
  })),
  { name: "earlier-selected", expect: ["Earlier · 3", "Read-only", "Earlier question", "Card model contracts"],
    interactions: [{ selector: '[data-archive="old"]', patch: { selected_archive: "old" } }],
    render: ({ onView }) => <EarlierArchive model={{ node: { ...branches.earlier.model, kind: "earlier", archive_count: 3 }, read_only: true, archives: [{ id: "old", title: "Earlier question", entries: [<EntryRow key="row" {...entries.tombstone.model} onAction={() => {}} />] }] }} view={{ selected_archive: "old" }} onView={onView} /> },
  { name: "earlier-unselected", expect: ["Earlier · 0", "Read-only"], render: ({ onView }) => <EarlierArchive model={{ node: { ...branches.earlier.model, kind: "earlier", archive_count: 0 }, read_only: true, archives: [] }} view={{}} onView={onView} /> },
  { name: "crumb-ancestry", expect: ["main", "todo/12", "scratch/repro"], interactions: [{ selector: '[data-branch="main"]', patch: { selected_branch: "main" } }, { selector: '[data-branch="todo-12"]', patch: { selected_branch: "todo-12" } }, { selector: ".mvp-crumb-here" }, { selector: '[data-node="main"]', patch: { selected_branch: "main" } }, { selector: '[data-node="todo-12"]', patch: { selected_branch: "todo-12" } }, { selector: '[data-node="scratch-repro"]', action: { tag: "branch", args: { name: "scratch/repro" } } }, { selector: '[data-node="earlier"]', patch: { selected_branch: "earlier" } }], render: ({ onAction, onView }) => <BranchCrumbs nodes={[branches.main.model]} view={{ selected_branch: "scratch-repro" }} onAction={onAction} onView={onView} /> },
]
