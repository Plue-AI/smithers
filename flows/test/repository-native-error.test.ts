import { Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { NativeCodingError } from "../coding/native-schema.ts"
import { retainedStepError } from "../repository/jobs.ts"

test("a native file conflict retains its validated recovery receipt in the durable step result", () => {
  const recovery = {
    requestId: "11111111-1111-4111-8111-111111111111",
    path: "/private/workspace-recovery/request",
    files: [{
      path: "source.ts",
      preimage: "/private/workspace-recovery/request/preimage",
      proposed: "/private/workspace-recovery/request/proposed"
    }]
  }
  const error = new NativeCodingError({
    code: "file_conflict",
    message: "The original file changed; retained copies are available",
    recovery
  })
  const value = Schema.decodeUnknownSync(Schema.Json)(retainedStepError(error))
  assert.deepEqual(value, { _tag: "coding/NativeCodingError", code: error.code, message: error.message, recovery })
  for (
    const failure of [{ code: "file_conflict", recovery: { ...recovery, files: "invalid" } }, {
      code: "provider",
      recovery
    }]
  ) {
    assert(!Object.hasOwn(retainedStepError(failure) as object, "recovery"))
  }
})
