import { expect, test } from "bun:test"
import { inventoryStage } from "./stage"

test("inventory stage missing fails with a typed reason", () => {
  expect(() => inventoryStage(undefined)).toThrow("inventory_stage_missing")
  expect(() => inventoryStage("")).toThrow("inventory_stage_missing")
})

test("inventory stage unknown fails with its value", () => {
  expect(() => inventoryStage("S9")).toThrow("inventory_stage_unknown: S9")
})

test("inventory stage accepts each declared stage", () => {
  expect(inventoryStage("S1")).toBe("S1")
  expect(inventoryStage("S2")).toBe("S2")
  expect(inventoryStage("S3")).toBe("S3")
})
