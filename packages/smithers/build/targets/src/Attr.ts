/**
 * Cross-cutting attr schemas shared by the PACKAGE.ts target constructors.
 *
 * One module owns the shapes every flavor reuses — `data`, `gates`,
 * `services`, `hosts`, `sandbox`, `approval`, `env`, `secrets`, `using`, and the
 * Serve probe contract — so two flavors can never drift apart on what one of
 * these attrs means. Targets inside these attrs become dependency edges and
 * declared inputs become key material through `Target.make`'s attr walk;
 * this module only validates shape.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as Secret from "./Secret.ts"
import * as Target from "./Target.ts"

/**
 * Schema for one entry of a `data` array: a target whose files materialize
 * before dispatch, a declared input, or an installed-module dependency
 * reference.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DataMember = Schema.Union([Target.Target, Input.Declared, Reference.NodeModuleDep])

/**
 * One entry of a `data` array.
 *
 * @category models
 * @since 0.1.0
 */
export type DataMember = typeof DataMember.Type

/**
 * Schema for a `data` array.
 *
 * `S.glob([...])` returns an array of declared globs, so a data entry may
 * itself be an array of members; the attr walk descends plain arrays, so
 * nothing is lost.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Data = Schema.Array(Schema.Union([DataMember, Schema.Array(DataMember)]))

/**
 * Schema for a `gates` array: targets that must be green immediately before
 * the consumer acts.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Gates = Schema.Array(Target.Target)

/**
 * Schema for a `services` array: Serve targets scoped to the consumer.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Services = Schema.Array(Target.Target)

/**
 * Schema for a list of host platforms, as Node's `process.platform` names
 * them.
 *
 * A Shell target's `hosts` attr uses it to name the hosts the target runs
 * on. The declaration is the same on every host, so the target index records
 * it rather than the host's answer. The package planner answers per host: a
 * wildcard selection omits the target elsewhere, and naming it refuses.
 *
 * @category schemas
 * @since 1.0.0
 */
export const HostPlatforms = Schema.NonEmptyArray(Schema.Literals(["linux", "darwin", "win32"]))

/**
 * Schema for the network destinations a download-performing target reaches:
 * lowercase DNS names, one per host a connection resolves through. A domain
 * allowlist matches the name a connection resolved through, so a CDN's CNAME
 * target is listed beside the name that aliases it, and a redirect's target
 * beside the name that redirects. Environment builders open exactly these
 * hosts; an undeclared list is refused, never replaced by a default.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Destinations = Schema.Array(
  Schema.NonEmptyString.check(
    Schema.isPattern(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/)
  )
)

/**
 * The network destinations a download-performing target reaches.
 *
 * @category models
 * @since 1.0.0
 */
export type Destinations = typeof Destinations.Type

/**
 * Schema for the sandbox policy: the default confinement, a loopback-only
 * opening (`{ network: "loopback" }`: bind, accept, and connect on the
 * loopback interface, no egress; what a test suite that starts its own
 * local listeners needs), the full network opening (`{ network: true }`),
 * or the full opt-out (`"none"`). The declaration is key material in every
 * form.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Sandbox = Schema.Union([
  Schema.Literal("none"),
  Schema.Struct({ network: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("loopback")])) })
])

/**
 * The sandbox policy.
 *
 * @category models
 * @since 0.1.0
 */
export type Sandbox = typeof Sandbox.Type

/**
 * Schema for the approval attr; `"required"` is its only value.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Approval = Schema.Literal("required")

/**
 * Schema for a narrowed child-process environment.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Env = Schema.Record(Schema.String, Schema.String)

/**
 * Schema for declared secrets.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Secrets = Schema.Array(Secret.HttpCredential)

/**
 * Schema for the `using` map binding template names to tool references.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Using = Schema.Record(Schema.String, Reference.Tool)

/**
 * Schema for everything a `bin` slot accepts: a tool reference, or a build
 * target whose declared binary is the executable.
 *
 * A build target as a tool edge is how a workspace runs a program it builds
 * itself — a generator, a compile driver, a linter it vendors. The edge is an
 * ordinary dependency, so the generator is built before its consumer runs and
 * the generator's identity is key material for everything it produced.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Executable = Schema.Union([Reference.Tool, Target.Target])

/**
 * Everything a `bin` slot accepts.
 *
 * @category models
 * @since 0.1.0
 */
export type Executable = typeof Executable.Type

/**
 * Schema for plain argv entries plus flag references.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Args = Schema.Array(Schema.Union([Schema.String, Reference.FlagRef]))

/**
 * Schema for the Serve readiness probe: an open port or an HTTP check with a
 * timeout.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Readiness = Schema.Union([
  Schema.Struct({ port: Schema.Number }),
  Schema.Struct({ http: Schema.NonEmptyString, timeout: Schema.NonEmptyString }),
  Schema.Struct({ exec: Schema.NonEmptyArray(Schema.NonEmptyString), timeout: Schema.NonEmptyString })
])

/**
 * Schema for the Serve health contract: the readiness probe repeated on an
 * interval while dependents run.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Health = Schema.Struct({
  interval: Schema.NonEmptyString,
  failures: Schema.optional(Schema.Number)
})

/**
 * Schema for the Serve stop contract: the graceful-exit signal and grace
 * period applied before the process group is killed.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Stop = Schema.Struct({
  signal: Schema.NonEmptyString,
  grace: Schema.NonEmptyString
})

/**
 * The executable-selector attr names a Shell flavor accepts.
 *
 * @category constants
 * @since 0.1.0
 */
export const executableSelectors = ["bin", "bun", "command", "script"] as const

/**
 * Requires exactly one executable selector among the present attrs.
 *
 * The check runs before schema construction so a declaration that names two
 * programs, or none, fails with the selector rule rather than a shape
 * mismatch.
 *
 * @category validation
 * @since 0.1.0
 */
export const requireOneExecutable = (
  id: string,
  attrs: Record<string, unknown>,
  selectors: ReadonlyArray<string> = executableSelectors
): void => {
  const present = selectors.filter((selector) => attrs[selector] !== undefined)
  if (present.length !== 1) {
    throw new Error(
      `${id} requires exactly one of ${selectors.join(", ")}; received ${
        present.length === 0 ? "none" : present.join(", ")
      }`
    )
  }
}
