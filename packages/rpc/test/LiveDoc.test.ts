import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import {
  decodeLiveDocBinary,
  encodeLiveDocBinary,
  LiveDocReply,
  LiveDocAwareness,
  LiveDocWriteRefusal,
  parseLiveDocTopic
} from "../src/LiveDoc.ts"
import { LiveDocRelay } from "../src/testing/LiveDocRelay.ts"

const root = new URL("../../backend/internal/compose/testdata/cocontracts/", import.meta.url)
const fixture = readFileSync(new URL("doc-browser.json", root))
const golden = JSON.parse(fixture.toString()) as { frames: (string | number[])[] }

describe("document browser contract", () => {
  test("literal frames replay unchanged across reconnect", () => {
    const relay = new LiveDocRelay(golden.frames)
    for (let replay = 0; replay < 2; replay++) {
      for (const frame of golden.frames) {
        expect(relay.next()).toEqual(typeof frame === "string" ? frame : Uint8Array.from(frame))
      }
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
    expect(manifest.pins).toEqual({ yjs: "13.6.32", yrs: "=0.27.4" })
    expect(pkg.dependencies.yjs).toBe("13.6.32")
    expect(createHash("sha256").update(fixture).digest("hex")).toBe(manifest.files["doc-browser.json"])
    for (const [name, digest] of Object.entries(manifest.files)) {
      expect(createHash("sha256").update(readFileSync(new URL(name, root))).digest("hex")).toBe(digest)
    }
    const daemon = JSON.parse(readFileSync(new URL("doc-daemon.json", root), "utf8"))
    for (const frame of daemon.frames) {
      expect(readFileSync(new URL(`doc-${frame.name}.bin`, root)).toString("hex")).toBe(frame.hex)
    }
  })
  test("topics preserve branch and repository data", () => {
    expect(parseLiveDocTopic("doc:code:b:src/a:b.ts")).toEqual({ kind: "code", branch: "b", path: "src/a:b.ts" })
    expect(parseLiveDocTopic("doc:wiki:page")).toEqual({ kind: "wiki", page: "page" })
    for (
      const topic of [
        "",
        "doc:code::a",
        "doc:code:b:/a",
        "doc:code:b:../a",
        "doc:code:b:a//b",
        "doc:code:b:a/./b",
        "doc:code:b:a\\b",
        "doc:code:b:a\0",
        "doc:wiki:a:b"
      ]
    ) {
      expect(() => parseLiveDocTopic(topic)).toThrow()
    }
  })
  test("binary boundary, offset, kinds and subscription ids", () => {
    expect(decodeLiveDocBinary(Uint8Array.from([99, 1, 0, 0, 0, 7, 0]).subarray(1))).toEqual({
      kind: 1,
      id: 7,
      payload: Uint8Array.of(0)
    })
    for (const bytes of [[], [1, 0, 0, 0], [3, 0, 0, 0, 7], [1, 0, 0, 0, 0]]) {
      expect(() => decodeLiveDocBinary(Uint8Array.from(bytes))).toThrow()
    }
    for (const id of [0, -1, 1.5, 0x100000000]) {
      expect(() => encodeLiveDocBinary({ kind: 1, id, payload: new Uint8Array() })).toThrow()
    }
    const atLimit = encodeLiveDocBinary({ kind: 2, id: 0xffffffff, payload: new Uint8Array(2097147) })
    expect(atLimit.length).toBe(2097152)
    expect(decodeLiveDocBinary(atLimit).id).toBe(0xffffffff)
    expect(() => encodeLiveDocBinary({ kind: 1, id: 7, payload: new Uint8Array(2097148) })).toThrow("frame_too_large")
    expect(() => decodeLiveDocBinary(new Uint8Array(2097153).fill(1))).toThrow("frame_too_large")
    expect(() => encodeLiveDocBinary({ kind: 3 as 1, id: 7, payload: new Uint8Array() })).toThrow("malformed")
  })
  test("binary failures carry stable tags and codes", () => {
    const failures = [
      () => decodeLiveDocBinary(new Uint8Array(4)),
      () => decodeLiveDocBinary(Uint8Array.of(3, 0, 0, 0, 7)),
      () => encodeLiveDocBinary({ kind: 3 as 1, id: 7, payload: new Uint8Array() }),
      () => decodeLiveDocBinary(new Uint8Array(2097153).fill(1)),
      () => encodeLiveDocBinary({ kind: 1, id: 7, payload: new Uint8Array(2097148) })
    ]
    for (const [index, fail] of failures.entries()) {
      expect(fail).toThrow(expect.objectContaining({
        _tag: "LiveDocBinaryRejected",
        code: index < 3 ? "malformed" : "frame_too_large"
      }))
    }
  })
  test("tagged refusals and acknowledgments reject forged fields", () => {
    expect(LiveDocWriteRefusal.parse({ code: "stale", class: "conflict", message: "Changed" })).toEqual({
      code: "stale",
      class: "conflict",
      message: "Changed"
    })
    expect(LiveDocWriteRefusal.parse({ code: "unsupported", class: "infra", message: "Unavailable" })).toEqual({
      code: "unsupported",
      class: "infra",
      message: "Unavailable"
    })
    expect(LiveDocWriteRefusal.safeParse({ code: "stale", status: 200 }).success).toBe(false)
    expect(LiveDocReply.safeParse({ t: "saved", id: 7, sv: "!", seq: 1 }).success).toBe(false)
    const relay = new LiveDocRelay(["{\"t\":\"err\",\"id\":7,\"code\":\"unsupported\",\"actor\":\"forged\"}"])
    expect(() => relay.next()).toThrow()
    expect(() => relay.next()).toThrow()
  })
})


test("sequence receipts and outside/gone envelopes are strict", () => {
  const by = { id: "ben", kind: "person", member_id: "ben", via: "ssh" }
  for (const seq of [0, 1, Number.MAX_SAFE_INTEGER]) {
    expect(LiveDocReply.parse({ t: "saved", id: 7, sv: "AA==", seq })).toEqual({ t: "saved", id: 7, sv: "AA==", seq })
  }
  for (const seq of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(LiveDocReply.safeParse({ t: "saved", id: 7, sv: "AA==", seq }).success).toBe(false)
  }
  for (const frame of [
    { t: "outside", id: 7, data: { version: "burst-1", by } },
    { t: "gone", id: 7, data: { kind: "deleted", by } },
    { t: "gone", id: 7, data: { kind: "renamed", by, to: "src/new.ts" } }
  ]) {
    const relay = new LiveDocRelay([JSON.stringify(frame)])
    expect(JSON.parse(relay.next() as string)).toEqual(frame)
  }
  for (const data of [{ kind: "renamed", by }, { kind: "deleted", by, to: "a" }, { deleted: true, by },
    { kind: "renamed", by, to: "../escape" }]) {
    expect(LiveDocReply.safeParse({ t: "gone", id: 7, data }).success).toBe(false)
  }
})

test("fake host stamps awareness identity and colour while preserving relative selections", () => {
  const actor = { id: "alice", kind: "person", member_id: "alice", via: "app" } as const
  const principal = { actor, colour: "#336699" }
  const position = { tname: "content", item: { client: 42, clock: 0 }, assoc: -1 }
  const relay = new LiveDocRelay([])
  expect(relay.awareness({ actor: { id: "forged" }, colour: "red", line: 2, anchor: position, head: position }, principal))
    .toEqual({ actor, colour: "#336699", line: 2, anchor: position, head: position })
  expect(relay.awareness({ line: 1 }, principal)).toEqual({ ...principal, line: 1 })
  for (const line of [0, -1, 1.5]) expect(() => relay.awareness({ line }, principal)).toThrow()
  expect(LiveDocAwareness.safeParse({ ...principal, line: 1, head: { item: { client: -1, clock: 0 } } }).success).toBe(false)
})

test("document display references reject malformed keys and actors", () => {
 const actor = {kind:"person",login:"ben",name:"Ben",avatar_url:"https://example.com/ben.svg",color_index:0}
 const key = "0123456789abcdef0123456789abcdef"
 const frame = {t:"authors",id:7,data:{[key]:actor,outside:{kind:"outside",color_index:7}}}
 expect(LiveDocReply.parse(frame)).toEqual(frame)
 expect(LiveDocReply.safeParse({...frame,data:{forged:actor}}).success).toBe(false)
 expect(LiveDocReply.safeParse({...frame,data:{[key]:{kind:"person",id:"forged"}}}).success).toBe(false)
 expect(LiveDocReply.safeParse({...frame,data:{[key]:{...actor,color_index:9}}}).success).toBe(false)
})
