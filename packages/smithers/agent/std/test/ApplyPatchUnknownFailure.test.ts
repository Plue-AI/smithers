/**
 * The apply_patch tool result is the sentence a model reads. A parser or
 * applier failure it did not design must not reach that result as raw text.
 *
 * The parser and applier are pure and throw only their tagged errors, so the
 * only way to reach the unknown branch is to replace them: this file mocks the
 * internal module to throw a plain error carrying private text.
 */
import { Cause, Effect, Exit, Option } from "effect"
import { describe, expect, it, vi } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import { layer } from "./TestLayers.ts"

const hooks = vi.hoisted(() => ({
  parse: undefined as undefined | (() => never),
  derive: undefined as undefined | (() => never)
}))

vi.mock("../src/internal/ApplyPatch.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/internal/ApplyPatch.ts")>()
  return {
    ...original,
    parsePatch: (patch: string) => hooks.parse === undefined ? original.parsePatch(patch) : hooks.parse(),
    deriveNewContents: (...args: Parameters<typeof original.deriveNewContents>) =>
      hooks.derive === undefined ? original.deriveNewContents(...args) : hooks.derive()
  }
})

const failureOf = async (input: string, files: Record<string, string> = {}) => {
  const exit = await Effect.runPromiseExit(Effect.provide(ApplyPatch.run({ input }), layer({ files })))
  expect(Exit.isFailure(exit)).toBe(true)
  return Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
}

describe("apply_patch unknown failures", () => {
  it("answers an unexpected parser throw with the generic sentence, not its text", async () => {
    hooks.parse = () => {
      throw new TypeError("private parser state /home/secret")
    }
    try {
      const failure = await failureOf("anything")
      expect(failure).toMatchObject({
        code: "command_failed",
        message: "Something went wrong on our side. Not your fault."
      })
      expect(JSON.stringify(failure)).not.toContain("secret")
    } finally {
      hooks.parse = undefined
    }
  })

  it("answers an unexpected applier throw with the generic sentence and the path", async () => {
    hooks.derive = () => {
      throw new RangeError("private applier state /home/secret")
    }
    try {
      const failure = await failureOf(
        "*** Begin Patch\n*** Update File: /a.txt\n@@\n-old\n+new\n*** End Patch",
        { "/a.txt": "old\n" }
      )
      expect(failure).toMatchObject({
        code: "command_failed",
        message: "Something went wrong on our side. Not your fault.",
        path: "/a.txt"
      })
      expect(JSON.stringify(failure)).not.toContain("secret")
    } finally {
      hooks.derive = undefined
    }
  })
})
