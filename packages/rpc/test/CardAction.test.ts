import { expect, it } from "vitest"
import { ActionSchema, BranchForkInputSchema } from "../src/CardAction.ts"

it("retains primary action metadata and rejects unknown commands", () => {
  const action = { tag: "todo.resume", label: "Resume", args: { n: "3" }, primary: true }
  expect(ActionSchema.parse(action)).toEqual(action)
  expect(ActionSchema.safeParse({ ...action, tag: "unknown" }).success).toBe(false)
})

it("fork sources admit canonical scratch branches alongside main and TODOs", () => {
 for (const from of ["main", "T2", "scratch/ben/try"]) expect(BranchForkInputSchema.parse({from})).toEqual({from})
 for (const from of ["", "T0", "scratch/ben", "scratch/ben/../try", "refs/heads/main"]) expect(BranchForkInputSchema.safeParse({from}).success).toBe(false)
})


it("persisted Settings actions decode their operation without registering another door", () => {
  const saved = ActionSchema.parse({ tag: "settings.parallel", label: "At once", args: { field: "parallel", min: "1", max: "8" } })
  expect(saved).toEqual({ tag: "settings", label: "At once", args: { operation: "parallel", field: "parallel", min: "1", max: "8" } })
})


it("saved context inspection is data decoded to the current inspection command", () => {
  expect(ActionSchema.parse({ tag: "context.inspect", label: "Inspect", args: { branch: "T12", answer: "answer-12" } })).toEqual({ tag: "run.inspect", label: "Inspect", args: { branch: "T12", answer: "answer-12" } })
})


it("saved secret controls retain their operation and discard private values", () => {
  for (const operation of ["set", "scope", "delete", "bind"]) {
    const saved = ActionSchema.parse({ tag: `secrets.${operation}`, label: "Saved", args: { name: "KEY", value: "private", key: "private", token: "private", ...(operation === "scope" ? { scope: "all" } : {}) } })
    expect(saved).toEqual({ tag: "secrets", label: "Saved", args: { name: "KEY", operation, ...(operation === "scope" ? { scope: "all_branches" } : {}) } })
  }
})


it("saved GitHub controls retain their operation on the canonical door", () => {
  for (const [tag, operation] of [["github.retry", "retry"], ["github.app", "app-status"], ["github.app.open", "app-open"], ["github.app.choose", "app-choose"], ["github.reconcile", "reconcile"]]) {
    expect(ActionSchema.parse({ tag, label: "Saved", args: { repo: "owner/repo" } })).toEqual({ tag: "github", label: "Saved", args: { repo: "owner/repo", operation } })
  }
})


it("saved Runs actions retain operation and source without another door", () => {
  for (const [tag, operation] of [["approvals.list", "approval-list"], ["approvals.open", "approval-open"], ["runs.attention", "attention"]]) {
    expect(ActionSchema.parse({ tag, label: "Saved", args: { sourceCard: "private-run", runId: "run-1" } })).toEqual({ tag: "runs", label: "Saved", args: { sourceCard: "private-run", runId: "run-1", operation } })
  }
})

it("saved repository file actions keep their source and revision without an executable alias", () => {
  const args = { path: "src/answer.ts", repo: "owner/repo", ref: "abc", line: "3" }
  expect(ActionSchema.parse({ tag: "files.read", label: "Open", args })).toEqual({ tag: "file", label: "Open", args: { ...args, operation: "repository" } })
})

it("saved directory and workspace actions retain scope on canonical file doors", () => {
 for (const [tag, current, operation, args] of [
  ["files.list", "files", "repository", { path: "src", repo: "owner/repo" }],
  ["box.files", "files", "workspace", { path: "src", workspaceId: "ws-1" }],
  ["box.file", "file", "workspace", { path: "src/answer.ts", workspaceId: "ws-1" }],
  ["repo.tree", "files", "tree", { copy: "ws-1", path: "src" }]
 ] as const) expect(ActionSchema.parse({ tag, label: "Open", args })).toEqual({ tag: current, label: "Open", args: { ...args, operation } })
})


it.each([
  ["change.view", "change", { changeId: "ch-1", rev: "3" }],
  ["change.diff", "change-diff", { changeId: "ch-1", from: "parent", to: "3", path: "src/my notes.md" }],
  ["change.pins", "pins", { changeId: "ch-1", from: "2", to: "current" }],
  ["change.checks", "checks", { changeId: "ch-1", seq: "3" }],
  ["files.open-diff", "file", { cardId: "frame-1", path: "src/my notes.md" }]
])("recorded Diff controls retain their explicit targets: %s", (tag, operation, args) => {
  expect(ActionSchema.parse({ tag, label: "Open", args })).toMatchObject({ tag: "diff", args: { ...args, operation } })
})

it("recorded run lifecycle actions retain explicit targets without another executable tag", () => {
  for (const [tag, args, operation] of [
    ["flow.run.stop", { cardId: "run-1", reason: "original reason" }, "stop"],
    ["flow.run.retry", { cardId: "request-1" }, "retry"],
    ["flow.run.stop-all", { repo: "owner/repo", sourceCard: "list-1" }, "stop-all"]
  ] as const) expect(ActionSchema.parse({ tag, args, label: "Run" })).toEqual({ tag: "flow.run", args: { ...args, operation }, label: "Run" })
})

it("recorded workspace actions retain recovery identity through canonical branches", () => {
  for (const [tag, args, target, operation] of [
    ["box.open", { repo: "owner/repo", snapshot: "snap", recoveryOf: "original", kind: "vm" }, "branch", "workspace-open"],
    ["box.view", { workspaceId: "original" }, "branch", "workspace-view"],
    ["box.list", { repo: "owner/repo" }, "branches", "workspace"]
  ] as const) expect(ActionSchema.parse({ tag, args, label: "Branch" })).toEqual({ tag: target, args: { ...args, operation }, label: "Branch" })
})
