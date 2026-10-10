import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { docsLabels, formatGroups } from "./lane-checks.mjs"

test("landing checks select the nearest package formatter and affected stamp", () => {
  const root = mkdtempSync(join(tmpdir(), "lane-checks-"))
  try {
    mkdirSync(join(root, "packages/a/nested"), { recursive: true })
    mkdirSync(join(root, ".smithers"))
    for (const path of ["packages/a/dprint.json", "packages/a/nested/dprint.json", "packages/a/file.ts", "packages/a/nested/file.ts"]) writeFileSync(join(root, path), "{}")
    const paths = ["packages/a/file.ts", "packages/a/nested/file.ts", "deleted.ts"]
    assert.deepEqual([...formatGroups(root, paths).keys()], [join(root, "packages/a"), join(root, "packages/a/nested")])
    writeFileSync(join(root, ".smithers/target-index.json"), JSON.stringify([{ rule: "Docs.Check", label: "//a:docs", inputs: [{ kind: "file", path: paths[0] }] }]))
    assert.deepEqual(docsLabels(root, paths), ["//a:docs"])
    assert.deepEqual(docsLabels(root, ["unrelated.ts"]), [])
    assert.deepEqual(docsLabels(root), ["//a:docs"])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
