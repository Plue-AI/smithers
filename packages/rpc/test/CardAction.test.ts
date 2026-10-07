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
