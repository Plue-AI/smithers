/**
 * The closed Host service list.
 *
 * One list, one set of tags. The kernel decorates each slot **in place** — a
 * middleware `Layer` over the very tag the platform adapter provides — so
 * there is no second, "protected" tag to keep in slot-order sync with this
 * one, and no cast to force a guarded implementation onto a narrower error
 * contract.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md`,
 * `docs/specs/Concepts/Trust Granularity.md`, and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 1.0.0-rc.0
 */
import { Jj as JjPort } from "@smthrs/jj"
import { FileSystem as EffectFileSystem, Layer, Path as EffectPath } from "effect"
import { HttpClient as HttpClientPort } from "effect/unstable/http/HttpClient"
import { ChildProcessSpawner as ChildProcessSpawnerPort } from "effect/unstable/process/ChildProcessSpawner"
import * as ChildProcessSpawner from "./ChildProcessSpawner.ts"
import * as FileSystem from "./FileSystem.ts"
import * as HttpClient from "./HttpClient.ts"
import * as Jj from "./Jj.ts"
import * as Path from "./Path.ts"

/**
 * The CLOSED LIST of platform ports the kernel protects.
 * Optional filesystem batches belong to the existing FileSystem slot. The
 * decorator grants each member separately and exposes no additional tag or
 * unguarded executor to consumers; host slot identities remain unchanged.
 *
 * Everything that touches the outside world enters Smithers through exactly one
 * of these tags — there is no ambient `node:fs`, no bare `spawn`, no global
 * `Date.now()`. Two things depend on that closure:
 *
 *  1. The capability kernel wraps precisely this list. A service that is not
 *     here cannot be attenuated, denied, or audited, so it must not exist.
 *  2. Step keys digest this list as their `layers` component. Which platform
 *     implementations were in scope is part of a step's identity, so a replay
 *     under different layers is a different step rather than a silent lie.
 *
 * Each slot's guarded implementation replaces the raw one under the same tag,
 * so a consumer that never heard of the kernel still cannot bypass it. Where
 * Effect owns the tag (`FileSystem`, `Path`, `ChildProcessSpawner`,
 * `HttpClient`) the error channel stays Effect's own — `PlatformError`, or
 * `HttpClientError` for the network — and permission failures are projected
 * into it by `Permission.toPlatformError` and `HttpClient.toHttpClientError`;
 * where Smithers owns the service (`Jj`) the interface names the kernel's
 * failures directly.
 *
 * `Path` is intentionally retained as an explicit decision: it checks nothing
 * and resolves relative paths against `Workspace.root`.
 * Network access is Effect's own `HttpClient`: there is no Smithers transport
 * port beneath it, because a raw port would be a second way to reach the
 * network whose contract never mentions permission.
 *
 * `Clock` and `Random` are Effect core built-ins: already port-shaped, already
 * swappable via `Effect.provideService`, and never decorated here — a `Clock`
 * or a `Random` carries no host authority to guard, so they are not ours to
 * define. `ChildProcessSpawner` is the same story one layer out: process spawning is
 * `effect/unstable/process`, and the slot holds Effect's tag rather than a
 * Smithers wrapper around it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type HostService =
  | EffectFileSystem.FileSystem
  | EffectPath.Path
  | ChildProcessSpawnerPort
  | JjPort
  | HttpClientPort

/**
 * The Host tags consumed by the kernel at runtime, decorated in place by
 * {@link layer}, and digested by the step-key planner.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const HostServiceTags = [
  EffectFileSystem.FileSystem,
  EffectPath.Path,
  ChildProcessSpawnerPort,
  JjPort,
  HttpClientPort
] as const

/**
 * Stable slot identifiers shared by host composition, kernel attenuation, and
 * step-layer resolution.
 *
 * Each id is the tag key of its slot's service — Effect's own key for the
 * services Effect ships, the defining module's path for ours. The ids are
 * digested into step keys, so a rename invalidates every cached step naming
 * the slot; rename only when the service itself changes, as when `Shell` was
 * replaced by Effect's `ChildProcessSpawner`.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const HostServiceIds = [
  "effect/FileSystem",
  "effect/Path",
  "effect/process/ChildProcessSpawner",
  "@smthrs/jj/Jj",
  "effect/HttpClient"
] as const

/**
 * Builds the full protected Host surface over a host platform bundle and a
 * `GrantStore`. `Workspace` remains a requirement so the exact same root
 * service can be supplied to both the grant store and filesystem decorators.
 *
 * Every member both requires and provides its own slot's tag: provide this
 * layer over a raw platform bundle and the guarded implementation shadows the
 * raw one for everything downstream. There is no exception and no second tag
 * list — `HttpClient` decorates Effect's network tag exactly the way
 * `FileSystem` decorates Effect's filesystem tag.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = Layer.mergeAll(
  FileSystem.layer,
  Path.layer,
  ChildProcessSpawner.layer,
  Jj.layer,
  HttpClient.layer
)
