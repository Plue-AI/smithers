import { expect, test } from "bun:test"
import { assertRetainedSource, isPlueImportMode, RETAINED_GITHUB_ID, RETAINED_GITHUB_SOURCE } from "../repositories-github/reusable-source"

test("refuses a source that is not the registered retained fixture", () => {
  expect(() => assertRetainedSource("codeplanesmithers/other", RETAINED_GITHUB_ID)).toThrow()
  expect(() => assertRetainedSource(RETAINED_GITHUB_SOURCE, "1")).toThrow()
  expect(() => assertRetainedSource(RETAINED_GITHUB_SOURCE, RETAINED_GITHUB_ID)).not.toThrow()
})

test("selects the retained source only for Plue matrix modes", () => {
  for (const mode of ["web-plue", "local-plue"]) expect(isPlueImportMode(mode)).toBe(true)
  // The native modes left the matrix with the desktop app (#3387): no retired mode imports the retained source.
  for (const mode of ["web-own", "local-own", "native-own", "native-plue", undefined]) expect(isPlueImportMode(mode)).toBe(false)
})
