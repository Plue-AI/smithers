import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { decodeLiveReserved, LiveReplySchema, LiveRequestSchema } from "../src/Live.ts"
import { fixtures } from "./fixtures/Live.ts"

test.each(fixtures)("decodes committed record %s", (raw) => {
  const record = JSON.parse(raw)
  const schema = record.t === "sub" || record.t === "unsub" ? LiveRequestSchema : LiveReplySchema
  expect(schema.parse(record)).toEqual(record)
  expect(schema.parse(JSON.parse(JSON.stringify(schema.parse(record))))).toEqual(record)
})
test("reserved frames retain the subscription id", () => {
  for (const raw of [{ t: "presence", id: 7 }, new Uint8Array([1, 0, 0, 0, 7]), new Uint8Array([2, 0, 0, 0, 7])]) {
    expect(decodeLiveReserved(raw)).toEqual({ t: "err", id: 7, code: "unsupported" })
  }
  expect(() => decodeLiveReserved(new Uint8Array([3, 0, 0, 0, 7]))).toThrow()
})
test("invalid discriminator, cursor and payload are refused", () => {
  for (
    const raw of [{ t: "other", id: 7 }, { t: "snap", id: 7, cursor: 1 }, { t: "delta", id: 7, cursor: -1, data: {} }]
  ) expect(LiveReplySchema.safeParse(raw).success).toBe(false)
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  expect(pkg.exports["."]).toBeUndefined()
  expect(pkg.exports["./*"].default).toBe("./src/*.ts")
})
