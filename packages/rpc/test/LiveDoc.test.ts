import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { decodeLiveDocBinary, encodeLiveDocBinary, LiveDocReply, LiveDocWriteRefusal, parseLiveDocTopic } from "../src/LiveDoc.ts"
import { LiveDocRelay } from "../src/testing/LiveDocRelay.ts"

const root = new URL("../../backend/internal/compose/testdata/cocontracts/", import.meta.url)
const fixture = readFileSync(new URL("doc-browser.json", root))
const golden = JSON.parse(fixture.toString()) as { frames: (string | number[])[] }

describe("document browser contract", () => {
  test("literal frames replay unchanged across reconnect", () => {
    const relay = new LiveDocRelay(golden.frames)
    for (let replay = 0; replay < 2; replay++) {
      for (const frame of golden.frames) expect(relay.next()).toEqual(typeof frame === "string" ? frame : Uint8Array.from(frame))
      expect(relay.next()).toBeUndefined()
      relay.reconnect()
    }
    for (const frame of golden.frames) {
      if (typeof frame === "string") continue
      const decoded = decodeLiveDocBinary(Uint8Array.from(frame))
      expect(decoded.id).toBe(7)
      expect(encodeLiveDocBinary(decoded)).toEqual(Uint8Array.from(frame))
    }
  })
  test("reviewed pins and fixture digest", () => {
    const manifest = JSON.parse(readFileSync(new URL("MANIFEST.json", root), "utf8"))
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    expect(manifest.pins).toEqual({ yjs: "13.6.32", yrs: "0.27.4" })
    expect(pkg.dependencies.yjs).toBe("13.6.32")
    expect(createHash("sha256").update(fixture).digest("hex")).toBe(manifest.files["doc-browser.json"])
  })
  test("topics preserve branch and repository data", () => {
    expect(parseLiveDocTopic("doc:code:b:src/a:b.ts")).toEqual({ kind: "code", branch: "b", path: "src/a:b.ts" })
    expect(parseLiveDocTopic("doc:wiki:page")).toEqual({ kind: "wiki", page: "page" })
    for (const topic of ["", "doc:code::a", "doc:code:b:/a", "doc:code:b:../a", "doc:code:b:a//b", "doc:code:b:a/./b", "doc:code:b:a\\b", "doc:code:b:a\0", "doc:wiki:a:b"]) {
      expect(() => parseLiveDocTopic(topic)).toThrow()
    }
  })
  test("binary boundary, offset, kinds and subscription ids", () => {
    expect(decodeLiveDocBinary(Uint8Array.from([99, 1, 0, 0, 0, 7, 0]).subarray(1))).toEqual({ kind: 1, id: 7, payload: Uint8Array.of(0) })
    for (const bytes of [[], [1, 0, 0, 0], [3, 0, 0, 0, 7], [1, 0, 0, 0, 0]]) expect(() => decodeLiveDocBinary(Uint8Array.from(bytes))).toThrow()
    for (const id of [0, -1, 1.5, 0x100000000]) expect(() => encodeLiveDocBinary({ kind: 1, id, payload: new Uint8Array() })).toThrow()
    const atLimit = encodeLiveDocBinary({ kind: 2, id: 0xffffffff, payload: new Uint8Array(2097147) })
    expect(atLimit.length).toBe(2097152)
    expect(decodeLiveDocBinary(atLimit).id).toBe(0xffffffff)
    expect(() => encodeLiveDocBinary({ kind: 1, id: 7, payload: new Uint8Array(2097148) })).toThrow("frame_too_large")
    expect(() => decodeLiveDocBinary(new Uint8Array(2097153).fill(1))).toThrow("frame_too_large")
    expect(() => encodeLiveDocBinary({ kind: 3 as 1, id: 7, payload: new Uint8Array() })).toThrow("malformed")
  })
  test("tagged refusals and acknowledgments reject forged fields", () => {
    expect(LiveDocWriteRefusal.parse({ code: "stale", class: "conflict", message: "Changed" })).toEqual({ code: "stale", class: "conflict", message: "Changed" })
    expect(LiveDocWriteRefusal.parse({ code: "unsupported", class: "infra", message: "Unavailable" })).toEqual({ code: "unsupported", class: "infra", message: "Unavailable" })
    expect(LiveDocWriteRefusal.safeParse({ code: "stale", status: 200 }).success).toBe(false)
    expect(LiveDocReply.safeParse({ t: "saved", id: 7, sv: "!", at: "2026-10-03T12:00:00Z" }).success).toBe(false)
    const relay = new LiveDocRelay(['{"t":"err","id":7,"code":"unsupported","actor":"forged"}'])
    expect(() => relay.next()).toThrow()
    expect(() => relay.next()).toThrow()
  })
})
