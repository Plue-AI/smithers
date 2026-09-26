/**
 * `doctor`'s workspace lines for each configured repository with an
 * environment: `base`, the commit its next task starts from (the configured
 * `base` fetched first), and `tools`, each command its prepared base declares,
 * found in a microVM booted from that base, which is prepared first when it
 * does not exist yet. Bases belong to the installation's owner, so the one
 * doctor prepares is the one the host's tasks boot from.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import * as Workspace from "../../../packages/smithers/agent/organization/src/Workspace.ts"
import type * as MicrosandboxSandbox from "../../../packages/smithers/flows/sandbox/src/MicrosandboxSandbox/index.ts"
import type { Line } from "./doctor.ts"

/** What the lines need: the repository, its environment, and, for `tools`, machines to boot. */
export interface BaseCheck {
  readonly name: string
  readonly repo: string
  readonly environment: Workspace.Environment
  /** Machines of the installation; without them `tools` is skipped. */
  readonly machines?: Workspace.Machines | undefined
  /** Names the tools probe's machine. */
  readonly key: string
}

const fail = (name: string, detail: string, fix: string): Line => ({ name, status: "fail", detail, fix })

/** The installation's machines as the host boots them. */
export const installationMachines = (options: {
  readonly sdk: MicrosandboxSandbox.Sdk
  readonly image: string
  readonly cpus: number
  readonly memoryMib: number
  readonly diskMib?: number | undefined
  readonly installation: string
}): Workspace.Machines =>
  Workspace.microsandbox({
    sdk: options.sdk,
    image: options.image,
    cpus: options.cpus,
    memoryMib: options.memoryMib,
    diskMib: options.diskMib,
    owner: options.installation,
    holder: `doctor-${process.pid}`
  })

/** The `base` and `tools` lines of one repository. */
export const baseLines = async (check: BaseCheck): Promise<Array<Line>> => {
  const { environment, name, repo } = check
  const unused: Workspace.Machines = {
    workspace: () => Effect.die("doctor boots no workspace"),
    fresh: () => Effect.die("doctor boots no machine without an installation"),
    dispose: () => Effect.void,
    bases: {
      identity: "none",
      exists: () => Effect.succeed(false),
      capture: () => Effect.void,
      remove: () => Effect.void
    }
  }
  const within = <A>(effect: Effect.Effect<A, Workspace.WorkspaceError, Workspace.Workspace>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        Effect.provide(
          Workspace.layer({
            machines: check.machines ?? unused,
            maxConcurrentVMs: 1,
            environments: { [repo]: environment }
          }).pipe(Layer.provide(NodeServices.layer))
        )
      )
    )
  const resolved = await within(Effect.flatMap(Workspace.Workspace, (w) => w.resolveBase({ repoPath: repo })))
  if (!resolved.ok) {
    return [
      fail(
        "base",
        `${name}: ${resolved.error.message}`,
        `git -C ${repo} fetch, or fix repositories.${name}.base in Org/Organization.md`
      )
    ]
  }
  const { commit, fetched, ref } = resolved.value
  const lines: Array<Line> = [{
    name: "base",
    status: "pass",
    detail: `${name}: ${ref} → ${commit.slice(0, 12)}${fetched ? " (fetched)" : ""}`
  }]
  const tools = environment.prepare?.tools ?? []
  if (tools.length === 0) return lines
  if (check.machines === undefined) {
    return [...lines, { name: "tools", status: "skip", detail: `${name}: no microVM to look in (fix the boot line)` }]
  }
  const found = await within(
    Effect.flatMap(Workspace.Workspace, (w) => w.findTools({ key: check.key, repoPath: repo, commit }))
  )
  if (!found.ok) {
    return [
      ...lines,
      fail("tools", `${name}: ${found.error.message}`, `fix repositories.${name}.prepare in Org/Organization.md`)
    ]
  }
  return [...lines, {
    name: "tools",
    status: "pass",
    detail: `${name}: ${found.value.tools.map((tool) => tool.name).join(" ")} in base ${found.value.base}`
  }]
}
