import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  testProgram: Smithers.file("//packages/smithers/flows/database/scripts/test-matrix.mjs"),
  deps: [],
  tests: Smithers.glob("test/**/*.ts"),
  cwd: "packages/smithers/agent/triggers"
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
