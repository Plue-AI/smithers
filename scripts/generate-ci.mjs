/** Apply the owning PACKAGE.ts declaration through the actual workflow generator. */

import { Effect } from "effect"
import { openPackageIndex } from "@smthrs/build-cli/Cli"
import { resolveOutputPath, writeGeneratedFile } from "@smthrs/targets/GeneratedFile"
import { render } from "@smthrs/targets/GithubCiGen"
import * as Target from "@smthrs/targets/Target"
import { repoRoot as root } from "./workspace-packages.mjs"

const label = process.argv[2] ?? "//:ci"
if (!["//:ci", "//:driftCi"].includes(label)) throw new Error("Expected //:ci or //:driftCi")
const index = await openPackageIndex({ workspace: root })
const declaration = index.targets().find((row) => row.label === label)
if (!declaration) throw new Error(`Missing ${label} declaration`)
const metadata = Target.metadata(declaration.target)
if (metadata.target !== "GithubCiGen") throw new Error("Review generation when the workflow rule changes")
const attrs = { ...metadata.attrs, packageManager: index.workspace.packageManager, mode: "write" }
const path = resolveOutputPath(attrs.output)
await Effect.runPromise(writeGeneratedFile(root, { path, contents: render(attrs) }))
console.log(`Generated ${path} from ${label}`)
