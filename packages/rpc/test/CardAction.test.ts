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
