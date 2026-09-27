/**
 * Provides the host surface of one provisioned machine.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { make } from "../RemoteChildProcessSpawner/layer.ts"
import type { Provider as RemoteProvider } from "../RemoteChildProcessSpawner/Provider.ts"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import * as SandboxHealth from "../SandboxHealth/index.ts"
import { fileSystem } from "./fileSystem.ts"
import type { Provider } from "./Provider.ts"
import type { Session } from "./Session.ts"

/**
 * A spawn-only view of a session something else already holds. It declares
 * `stdin` because the session contract obliges every provider to deliver it,
 * so the adapter accepts input-fed commands instead of refusing them.
 */
const spawnerView = (session: Session): RemoteProvider => ({
  session: session.id,
  open: () => Effect.void,
  spawn: session.spawn,
  kill: session.kill,
  ping: session.ping,
  stdin: true
})

/**
 * Names the layer's session.
 *
 * @category models
 * @since 0.1.0
 */
export interface LayerHostOptions {
  /** The session key the machine is acquired under. */
  readonly session: string
  /** How long a liveness probe may take before the machine counts as gone. */
  readonly health?: SandboxHealth.ProbeOptions | undefined
}

/**
 * Acquires one machine for the layer's lifetime and serves the host surface
 * from it: Effect's `ChildProcessSpawner`, Effect's `FileSystem`, and the
 * pure `Path`.
 *
 * These are the same tags the local platform bundles provide and the standard
 * tools consume, so handing this layer's context to `StandardFlows.filesystem`
 * and `StandardFlows.shell` places every file operation and every spawned
 * command an agent performs on the provisioned machine — coherently, because
 * both surfaces are views of the one session. Closing the layer scope runs the
 * provider's teardown.
 *
 * This is the provisioning story the workspace transaction's documentation
 * calls future work: the machine boundary, not a path guard, is what denies
 * ambient host access here, which is why the sandbox-backed services are
 * served bare rather than kernel-decorated.
 *
 * `SandboxHealth` is served alongside them, probing the machine this layer
 * holds, so a caller can ask whether it is still there. What this layer
 * deliberately does NOT do is what `SandboxSupervision` does for the spawn-only
 * seam: retire an unhealthy session and open a fresh one behind the caller's
 * back. That is right for a transport, where a command is the whole unit of
 * work, and wrong here, because the body holding these services has been
 * WRITING to this machine. Swapping it mid-action would silently discard those
 * writes and hand the body an empty tree that still looks like its workspace.
 * A dead machine surfaces as a failure instead, and re-provisioning belongs to
 * whoever retries the action, which acquires the session key again.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHost = (
  provider: Provider,
  options: LayerHostOptions
): Layer.Layer<
  ChildProcessSpawner | FileSystem.FileSystem | Path.Path | SandboxHealth.Service,
  ProviderError
> =>
  Layer.effectContext(
    Effect.gen(function*() {
      const session = yield* provider.acquire(options.session)
      const view = spawnerView(session)
      const spawner = yield* make(view)
      return Context.make(ChildProcessSpawner, spawner).pipe(
        Context.add(FileSystem.FileSystem, fileSystem(session)),
        // A session with no `ping` yields the noop probe, which always answers
        // healthy. That is not a claim the machine is alive; it says nothing is
        // watching it, and `SandboxHealth.make` documents the distinction.
        Context.add(
          SandboxHealth.SandboxHealth,
          SandboxHealth.make(view, options.health)
        )
      )
    })
    // Guest paths, not host paths: sessions speak POSIX and `rootedAt` normalizes to "/".
  ).pipe(Layer.merge(Path.layer))
