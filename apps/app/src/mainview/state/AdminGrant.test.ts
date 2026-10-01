import { expect, test } from "bun:test"
import { adminGrantReceipt, AdminGrantRequestSchema } from "./AdminGrant"

const request = { login: "octocat", amountUsd: 25, operationKey: "grant-1" }
const receipt = { ...request, granted: true as const, grantId: "credit-grant:123", duplicate: false }

test("grant input normalizes the login and requires bounded exact credit amounts", () => {
  expect(AdminGrantRequestSchema.parse({ ...request, login: " OCTOCAT " })).toEqual(request)
  for (const amountUsd of [1e-9, 0.1, 25, 9223372036]) {
    expect(AdminGrantRequestSchema.safeParse({ ...request, amountUsd }).success).toBe(true)
  }
  for (const amountUsd of [0, -1, NaN, Infinity, 1e-10, 0.0000000011, 9223372037, 1e10 + 1]) {
    expect(AdminGrantRequestSchema.safeParse({ ...request, amountUsd }).success).toBe(false)
  }
  for (
    const patch of [{ login: " " }, { login: "x".repeat(256) }, { operationKey: "" }, { operationKey: "../x" }, {
      operationKey: "a".repeat(129)
    }, { admin: true }]
  ) {
    expect(AdminGrantRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false)
  }
})

test("only a complete matching committed grant receipt can settle the card", () => {
  expect(adminGrantReceipt(request, receipt, 200)).toEqual(receipt)
  expect(adminGrantReceipt(request, { ...receipt, duplicate: true }, 200)?.duplicate).toBe(true)
  for (
    const body of [
      undefined,
      null,
      {},
      { granted: true },
      { ...receipt, granted: false },
      { ...receipt, grantId: "admin:1" },
      { ...receipt, grantId: "credit-grant:0" },
      { ...receipt, login: "OCTOCAT" },
      { ...receipt, login: "other" },
      { ...receipt, amountUsd: 24 },
      { ...receipt, operationKey: "grant-2" },
      { ...receipt, duplicate: "true" },
      { ...receipt, extra: true }
    ]
  ) {
    expect(adminGrantReceipt(request, body, 200)).toBeUndefined()
  }
  for (const status of [201, 202, 204, 400]) expect(adminGrantReceipt(request, receipt, status)).toBeUndefined()
  expect(adminGrantReceipt(request, { ...receipt, duplicate: true }, 201)).toBeUndefined()
})
