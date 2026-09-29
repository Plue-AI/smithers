import { expect, test } from "bun:test"
import { assertRetainedSource, isPlueImportMode, RETAINED_GITHUB_ID, RETAINED_GITHUB_SOURCE } from "../repositories-github/reusable-source"

test("refuses a source that is not the registered retained fixture", () => {
  expect(() => assertRetainedSource("codeplanesmithers/other", RETAINED_GITHUB_ID)).toThrow()
  expect(() => assertRetainedSource(RETAINED_GITHUB_SOURCE, "1")).toThrow()
  expect(() => assertRetainedSource(RETAINED_GITHUB_SOURCE, RETAINED_GITHUB_ID)).not.toThrow()
})

test("selects the retained source only for Plue matrix modes", () => {
  for (const mode of ["web-plue", "local-plue", "native-plue"]) expect(isPlueImportMode(mode)).toBe(true)
  for (const mode of ["web-own", "local-own", "native-own", undefined]) expect(isPlueImportMode(mode)).toBe(false)
})
