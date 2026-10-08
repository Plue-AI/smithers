/** The coding host's one run-scoped std read ledger and atomic provider boundary. */
import { Preconditions, type VersionedFileSystem } from "@smthrs/std/Read"
import { StdError } from "@smthrs/std/StdError"
import { Cause, Effect, type FileSystem, PlatformError, Sink, Stream } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"
import { createHash } from "node:crypto"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { NativeOptions } from "./native.ts"

/** Installed authority only. The provider must authenticate the registered run,
 * confine paths and compare every base before settling the complete batch.
 * A stale preflight changes no bytes. ADR 0004 application failures may retain
 * a prefix; they must be reported as failures, never stale or success.
 * The host must never adapt ordered single-file writes to this transaction.
 */
export interface MutationProvider {
  readonly commit: (
    session: string,
    changes: ReadonlyArray<{ readonly path: string; readonly base_digest: string; readonly content: Uint8Array | null }>
  ) => Effect.Effect<void, StdError>
}

const unavailable = () =>
  Effect.fail(
    new StdError({
      code: "provider_unavailable",
      message: "Authenticated file mutation provider unavailable"
    })
  )
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const stale = (path: string, base: string, current: string) =>
  Effect.fail(
    new StdError({
      code: "stale_read",
      path,
      base_digest: base,
      current_digest: current,
      message: `Re-read ${path}`
    })
  )

/** ADR 0004's installed client owns the codec and kernel-derived run identity.
 * Never send the model-facing ledger's session string as authentication. The
 * installed local client submits a whole batch; preflight stale changes no bytes.
 * Application failures may retain a durable prefix and require fresh reads.
 */
