import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import type { ApplicationTarget, ApplicationTargetDocument } from "@smthrs/rpc/ApplicationTarget"
import { ZodError } from "zod"
import { APPLICATION_TARGET_META, loadApplicationTarget } from "./ApplicationTargetRuntime"

const PAGE = "https://owner.test"
beforeAll(() => GlobalRegistrator.register({ url: PAGE }))
afterAll(async () => { await GlobalRegistrator.unregister() })
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!(); document.head.innerHTML = "" })

const selfhost: ApplicationTargetDocument = {
  apiVersion: 1, mode: "web-selfhost", apiOrigin: "", auth: { kind: "session" }, cors: "same-origin", developerExternal: false
}
const defaultTarget: ApplicationTarget = { ...selfhost, shell: "web", ownership: "owner", launch: "none", baseUrl: "" }
const external: ApplicationTargetDocument = {
  apiVersion: 1, mode: "web-plue", apiOrigin: "https://api.plue.test", auth: { kind: "bearer" }, cors: "credentialed", developerExternal: true
}
const externalTarget: ApplicationTarget = { ...external, shell: "web", ownership: "plue", launch: "none", baseUrl: "https://api.plue.test" }
const targetDocument = (content?: string): Document => {
  const doc = document.implementation.createHTMLDocument("Runtime target")
  if (content !== undefined) {
    const meta = doc.createElement("meta")
    meta.name = APPLICATION_TARGET_META; meta.content = content; doc.head.append(meta)
  }
  return doc
}

describe("runtime application target", () => {
  test("same artifact defaults to the serving self-host origin", async () => {
    await expect(loadApplicationTarget({ document: targetDocument(), pageOrigin: PAGE })).resolves.toEqual(defaultTarget)
  })

  test("runtime metadata selects explicit external Plue without a build fork", async () => {
    await expect(loadApplicationTarget({ document: targetDocument(JSON.stringify(external)), pageOrigin: "http://localhost:5173" })).resolves.toEqual(externalTarget)
  })

  test.each(["{bad-json", "null"])("native handshake wins over unused page metadata %s", async content => {
    const native: ApplicationTargetDocument = { ...selfhost, mode: "native-own", apiOrigin: "http://127.0.0.1:4200" }
    await expect(loadApplicationTarget({ document: targetDocument(content), pageOrigin: "http://127.0.0.1:4200", native: async () => native }))
      .resolves.toEqual({ ...native, shell: "native", ownership: "owner", launch: "supervisor", baseUrl: "" })
  })
})

test.each(["", " \n\t "])("blank metadata %j is absence and uses the serving target", async content => {
  await expect(loadApplicationTarget({ document: targetDocument(content), pageOrigin: PAGE })).resolves.toEqual(defaultTarget)
})

test("metadata defaults are decoded and an equivalent serving origin is normalized", async () => {
  const meta = { apiVersion: 1, mode: "web-selfhost", apiOrigin: " HTTPS://OWNER.TEST:443/ ", auth: { kind: "token" } }
  await expect(loadApplicationTarget({ document: targetDocument(` \n${JSON.stringify(meta)}\t `), pageOrigin: PAGE }))
    .resolves.toEqual({ ...defaultTarget, apiOrigin: PAGE, auth: { kind: "token" } })
})

test("global document and serving location are used when no explicit source is supplied", async () => {
  await expect(loadApplicationTarget()).resolves.toEqual(defaultTarget)
  const meta = document.createElement("meta"); meta.name = APPLICATION_TARGET_META; meta.content = JSON.stringify(external); document.head.append(meta)
  await expect(loadApplicationTarget()).resolves.toEqual(externalTarget)
})

test("explicit document and page origin override their globals", async () => {
  const globalMeta = document.createElement("meta"); globalMeta.name = APPLICATION_TARGET_META; globalMeta.content = "{invalid"; document.head.append(globalMeta)
  const own = { ...selfhost, apiOrigin: "https://explicit.test" }
  await expect(loadApplicationTarget({ document: targetDocument(JSON.stringify(own)), pageOrigin: "https://explicit.test" }))
    .resolves.toEqual({ ...defaultTarget, apiOrigin: "https://explicit.test" })
})

