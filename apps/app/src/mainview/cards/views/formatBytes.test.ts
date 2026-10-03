import { expect, test } from "bun:test"
import { formatBytes } from "./formatBytes"
test("byte counts use compact units at binary boundaries", () => {
  for (const [bytes, label] of [[0, "0 B"], [1, "1 B"], [1023, "1023 B"], [1024, "1 KB"], [1536, "1.5 KB"], [1024 ** 2 - 1, "1024 KB"], [1024 ** 2, "1 MB"], [734003200, "700 MB"], [1024 ** 3, "1 GB"], [1024 ** 4, "1 TB"], [1024 ** 5, "1 PB"], [1024 ** 6, "1024 PB"]] as const) expect(formatBytes(bytes)).toBe(label)
})

test("file and diff byte counts preserve decimal boundaries and trailing zeroes", () => {
  for (const [bytes, label] of [[0, "0 B"], [999, "999 B"], [1000, "1.0 kB"], [1024, "1.0 kB"], [1550, "1.6 kB"], [999999, "1000.0 kB"], [1000000, "1.0 MB"], [1024 ** 3, "1073.7 MB"]] as const) expect(formatBytes(bytes, "decimal")).toBe(label)
})