const daemonProvider = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
): MutationProvider => ({
  commit: (_session, changes) =>
    Effect.gen(function*() {
      if (changes.length === 0 || changes.length > 256) return yield* unavailable()
      const batch = changes.length !== 1 || changes[0]!.content === null
      const change = changes[0]!
      let total = 0
      for (const change of changes) {
        total += change.content?.byteLength ?? 0
        if (
          total > 1024 * 1024 ||
          (change.base_digest !== "absent" && !/^[0-9a-f]{64}$/.test(change.base_digest))
        ) return yield* unavailable()
      }
      const child = yield* spawner.spawn(ChildProcess.make(
        "/opt/smithers/bin/smithers-machined",
        batch ? ["client", "write-files"] : ["client", "write-file", change.path, "--base", change.base_digest],
        {
          cwd: "/workspace",
          stdin: Stream.make(
            batch
              ? new TextEncoder().encode(JSON.stringify(changes.map((change) => ({
                ...change,
                content: change.content === null ? null : Array.from(change.content)
              }))))
              : change.content!
          )
        }
      ))
      const capture = (stream: typeof child.stdout, limit = 64 * 1024) =>
        Stream.runFoldEffect(
          stream,
          () => ({ size: 0, text: "", decoder: new TextDecoder() }),
          (state, bytes) =>
            state.size + bytes.length > limit ? unavailable() : Effect.succeed({
              size: state.size + bytes.length,
              text: state.text + state.decoder.decode(bytes, { stream: true }),
              decoder: state.decoder
            })
        ).pipe(Effect.map((state) => state.text + state.decoder.decode()))
      const [output, , exit] = yield* Effect.all([
        capture(child.stdout, batch ? 8 * 1024 * 1024 : 64 * 1024),
        capture(child.stderr),
        child.exitCode
      ], { concurrency: "unbounded" })
      const reply: unknown = yield* Effect.try(() => JSON.parse(output))
      if (typeof reply !== "object" || reply === null || Array.isArray(reply)) return yield* unavailable()
      if (batch && "writes" in reply) {
        if (!Array.isArray(reply.writes) || reply.writes.length > changes.length) return yield* unavailable()
        for (let i = 0; i < reply.writes.length; i++) {
          const receipt = reply.writes[i], expected = changes[i]!
          if (
            typeof receipt !== "object" || receipt === null || receipt.path !== expected.path ||
            receipt.post_digest !== (expected.content === null ? "absent" : digest(expected.content)) ||
            (receipt.raced !== undefined &&
              (typeof receipt.raced !== "string" || !/^[0-9a-f]{64}$/.test(receipt.raced)))
          ) {
            return yield* unavailable()
          }
        }
        if ("failure" in reply) {
          const failure = reply.failure
          if (
            exit === 0 || typeof failure !== "object" || failure === null || !("index" in failure) ||
            typeof failure.index !== "number" || !Number.isInteger(failure.index) ||
            failure.index < 0 || failure.index >= changes.length || !("preflight" in failure) ||
            typeof failure.preflight !== "boolean" || !("code" in failure) ||
            typeof failure.code !== "number" || !Number.isInteger(failure.code) || failure.code < 1 ||
            failure.code > 12 ||
            (failure.preflight ? reply.writes.length !== 0 : failure.index !== reply.writes.length)
          ) return yield* unavailable()
          const refused = changes[failure.index]!
          if (failure.preflight && failure.code === 4) {
            const current = "current_digest" in failure ? failure.current_digest : "absent"
            if (
              typeof current !== "string" || (current !== "absent" && !/^[0-9a-f]{64}$/.test(current))
            ) return yield* unavailable()
            return yield* stale(refused.path, refused.base_digest, current)
          }
          if (failure.preflight && failure.code === 10) {
            return yield* Effect.fail(
              new StdError({
                code: "moved_off",
                path: refused.path,
                message: "Branch moved off the item"
              })
            )
          }
          return yield* Effect.fail(
            new StdError({
              code: "command_failed",
              path: refused.path,
              message: `Patch stopped after ${reply.writes.length} files; re-read all affected paths`
            })
          )
        }
        if (exit !== 0 || reply.writes.length !== changes.length) return yield* unavailable()
        return
      }
      // A singleton error cannot establish a batch preflight refusal or name
      // its stopped path. Require the batch receipt before reporting stale.
      if (batch) return yield* unavailable()
      if ("error" in reply) {
        const error = reply.error
        if (exit === 0 || typeof error !== "object" || error === null || !("code" in error)) {
          return yield* unavailable()
        }
        if (error.code === "moved_off") {
          return yield* Effect.fail(
            new StdError({ code: "moved_off", path: change.path, message: "Branch moved off the item" })
          )
        }
        if (error.code !== "stale") return yield* unavailable()
        const current = "current_digest" in error ? error.current_digest : "absent"
        if (
          typeof current !== "string" || (current !== "absent" && !/^[0-9a-f]{64}$/.test(current))
        ) return yield* unavailable()
        return yield* stale(change.path, change.base_digest, current)
      }
      if (
        exit !== 0 || !("post_digest" in reply) || reply.post_digest !== digest(change.content!)
      ) return yield* unavailable()
    }).pipe(
      Effect.scoped,
      Effect.timeout("45 seconds"),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        const error = Cause.squash(cause)
        return error instanceof StdError ? Effect.fail(error) : unavailable()
      })
    )
})

/** A new filesystem instance has no inherited read authority, including on resume.
 * Only successful model-facing reads record bases. Mutation-internal reads do not.
 */