test("undefined native target falls back to metadata and only absence falls back to defaults", async () => {
  let reads = 0
  const native = async () => { reads++; return undefined }
  await expect(loadApplicationTarget({ document: targetDocument(JSON.stringify(external)), pageOrigin: PAGE, native })).resolves.toEqual(externalTarget)
  await expect(loadApplicationTarget({ document: targetDocument(), pageOrigin: PAGE, native })).resolves.toEqual(defaultTarget)
  expect(reads).toBe(2)
})

test("an unresolved native handshake postpones metadata reads until the host reports no target", async () => {
  const doc = targetDocument(JSON.stringify(external)), queried = spyOn(doc, "querySelector"), gate = Promise.withResolvers<ApplicationTargetDocument | undefined>()
  cleanups.push(() => queried.mockRestore())
  let reads = 0
  const pending = loadApplicationTarget({ document: doc, pageOrigin: PAGE, native: () => { reads++; return gate.promise } })
  try {
    expect(reads).toBe(1); expect(queried.mock.calls).toEqual([])
    gate.resolve(undefined)
    await expect(pending).resolves.toEqual(externalTarget)
    expect(queried.mock.calls).toEqual([[`meta[name="${APPLICATION_TARGET_META}"]`]])
  } finally { gate.resolve(undefined); await pending.catch(() => {}) }
})

test("a rejected native handshake propagates its exact failure without silently selecting metadata", async () => {
  const doc = targetDocument(JSON.stringify(external)), queried = spyOn(doc, "querySelector"), failure = new Error("Native target unavailable")
  cleanups.push(() => queried.mockRestore())
  await expect(loadApplicationTarget({ document: doc, pageOrigin: PAGE, native: async () => { throw failure } })).rejects.toBe(failure)
  expect(queried.mock.calls).toEqual([])
})

test.each(["{bad-json", "{", "undefined"])("malformed metadata %j reports the literal JSON error", async content => {
  await expect(loadApplicationTarget({ document: targetDocument(content), pageOrigin: PAGE }))
    .rejects.toThrow(new Error("Application target metadata is not valid JSON."))
})

test.each(["null", "false", "0", "[]"])("supplied non-object metadata %s fails deployment schema validation", async content => {
  await expect(loadApplicationTarget({ document: targetDocument(content), pageOrigin: PAGE })).rejects.toBeInstanceOf(ZodError)
})

test.each([
  { name: "version", data: { ...selfhost, apiVersion: 2 } },
  { name: "unknown mode", data: { ...selfhost, mode: "future" } },
  { name: "missing auth", data: { apiVersion: 1, mode: "web-selfhost" } },
  { name: "secret field", data: { ...selfhost, token: "inert-metadata-token" } },
])("invalid $name metadata rejects instead of selecting the default target", async ({ data }) => {
  await expect(loadApplicationTarget({ document: targetDocument(JSON.stringify(data)), pageOrigin: PAGE })).rejects.toBeInstanceOf(ZodError)
})

test.each([
  { origin: "ftp://api.plue.test", message: "Application API origin must use HTTP(S)." },
  { origin: "/relative", message: "Application API origin must be an absolute HTTP(S) origin." },
  { origin: "https://api.plue.test/path", message: "Application API origin cannot contain credentials, a path, a query, or a fragment." },
])("metadata with API origin $origin preserves the target contract error", async ({ origin, message }) => {
  await expect(loadApplicationTarget({ document: targetDocument(JSON.stringify({ ...external, apiOrigin: origin })), pageOrigin: PAGE })).rejects.toThrow(new Error(message))
})

test("a valid schema with an invalid deployment topology is refused at runtime", async () => {
  await expect(loadApplicationTarget({ document: targetDocument(JSON.stringify({ ...external, developerExternal: false })), pageOrigin: PAGE }))
    .rejects.toThrow(new Error("An external web Plue origin requires developerExternal."))
})
