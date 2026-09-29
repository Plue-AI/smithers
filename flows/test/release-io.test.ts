import assert from "node:assert/strict"
import { test } from "node:test"
import { commandRunner } from "../release-support/io.ts"
import { ReleaseError } from "../release-support/schema.ts"

// A real child splits one UTF-8 character across two pipe writes 100 ms apart,
// so the parent receives the bytes in separate chunks (#2697).
const splitEmoji = (stream: "stdout" | "stderr", exitCode: number) => `
const bytes = Buffer.from("a\u{1F600}b")
process.${stream}.write(bytes.subarray(0, 3))
setTimeout(() => {
  process.${stream}.write(bytes.subarray(3))
  process.exitCode = ${exitCode}
}, 100)
`

test("commandRunner decodes UTF-8 split across stdout chunks", async () => {
  const out = await commandRunner(import.meta.dirname)(process.execPath, ["-e", splitEmoji("stdout", 0)])
  assert.equal(out, "a\u{1F600}b")
  assert.ok(!out.includes("\uFFFD"))
})

test("commandRunner decodes UTF-8 split across stderr chunks", async () => {
  await assert.rejects(
    commandRunner(import.meta.dirname)(process.execPath, ["-e", splitEmoji("stderr", 3)]),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseError)
      assert.match(error.message, /exited 3/)
      assert.ok(error.message.includes("a\u{1F600}b"))
      assert.ok(!error.message.includes("\uFFFD"))
      return true
    }
  )
})

test("commandRunner returns ordinary output unchanged", async () => {
  const out = await commandRunner(import.meta.dirname)(process.execPath, [
    "-e",
    "process.stdout.write('plain ascii\\nline two\\n')"
  ])
  assert.equal(out, "plain ascii\nline two\n")
})
