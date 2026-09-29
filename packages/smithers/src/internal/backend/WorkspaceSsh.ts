/**
 * The canonical workspace SSH transport, shared by CLI control and Cloud sandboxes.
 * @since 1.0.0
 */

import * as CliError from "../../CliError.ts"
import { Client } from "./Client.ts"
import { sshArgs } from "./SSH.ts"
import { workspaceSSH } from "./Workspaces.ts"

/**
 * Resolves a fresh SSH grant with advertised host keys pinned. The optional
 * signal cancels the public API read and SSH-readiness polling.
 * @private
 * @since 1.0.0
 */
export const workspaceSshPrefix = (
  environment: Readonly<Record<string, string | undefined>>,
  reference: string,
  signal?: AbortSignal
): Promise<Array<string>> => {
  const match = /^([\w.-]+\/[\w.-]+)\/([\w-]+)$/.exec(reference)
  if (match === null) return Promise.reject(new CliError.UsageError({ message: "Expected OWNER/REPO/WORKSPACE_ID" }))
  const client = new Client({ environment, ...(signal === undefined ? {} : { signal }) })
  return workspaceSSH(client, match[2]!, { repo: match[1] }).then(async (endpoint) => [
    "ssh",
    ...await sshArgs(client, endpoint)
  ])
}