export const make = (
  options: NativeOptions,
  fs: FileSystem.FileSystem,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  canonicalRoot: string,
  suppliedProvider?: MutationProvider
): VersionedFileSystem => {
  const root = resolve(options.repositoryPath)
  const pinnedRoot = resolve(canonicalRoot)
  // The shipped broker's socket is bound to this fixed guest workspace. A
  // different root must never accidentally write into that machine's branch.
  const provider = suppliedProvider ?? (pinnedRoot === "/workspace" ? daemonProvider(spawner) : undefined)
  const ledgers = new Map<string, Map<string, string>>()
  const key = (path: string) => {
    const absolute = resolve(root, path)
    const suffix = relative(root, absolute)
    const canonicalSuffix = relative(pinnedRoot, absolute)
    const inside = (value: string) =>
      value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value)
    const target = inside(suffix) ? suffix : canonicalSuffix
    if (!inside(target)) return undefined
    return target.split(sep).join("/")
  }
  const authority = (session: string | undefined) =>
    session === undefined || session === "" || provider === undefined ? unavailable() : Effect.succeed(session)
  const current = (path: string) =>
    fs.readFile(path).pipe(
      Effect.map((bytes) => ({ bytes, digest: digest(bytes) })),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed({ bytes: undefined, digest: "absent" })
          : Effect.fail(new StdError({ code: "permission_denied", path, message: `Could not read ${path}` }))
      )
    )
  const prepare: NonNullable<NonNullable<VersionedFileSystem[typeof Preconditions]>["prepare"]> = (paths, session) =>
    Effect.gen(function*() {
      const run = yield* authority(session)
      const bases = new Map<string, { path: string; base: string; bytes: Uint8Array | undefined }>()
      for (const path of paths) {
        const target = key(path)
        if (target === undefined || bases.has(target)) return yield* unavailable()
        const observed = yield* current(path)
        const base = ledgers.get(run)?.get(target) ?? (observed.digest === "absent" ? "absent" : "unread")
        if (base !== observed.digest) return yield* stale(path, base, observed.digest)
        bases.set(target, { path, base, bytes: observed.bytes?.slice() })
      }
      let committed = false
      return {
        read: (path: string) =>
          Effect.suspend(() => {
            const target = key(path)
            const captured = target === undefined ? undefined : bases.get(target)
            if (captured === undefined) return unavailable()
            if (captured.bytes === undefined) {
              return Effect.fail(new StdError({ code: "not_found", path, message: `File not found: ${path}` }))
            }
            return Effect.succeed(captured.bytes.slice())
          }),
        commit: (changes) =>
          Effect.gen(function*() {
            if (committed || changes.length === 0) return yield* unavailable()
            const seen = new Set<string>()
            const request: Array<{ path: string; base_digest: string; content: Uint8Array | null }> = []
            for (const change of changes) {
              const target = key(change.path)
              const captured = target === undefined ? undefined : bases.get(target)
              if (target === undefined || captured === undefined || seen.has(target)) return yield* unavailable()
              seen.add(target)
              request.push({ path: target, base_digest: captured.base, content: change.content?.slice() ?? null })
            }
            // A provider's interruption/failure can have an unknown outcome. Never
            // reuse this prepared invocation or claim its ledger advanced.
            committed = true
            yield* provider!.commit(run, request).pipe(Effect.catch((error) => {
              // A batch application failure may have committed a prefix. Remove
              // read authority rather than treating any old base as a receipt.
              if (error.code === "command_failed") {
                for (const change of request) ledgers.get(run)?.delete(change.path)
              }
              return Effect.fail(error)
            }))
            let ledger = ledgers.get(run)
            if (ledger === undefined) {
              ledger = new Map()
              ledgers.set(run, ledger)
            }
            for (const change of request) {
              ledger.set(change.path, change.content === null ? "absent" : digest(change.content))
            }
          }).pipe(Effect.uninterruptible)
      }
    })
  const denied = (method: string) =>
    Effect.fail(PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method,
      description: "Coding mutations require an authenticated atomic provider"
    }))
  return {
    ...fs,
    [Preconditions]: {
      record: (path, bytes, session) =>
        Effect.sync(() => {
          const target = key(path)
          if (target === undefined || session === undefined || session === "") return
          let ledger = ledgers.get(session)
          if (ledger === undefined) {
            ledger = new Map()
            ledgers.set(session, ledger)
          }
          ledger.set(target, digest(bytes))
        }),
      validate: (_paths, session) => authority(session).pipe(Effect.asVoid),
      prepare
    },
    writeFile: () => denied("writeFile"),
    writeFileString: () => denied("writeFileString"),
    rename: () => denied("rename"),
    remove: () => denied("remove"),
    copy: () => denied("copy"),
    copyFile: () => denied("copyFile"),
    makeDirectory: () => denied("makeDirectory"),
    open: (path, options) =>
      options?.flag === undefined || options.flag === "r" ? fs.open(path, options) : denied("open"),
    sink: () =>
      Sink.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "sink" })),
    truncate: () => denied("truncate"),
    link: () => denied("link"),
    symlink: () => denied("symlink"),
    utimes: () => denied("utimes"),
    chmod: () => denied("chmod"),
    chown: () => denied("chown"),
    makeTempDirectory: () => denied("makeTempDirectory"),
    makeTempDirectoryScoped: () => denied("makeTempDirectoryScoped"),
    makeTempFile: () => denied("makeTempFile"),
    makeTempFileScoped: () => denied("makeTempFileScoped")
  }
}
