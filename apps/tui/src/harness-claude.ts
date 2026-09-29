/**
 * `claude`, run on a Smithers Cloud workspace: `harness-claude.ts
 * owner/repo/id [claude args]`. Standard input, output and error pass through
 * the workspace's SSH endpoint untouched, so the Agent SDK's stream-JSON and
 * `claude auth status` read the same as a local `claude`. The exit code is the
 * remote one, and a signal the SDK sends reaches the transport.
 */
import * as NodeControl from "@smthrs/cli/NodeControl"
import { run } from "./harness.ts"

const [reference, ...args] = process.argv.slice(2)
if (reference === undefined) {
  process.stderr.write("usage: harness-claude.ts owner/repo/workspace-id [claude args]\n")
  process.exit(2)
}
process.exit(await run(args, process.env, () => NodeControl.workspaceSshPrefix(process.env, reference), reference))
