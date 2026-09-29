/** A vendor CLI using only the Cloud workspace's own login and environment. */
import * as NodeControl from "@smthrs/cli/NodeControl"
import { home, run } from "./harness.ts"

const [vendor, reference, ...args] = process.argv.slice(2)
if ((vendor !== "claude" && vendor !== "codex") || reference === undefined) {
  process.stderr.write("usage: harness-cli.ts claude|codex owner/repo/workspace-id [args]\n")
  process.exit(2)
}
process.exit(
  await run(args, process.env, () => NodeControl.workspaceSshPrefix(process.env, reference), reference, home, vendor)
)
