/**
 * Real host repositories and seeded `DirectorySandbox` machines for the
 * sandbox work contract: `Sandbox.run` captures, `SandboxMerge.apply` lands.
 *
 * Host-side setup runs synchronously through `spawnSync`, so every fixture is
 * a deterministic sequence of real `git` and `jj` commands.
 */

import { Effect, FileSystem, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DirectorySandbox from "../../src/DirectorySandbox/index.ts"
import { ProviderError } from "../../src/RemoteChildProcessSpawner/ProviderError.ts"
import type * as Sandbox from "../../src/Sandbox/index.ts"
import { platform } from "./containedPlatform.ts"

/** A scratch root. Its name avoids the repository's own name, which a local agent guard watches for. */
export const scratch = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), `smthrs-${prefix}-`)))

const config = scratch("jj-config")
const jjConfig = join(config, "config.toml")
writeFileSync(jjConfig, "[user]\nname = \"Host Tester\"\nemail = \"host@example.invalid\"\n")

/** A jj configuration without an identity, so `jj config get user.name` fails. */
export const anonymousJjConfig = join(config, "anonymous.toml")
writeFileSync(anonymousJjConfig, "")

/** Identity for every git and jj command the tests run, on the host and in guests. */
export const identity: Record<string, string> = {
  JJ_CONFIG: jjConfig,
  GIT_AUTHOR_NAME: "Guest Tester",
  GIT_AUTHOR_EMAIL: "guest@example.invalid",
  GIT_COMMITTER_NAME: "Guest Tester",
  GIT_COMMITTER_EMAIL: "guest@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null"
}

// `SandboxMerge.apply` spawns `jj` and `git` with this process's environment.
Object.assign(process.env, identity)

/** Removes every scratch directory this module created. */
export const cleanup = (...roots: ReadonlyArray<string>): void => {
  for (const root of [config, ...roots]) rmSync(root, { recursive: true, force: true })
}

/** Runs `script` with `sh` on the host in `cwd`, failing with its stderr on a non-zero exit. */
export const host = (cwd: string, script: string): string => {
  const exited = spawnSync("sh", ["-c", script], {
    cwd,
    env: { ...process.env, ...identity, PWD: cwd },
    encoding: "utf8"
  })
  if (exited.status !== 0) throw new Error(`host \`${script}\` exited ${exited.status}: ${exited.stderr}`)
  return exited.stdout
}

/** Single-quotes `value` for `sh`. */
export const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/**
 * A colocated jj repository at `<root>/host` whose `main` holds `files`.
 * Answers its path and `main`'s commit id.
 */
export const hostRepository = (
  root: string,
  files: Readonly<Record<string, string>>,
  name = "host"
): { readonly path: string; readonly main: string } => {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  host(path, "git init -q -b main . && jj git init --colocate --quiet")
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, ".."), { recursive: true })
    writeFileSync(join(path, file), content)
  }
  host(path, "jj commit --quiet -m seed && jj bookmark set main -r @- --quiet")
  return { path, main: commitOf(path, "main") }
}

/** The commit id `revision` names in the host repository at `path`. */
export const commitOf = (path: string, revision: string): string =>
  host(path, `jj --ignore-working-copy log --no-graph -r ${quote(revision)} -T commit_id`).trim()

/** Commits `files` on top of `main` in the host repository and moves `main` there. */
export const advanceMain = (path: string, files: Readonly<Record<string, string>>, message = "advance"): string => {
  host(path, "jj new main --quiet")
  for (const [file, content] of Object.entries(files)) writeFileSync(join(path, file), content)
  host(path, `jj commit --quiet -m ${quote(message)} && jj bookmark set main -r @- --quiet`)
  return commitOf(path, "main")
}

/** What a seeded machine did: commands it ran, and when its release began. */
export interface Recorder {
  readonly events: Array<string>
}

/**
 * Runs `script` in the session's workdir and fails with its stderr when it
 * exits non-zero. Every guest command gets the test identity.
 */
export const guest = (session: Sandbox.Session, script: string): Effect.Effect<string, ProviderError> =>
  Effect.scoped(Effect.gen(function*() {
    const process = yield* session.spawn(script, { env: identity })
    const [stdout, stderr, code] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(process.stdout)),
        Stream.mkString(Stream.decodeText(process.stderr)),
        process.exitCode
      ],
      { concurrency: "unbounded" }
    )
    if (code !== 0) {
      return yield* new ProviderError({ code: "unknown", message: `guest \`${script}\` exited ${code}: ${stderr}` })
    }
    return stdout
  }))

/**
 * Wraps `inner` so `acquire` prepares the checkout with `seed`, as a real
 * provider refreshes its clone during acquisition, and records each spawned
 * command (`spawn:<first line>`) and the start of the release (`release`).
 */
export const seeded = (
  inner: Sandbox.Provider,
  seed: (session: Sandbox.Session) => Effect.Effect<unknown, ProviderError>,
  recorder: Recorder = { events: [] }
): Sandbox.Provider => ({
  acquire: (key) =>
    Effect.gen(function*() {
      const held = yield* inner.acquire(key)
      // Registered after the inner acquisition, so it runs before the inner teardown.
      yield* Effect.addFinalizer(() => Effect.sync(() => recorder.events.push("release")))
      const session: Sandbox.Session = {
        ...held,
        spawn: (command, options) => {
          recorder.events.push(`spawn:${command.split("\n")[0]}`)
          return held.spawn(command, options)
        }
      }
      yield* seed(session)
      return session
    })
})

/** A `DirectorySandbox` provider rooted at `root`, built from the contained test platform. */
export const directory = (root: string): Effect.Effect<Sandbox.Provider> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner
    return DirectorySandbox.make({ fs, spawner, root })
  }).pipe(Effect.provide(platform))

/** A seed that clones the host's `main` into the workdir with plain git. */
export const gitClone = (repository: string) => (session: Sandbox.Session) =>
  guest(session, `git clone -q --branch main ${quote(repository)} .`)

/**
 * A seed that clones the host's `main`, colocates jj, and refreshes with `jj
 * new main@origin`, as the issue-sweep VM does: the guest's `@` is then an
 * empty commit no host has.
 */
export const jjRefresh = (repository: string) => (session: Sandbox.Session) =>
  guest(
    session,
    `git clone -q --branch main ${quote(repository)} . && jj git init --colocate --quiet && jj new main@origin --quiet`
  )
