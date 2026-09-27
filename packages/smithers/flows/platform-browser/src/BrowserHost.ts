/**
 * Aggregate browser Host bundle.
 *
 * `BrowserServices` covers the three services a platform package owes Effect —
 * `ChildProcessSpawner`, `FileSystem`, `Path`. This module is the layer above
 * it: the complete closed Host surface Smithers runs on, so the same five tags
 * `NodeHost` and `BunHost` provide are present in a tab too.
 *
 * `Jj` is jj-lib compiled to wasm: the page hands this bundle the compiled
 * `flows_jj.wasm` module and the synchronous half of its filesystem mount, and
 * the bundle wires `BrowserJj.layer` over them — the same operations a Node
 * host gets from the binary, in a tab. The bundle never installs
 * `BrowserJj.layerUnsupported` on its own; a page with no wasm to hand over
 * composes that layer explicitly, so a jj-less host is a stated choice rather
 * than a silent default.
 *
 * Network access is Effect's own `HttpClient` over `fetch` — there is no
 * Smithers wrapper around it. The one thing this bundle configures is
 * `redirect: "manual"`, so the runtime never walks to a second origin behind
 * the capability kernel's back; following a redirect is
 * `@smthrs/kernel`'s guarded `HttpClient.layer`, which rechecks every hop.
 *
 * A tab is stricter than a server about what that leaves visible. Under the
 * Fetch standard, `redirect: "manual"` hands back an *opaque-redirect*
 * response — status `0`, no headers — rather than the 3xx a Node or Bun fetch
 * exposes, so the kernel's redirect loop has no `location` to follow and
 * simply returns it. The opaque response is returned successfully with status 0; callers must
 * handle that status. It never becomes an unauthorized hop.
 *
 * Only `layer` is exposed; there are no layerAt or contained factories.
 * Crypto is not bundled: provide a browser Crypto layer alongside this host.
 *
 * @since 1.0.0-rc.0
 */

import type { Jj } from "@smthrs/jj"
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type { Path } from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type { HttpClient } from "effect/unstable/http/HttpClient"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type * as BrowserChildProcessSpawner from "./BrowserChildProcessSpawner/index.ts"
import type * as BrowserFileSystem from "./BrowserFileSystem/index.ts"
import * as BrowserServices from "./BrowserServices.ts"

/**
 * The complete closed Host service union provided by a browser tab.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export type BrowserHost =
  | FileSystem
  | Path
  | ChildProcessSpawner
  | Jj
  | HttpClient

/** Effect's fetch client, told never to follow a redirect on its own. */
const layerHttpClient: Layer.Layer<HttpClient> = Layer.provide(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })
)

/**
 * The complete Host bundle for a browser tab.
 *
 * Every backend is passed in rather than imported: the page owns which ZenFS
 * backend is mounted, which just-bash instance is wired to it, and how the
 * `flows_jj.wasm` bytes arrive (bundler asset, `fetch` +
 * `WebAssembly.compileStreaming`, cache). The bash interpreter, the promises
 * slice, and `jj.fs` — the synchronous slice — must all view the *same*
 * filesystem, or spawned commands, the FileSystem service, and jj will
 * disagree about what exists. Durability is also the page's job: with an
 * async-mirror ZenFS mount, call the mount's `sync()` after jj writes.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layer = (options: {
  readonly bash: BrowserChildProcessSpawner.JustBashLike
  readonly fs: BrowserFileSystem.ZenFsPromisesLike
  /**
   * What `BrowserJj.layer` needs: the compiled `flows_jj.wasm` module and the
   * synchronous slice of the same mount `fs` exposes as promises, plus the
   * repository root inside that namespace and optional stdio taps. The
   * FileSystem isolation root remains the whole mount at `/`.
   */
  readonly jj: BrowserJj.BrowserJjOptions
}): Layer.Layer<BrowserHost, PlatformError.PlatformError> =>
  Layer.mergeAll(
    BrowserServices.layer({ bash: options.bash, fs: options.fs, workspaceRoot: "/" }),
    layerHttpClient,
    BrowserJj.layer(options.jj)
  )
