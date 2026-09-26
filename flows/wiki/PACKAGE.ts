/** Exact code dependencies: no cross-package globs silently expanding to nothing. */
import { Smithers as S } from "@smthrs/targets"
import project from "../../.smithers/coding-project.json" with { type: "json" }
// The page catalog is the `pages` of the coding project; each page's document and inputs invalidate the wiki.
const sourceFiles = project.pages.flatMap((page) => [page.document, ...page.inputs])
const data = [
  ...new Set([
    ...sourceFiles,
    ".smithers/coding-project.json",
    "flows/wiki/schema.ts",
    "flows/wiki/evidence.ts",
    "flows/wiki/flow.ts",
    "flows/wiki/workflow.ts",
    "flows/wiki/operations.ts",
    "flows/wiki/main.ts",
    "flows/wiki/runtime.ts",
    "flows/wiki/reuse.ts",
    "flows/wiki/jev-citations.ts",
    "flows/repository/jev-checks.ts",
    "flows/coding/schema.ts",
    "flows/release-support/runtime.ts"
  ])
].map((file) => S.file(`//${file}`))
const preview = S.Shell.Build({
  bin: S.Runtime.bin,
  args: ["--experimental-strip-types", "flows/wiki/main.ts"],
  data,
  timeout: "10m",
  outDirs: [".flows/wiki"]
})
const verify = S.Shell.Run({
  bin: S.Runtime.bin,
  args: ["--experimental-strip-types", "flows/wiki/main.ts", "--verified"],
  data,
  timeout: "30m"
})
const freshness = S.Shell.Test({
  bin: S.Runtime.bin,
  args: ["--experimental-strip-types", "flows/wiki/main.ts", "--check"],
  data: [preview, ...data],
  timeout: "5m"
})
export const Package = S.Package({ targets: { preview, freshness, verify } })
