import assert from "node:assert/strict"
import test from "node:test"
import { symlinkBytesFromDiff } from "../cloud-symlink.ts"

test("symlink diff extraction preserves target bytes and trailing newline state", () => {
  const header =
    "diff --git a/link b/link\nnew file mode 120000\nindex 0000000..1234567\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n"
  for (
    const [suffix, expected] of [["+../target\n\\ No newline at end of file\n", "../target"], [
      "+unicode-目标\n",
      "unicode-目标\n"
    ], ["+first\n++second\n\\ No newline at end of file\n", "first\n+second"]]
  ) {
    assert.deepEqual(Buffer.from(symlinkBytesFromDiff(Buffer.from(header + suffix))), Buffer.from(expected!))
  }
  assert.throws(() => symlinkBytesFromDiff(Buffer.from("not a symlink diff")))
})

test("symlink parser refuses ambiguous, empty and malformed targets", () => {
  for (
    const suffix of [
      "",
      "@@ -0,0 +1 @@\n",
      "@@ -0,0 +1 @@\n+first\n@@ -0,0 +1 @@\n+second\n",
      "@@ -0,0 +1 @@\n-invalid\n",
      "@@ -0,0 +1 @@\n\\ No newline at end of file\n"
    ]
  ) {
    assert.throws(() => symlinkBytesFromDiff(Buffer.from("new file mode 120000\n" + suffix)))
  }
})

test("standalone symlink reader streams bounded binary-safe targets and rejects invalid input", async () => {
  const { spawn } = await import("node:child_process")
  const invoke = (data: Buffer) =>
    new Promise<{ code: number | null; out: Buffer; error: string }>((done, reject) => {
      const child = spawn(process.execPath, [
        "--experimental-strip-types",
        new URL("../cloud-symlink.ts", import.meta.url).pathname,
        "--decode-diff"
      ], { stdio: ["pipe", "pipe", "pipe"] })
      const out: Array<Buffer> = []
      let error = ""
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk: string) => error += chunk)
      child.on("error", reject)
      child.stdin.on("error", () => {})
      child.stdin.end(data)
      child.on("close", (code) => done({ code, out: Buffer.concat(out), error }))
    })
  const target = Buffer.from("../目标")
  const valid = await invoke(
    Buffer.concat([
      Buffer.from("new file mode 120000\n@@ -0,0 +1 @@\n+"),
      target,
      Buffer.from("\n\\ No newline at end of file\n")
    ])
  )
  assert.equal(valid.code, 0)
  assert.deepEqual(valid.out, target)
  assert.equal(valid.error, "")
  for (const input of [Buffer.from("invalid"), Buffer.alloc(8 * 1024 * 1024 + 65537, 120)]) {
    const invalid = await invoke(input)
    assert.equal(invalid.code, 1)
    assert.equal(invalid.out.length, 0)
    assert.equal(invalid.error, "Cloud symlink diff is invalid\n")
  }
})
