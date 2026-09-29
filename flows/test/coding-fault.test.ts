import { Fault } from "@smthrs/flow"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { NativeCode, NativeCodingError } from "../coding/native-schema.ts"
import { CodingError } from "../coding/schema.ts"
import { DocsImportError } from "../memory/deps.ts"

const flows = fileURLToPath(new URL("..", import.meta.url))
const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? ["node_modules", "test"].includes(entry.name) ? [] : sources(join(directory, entry.name))
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [join(directory, entry.name)]
      : []
  )
const declared = sources(flows).flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/TaggedError<\w+>\((?:\s*"[^"]*"\s*)?\)\(\s*"([^"]+)"/g)].map((match) => ({
    file,
    tag: match[1]!
  }))
)

test("every tagged error the repository flows declare has a fault class", async () => {
  for (const tag of ["coding/Error", "WikiError", "ReleaseError", "register-repository/Error"]) {
    assert.ok(declared.some((entry) => entry.tag === tag), tag)
  }
  for (const file of new Set(declared.map((entry) => entry.file))) await import(pathToFileURL(file).href)
  assert.deepEqual(declared.filter((entry) => !Fault.registered().has(entry.tag)), [])
})

test("dependency docs faults distinguish declaration repair, fetch retry, and size policy", () => {
  const fault = (code: DocsImportError["code"]) =>
    Fault.of(new DocsImportError({ code, source: "docs", message: "failed" }))
  assert.deepEqual(fault("digest"), { class: "user", tag: "DocsImportError/digest" })
  assert.deepEqual(fault("fetch"), { class: "infra", tag: "DocsImportError/fetch" })
  assert.deepEqual(fault("too_large"), { class: "policy", tag: "DocsImportError/too_large" })
})

test("a decline closes the TODO and a stalled plan is replanned", () => {
  const state = { attempt: 1, seatsLeft: 0, parksLeft: 8, replans: 0, veryHard: false }
  const declined = Fault.of(new CodingError({ code: "declined", message: "already fixed" }))
  assert.deepEqual(declined, { class: "user", tag: "coding/Error/declined" })
  assert.equal(Fault.respond(declined, state), "close")
  const stalled = Fault.of(new CodingError({ code: "stalled", message: "no progress" }))
  assert.equal(stalled.class, "factory")
  assert.equal(Fault.respond(stalled, state), "replan")
  assert.equal(Fault.respond(stalled, { ...state, replans: 2 }), "very_hard")
  assert.equal(Fault.of(new CodingError({ code: "unavailable", message: "down" })).class, "dependency")
})

test("a native code with a Go twin carries the registry's verdict", () => {
  const document = JSON.parse(readFileSync(new URL("../../docs/api/failure-codes.json", import.meta.url), "utf8")) as {
    readonly codes: ReadonlyArray<{ readonly code: string; readonly fault: string }>
  }
  const go = new Map(document.codes.map((row) => [row.code, row.fault]))
  const twins = NativeCode.literals.flatMap((code) => {
    const fault = go.get(`coding_${code}`) ?? go.get(code)
    return fault === undefined ? [] : [{ code, fault }]
  })
  assert.ok(twins.length >= 10)
  for (const { code, fault } of twins) {
    assert.equal(Fault.of(new NativeCodingError({ code, message: "m" })).class, fault, code)
  }
})
