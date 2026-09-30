import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** jj file show omits symlink contents; read the root-to-tree diff instead. */
export const symlinkBytesFromDiff = (diff: Uint8Array): Uint8Array => {
  const bytes = Buffer.from(diff)
  const lines: Array<Buffer> = []
  for (let start = 0, end = 0; end <= bytes.byteLength; end++) {
    if (end === bytes.byteLength || bytes[end] === 10) {
      lines.push(bytes.subarray(start, end))
      start = end + 1
    }
  }
  if (!lines.some((line) => line.toString() === "new file mode 120000")) {
    throw new Error("Cloud symlink export omitted symlink mode")
  }
  let hunk = false
  let count = 0
  const target: Array<Buffer> = []
  for (const line of lines) {
    if (line.subarray(0, 2).toString() === "@@") {
      hunk = true
      count++
      continue
    }
    if (!hunk) continue
    if (line[0] === 43) target.push(Buffer.concat([line.subarray(1), Buffer.from("\n")]))
    else if (line.toString() === "\\ No newline at end of file" && target.length > 0) {
      const previous = target.pop()!
      target.push(previous.subarray(0, previous.byteLength - 1))
    } else if (line.byteLength > 0) throw new Error("Cloud symlink export contains unexpected diff content")
  }
  if (count !== 1 || target.length === 0) throw new Error("Cloud symlink export omitted its target")
  return Buffer.concat(target)
}

// The host's locked Python reconstruction calls this same parser.
if (
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--decode-diff"
) {
  const { readSync } = await import("node:fs")
  try {
    const parts: Array<Buffer> = []
    let total = 0
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024)
      const count = readSync(0, chunk, 0, chunk.byteLength, null)
      if (count === 0) break
      total += count
      if (total > 8 * 1024 * 1024 + 64 * 1024) throw new Error("diff limit")
      parts.push(chunk.subarray(0, count))
    }
    process.stdout.write(symlinkBytesFromDiff(Buffer.concat(parts)))
  } catch {
    process.stderr.write("Cloud symlink diff is invalid\n")
    process.exitCode = 1
  }
}
