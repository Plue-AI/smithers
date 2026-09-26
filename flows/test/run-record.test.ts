import { Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { isDeepStrictEqual } from "node:util"
import { contentInput, releaseInput } from "../release-support/input.ts"
import { StoredRun } from "../release-support/schema.ts"
import { evidence } from "./fixtures.ts"

const settings = { schemaVersion: 1 as const, id: "release-content-1", model: "openai:gpt-5.6-sol", maxTokens: 250_000 }

test("run records decode through the versioned schema and compare structurally", () => {
  const stored: StoredRun = {
    ...settings,
    kind: "release-content",
    input: contentInput({ from: "v0.35.0" }, evidence.version)
  }
  const encoded = Schema.encodeSync(StoredRun)(stored)
  assert.equal(encoded.schemaVersion, 1)
  assert.deepEqual(Schema.decodeUnknownSync(StoredRun)(JSON.parse(JSON.stringify(encoded))), stored)
  // A record written before schemaVersion existed, with its keys in a different order.
  const { schemaVersion: _version, input, ...rest } = encoded
  const legacy = JSON.parse(JSON.stringify({ input: { ...input, from: input.from }, ...rest }))
  assert.notEqual(JSON.stringify(legacy), JSON.stringify(encoded))
  assert.ok(
    isDeepStrictEqual(Schema.decodeUnknownSync(StoredRun)(legacy), stored),
    "predating record reopens under the same id"
  )
  const other = { ...stored, input: contentInput({ from: "v0.34.0" }, evidence.version) }
  assert.equal(isDeepStrictEqual(Schema.decodeUnknownSync(StoredRun)(legacy), other), false)
})

test("run records reject an input that does not match their kind or an unknown version", () => {
  const release = { ...settings, kind: "release", input: releaseInput({}, evidence.version) }
  assert.equal(Schema.decodeUnknownSync(StoredRun)(release).kind, "release")
  assert.throws(() => Schema.decodeUnknownSync(StoredRun)({ ...release, kind: "release-content" }))
  assert.throws(() => Schema.decodeUnknownSync(StoredRun)({ ...release, schemaVersion: 2 }))
  assert.throws(() => Schema.decodeUnknownSync(StoredRun)({ ...release, maxTokens: 0 }))
})
