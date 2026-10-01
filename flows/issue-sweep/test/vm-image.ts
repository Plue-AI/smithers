/**
 * Builds the issue-sweep microVM image from smithersai/smithers main:
 *   node flows/issue-sweep/test/vm-image.ts [revision]
 * Prints the snapshot name and the build time.
 */
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { buildImage } from "../vm.ts"

const revision = process.argv[2] ??
  execFileSync("gh", ["api", "repos/smithersai/smithers/commits/main", "--jq", ".sha"], { encoding: "utf8" }).trim()
const started = Date.now()
const snapshot = await Effect.runPromise(buildImage(revision))
process.stdout.write(`${JSON.stringify({ snapshot, revision, seconds: (Date.now() - started) / 1000 })}\n`)
