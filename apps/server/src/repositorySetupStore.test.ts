import { expect, test } from "bun:test"
import { BudgetTokensSchema, SetupDraftSchema } from "@smthrs/rpc/RepositorySetup"
import { SetupPlanSchema } from "./repositorySetupStore"

// The registry stamps repository/setup with the deployment's whole budget
// (flows/repository/inspection.ts deploymentMinutes and deploymentTokens,
// which the setup draft's bounds mirror); a plan carrying it is accepted and
// one past it is refused (smithersai/smithers#2175).
const plan = (tokens: number, milliseconds: number) => ({
  planId: "plan-1", flowId: "repository/setup", digest: "d", executionDigest: "e",
  envelope: { capabilities: ["repository:read"], flows: ["repository/setup"], budget: { tokens, milliseconds } }
})
const tokens = BudgetTokensSchema.maxValue!
const milliseconds = SetupDraftSchema.shape.budgetMinutes.maxValue! * 60_000

test("a setup plan carrying the deployment's whole budget is accepted", () => {
  expect(milliseconds).toBe(21_600_000)
  expect(SetupPlanSchema.safeParse(plan(tokens, milliseconds)).success).toBe(true)
})

test("a setup plan past the deployment's budget is refused", () => {
  expect(SetupPlanSchema.safeParse(plan(tokens, milliseconds + 1)).success).toBe(false)
  expect(SetupPlanSchema.safeParse(plan(tokens + 1, milliseconds)).success).toBe(false)
})
