import { expect, test } from "bun:test"
import { buildStampValues } from "./build-stamp"

test("release stamps use source time and refuse malformed reproducibility inputs", () => {
  const previous = process.env.SOURCE_DATE_EPOCH
  try {
    for (const epoch of ["0", "1791072000"]) {
      process.env.SOURCE_DATE_EPOCH = epoch
      expect(buildStampValues().builtAt).toBe(new Date(Number(epoch) * 1000).toISOString())
    }
    for (const epoch of ["", "-1", "1.5", "NaN", "8640000000001"]) {
      process.env.SOURCE_DATE_EPOCH = epoch
      expect(() => buildStampValues()).toThrow("Invalid SOURCE_DATE_EPOCH")
    }
    delete process.env.SOURCE_DATE_EPOCH
    expect(Date.now() - Date.parse(buildStampValues().builtAt)).toBeLessThan(1000)
  } finally {
    if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH
    else process.env.SOURCE_DATE_EPOCH = previous
  }
})
