/** Operating-system confinement derived conservatively from effective grants.
 * @since 1.0.0-rc.1
 */

import {
  type Action,
  Capability,
  CapabilityPattern,
  matches,
  maxResourceLength,
  subsumes,
  withinMatchBudget
} from "@smthrs/capability/Capability"
import type { GrantStoreError } from "@smthrs/capability/Permission"
import { Context, Effect, Layer, type Path, type Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { Policy, PolicyRule, Service as GrantService } from "./GrantStore.ts"

/** Workspace-relative trees; `.` names the workspace. No path opens its parent.
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Profile {
  readonly workspaceRoot: string
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly readOnly: ReadonlyArray<string>
  readonly network: "none" | "open"
}
/** Host wrapper for one process stage. Failure must occur before spawning.
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Service {
  readonly confine: (
    command: ChildProcess.StandardCommand,
    profile: Profile
  ) => Effect.Effect<ChildProcess.StandardCommand, PlatformError, Scope.Scope>
}
/** Host confinement seam; missing service refuses spawning.
 * @category services
 * @since 1.0.0-rc.1
 */
export class ProcessConfinement
  extends Context.Service<ProcessConfinement, Service>()("@smthrs/kernel/ProcessConfinement")
{}
/** Explicit unconfined composition.
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const makeNoop: Service = ProcessConfinement.of({ confine: (command) => Effect.succeed(command) })
/** Explicit unconfined layer.
 * @category layers
 * @since 1.0.0-rc.1
 */
export const layerNoop: Layer.Layer<ProcessConfinement> = Layer.succeed(ProcessConfinement)(makeNoop)

const decidable = (pattern: CapabilityPattern, action: Action) =>
  withinMatchBudget(pattern, new Capability({ action, resource: "x".repeat(maxResourceLength) }))

// The capability matcher permits a single star to cross separators. Only
// this universal spelling is equivalent to **; arbitrary globs stay closed.
const universal = (pattern: CapabilityPattern): CapabilityPattern =>
  pattern.resource === "*" ? new CapabilityPattern({ action: pattern.action, resource: "**" }) : pattern

const coversCeiling = (ceiling: PolicyRule["ceiling"], target: CapabilityPattern): boolean =>
  ceiling.groups.every((group) =>
    group.some((pattern) => decidable(pattern, target.action as Action) && subsumes(universal(pattern), target))
  )
const actionRelevant = (pattern: CapabilityPattern, action: Action): boolean =>
  matches(new CapabilityPattern({ action: pattern.action, resource: "**" }), new Capability({ action, resource: "" }))

// A covering rule resolves the complete region. A narrower/conditional refusal
// makes it unknown until a later covering rule resolves it. Unknown configured
// denial vetoes all later grant groups, just as evaluate's configured veto does.
const prove = (policy: Policy, target: CapabilityPattern): boolean => {
  if (!coversCeiling(policy.ceiling, target)) return false
  let decision: "allow" | "deny" | "ask" | "unknown" = "ask"
  let configured: "allow" | "deny" | "ask" | "unknown" = "ask"
  for (const [index, group] of policy.groups.entries()) {
    for (const { rule, ceiling } of group) {
      if (!decidable(rule.pattern, target.action as Action)) return false
      if (!actionRelevant(rule.pattern, target.action as Action)) continue
      if (target.action === "net:private" && rule.effect === "allow" && rule.pattern.action !== "net:private") continue
      if (coversCeiling(ceiling, target) && subsumes(universal(rule.pattern), target)) decision = rule.effect
      else if (rule.effect !== "allow") decision = "unknown"
      if (index === 0) configured = decision
    }
  }
  return configured !== "deny" && configured !== "unknown" && decision === "allow"
}

/** Derives a subset of authority, never a widening. Literal filesystem grants,
 * complex globs and unrepresentable restrictions conservatively open nothing.
 * Writable trees also require read authority and write authority over their
 * exact directory root: native mounts permit reads and directory metadata
 * changes. Only whole-tree grants prove filesystem trees; unrestricted
 * authority for each of get/post/private is required to open network access.
 * @category resolution
 * @since 1.0.0-rc.1
 */
export const profile = (
  grants: GrantService,
  workspaceRoot: string,
  path: Path.Path
): Effect.Effect<Profile, GrantStoreError> =>
  Effect.gen(function*() {
    const policy = yield* grants.policy
    const root = path.resolve(workspaceRoot)
    const resources = [
      ...policy.groups.flatMap((group) =>
        group.flatMap(({ rule, ceiling }) => [rule.pattern, ...ceiling.groups.flat()])
      ),
      ...policy.ceiling.groups.flat()
    ]
    const candidates = new Set<string>()
    for (const { resource } of resources) {
      if (resource === "**" || resource === "*") {
        candidates.add(".")
        continue
      }
      if (!resource.endsWith("/**") || /[*?]/.test(resource.slice(0, -3))) continue
      const base = resource.slice(0, -3)
      // Relative policy resources do not authorize absolute kernel resources.
      if (!path.isAbsolute(base) || path.normalize(base) !== base) continue
      const relative = path.relative(root, base)
      if (path.isAbsolute(relative) || relative.split(path.sep)[0] === "..") continue
      candidates.add(relative === "" ? "." : relative.split(path.sep).join("/"))
    }
    const opened = (action: Action) =>
      [...candidates].filter((relative) => {
        const directory = relative === "." ? root : path.resolve(root, relative)
        const resource = `${directory}/**`
        return prove(policy, new CapabilityPattern({ action, resource })) &&
          (action !== "fs:write" || (
            prove(policy, new CapabilityPattern({ action: "fs:read", resource })) &&
            prove(policy, new CapabilityPattern({ action: "fs:write", resource: directory }))
          ))
      })
        .filter((relative, _, all) =>
          !all.some((parent) => parent !== relative && (parent === "." || relative.startsWith(`${parent}/`)))
        )
        .sort()
    return Object.freeze({
      workspaceRoot: root,
      reads: Object.freeze(opened("fs:read")),
      writes: Object.freeze(opened("fs:write")),
      readOnly: Object.freeze([]),
      network: (["net:get", "net:post", "net:private"] as const).every((action) =>
          prove(policy, new CapabilityPattern({ action, resource: "**" }))
        ) ?
        "open" as const :
        "none" as const
    })
  })
