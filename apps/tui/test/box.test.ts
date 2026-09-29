import { afterEach, expect, setSystemTime, test } from "bun:test"
import * as Box from "../src/box.ts"

afterEach(() => {
  setSystemTime()
})

test("reuses one workspace grant for a while, asks again after, and never keeps a refusal", async () => {
  const asked: Array<string> = []
  let refuse = false
  const box = Box.workspace({ SMITHERS_TOKEN: "t" }, "acme/app/ws-1", (_environment, reference) => {
    asked.push(reference)
    return refuse ? Promise.reject(new Error("503")) : Promise.resolve(["ssh", `grant-${asked.length}@gateway`])
  })
  setSystemTime(new Date(1_000_000))
  expect(await box.prefix()).toEqual(["ssh", "grant-1@gateway"])
  setSystemTime(new Date(1_000_000 + Box.grantMs))
  expect(await box.prefix()).toEqual(["ssh", "grant-1@gateway"])
  setSystemTime(new Date(1_000_000 + Box.grantMs + 1))
  expect(await box.prefix()).toEqual(["ssh", "grant-2@gateway"])
  expect(asked).toEqual(["acme/app/ws-1", "acme/app/ws-1"])

  setSystemTime(new Date(2_000_000))
  refuse = true
  await expect(box.prefix()).rejects.toThrow("503")
  refuse = false
  expect(await box.prefix()).toEqual(["ssh", "grant-4@gateway"])
  expect(box).toMatchObject({ name: "acme/app/ws-1", workdir: "/home/developer/workspace" })
})
