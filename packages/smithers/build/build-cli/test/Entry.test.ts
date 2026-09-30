/**
 * The process entry as a function: credentials leave the environment before
 * any workspace module runs, the exit code follows the command, and a signal
 * aborts the run and forces exit 1.
 */
import * as NodeChildProcess from "node:child_process"
import * as NodeEvents from "node:events"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Entry from "../src/Entry.ts"
import type * as Reporter from "../src/Reporter.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

/** A committed build-system workspace with one green Shell test. */
const fixture = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-entry-")))
  temporaryDirectories.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const good = S.Shell.Test({ shell: "true" })
export const Package = S.Package({ targets: { good } })
`
  )
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  return root
}

const terminal = (): Reporter.Terminal & { readonly text: () => string } => {
  let out = ""
  return {
    write: (text) => {
      out += text
    },
    isTTY: false,
    columns: 80,
    text: () => out
  }
}

/**
 * A fake process: exit codes, the environment the run leaves behind, and a
 * real `EventEmitter` behind the signal surface.
 *
 * The emitter is not decoration. `ServiceSupervisor`'s orphan backstop decides
 * whether to hard-kill the process by asking `listenerCount(signal)`, and the
 * difference between a persistent and a one-shot registration is visible only
 * in a registry with Node's own semantics: a one-shot listener is removed
 * before it is invoked. A Map-backed fake cannot tell the two apart, which is
 * why the surrendered-signal defect was invisible here.
 */
/** The inherited search path without the launcher's own relative entries. */
const absolutePath = (): string =>
  (process.env["PATH"] ?? "").split(NodePath.delimiter).filter((entry) => NodePath.isAbsolute(entry)).join(
    NodePath.delimiter
  )

const host = (argv: ReadonlyArray<string>, env: Record<string, string | undefined>) => {
  const signals = new NodeEvents.EventEmitter()
  const codes: Array<number> = []
  const stdout = terminal()
  const stderr = terminal()
  const value: Entry.Host = {
    argv,
    env,
    stdout,
    stderr,
    on: (signal, listener) => {
      signals.on(signal, listener)
    },
    removeListener: (signal, listener) => {
      signals.removeListener(signal, listener)
    },
    setExitCode: (code) => {
      codes.push(code)
    }
  }
  const raise = (signal: "SIGINT" | "SIGTERM"): void => {
    signals.emit(signal)
  }
  const owned = (signal: "SIGINT" | "SIGTERM"): number => signals.listenerCount(signal)
  return { value, codes, stdout, stderr, raise, owned, signals }
}

describe("Entry.main", () => {
  it("clears the cache credentials, serves the command, and leaves no listeners behind", async () => {
    const root = await fixture()
    const env = { ...process.env, SMITHERS_CACHE_URL: "https://cache.invalid", SMITHERS_CACHE_TOKEN: "secret" }
    const fake = host(["//:good", "--workspace", root, "--ui", "plain"], env)
    await Entry.main(fake.value)
    expect(env["SMITHERS_CACHE_URL"]).toBeUndefined()
    expect(env["SMITHERS_CACHE_TOKEN"]).toBeUndefined()
    expect(fake.codes).toEqual([])
    expect(fake.owned("SIGINT")).toBe(0)
    expect(fake.owned("SIGTERM")).toBe(0)
    expect(fake.stdout.text()).toContain("ok: true")
    expect(fake.stderr.text()).not.toContain("//:good  ran")
    expect(fake.stderr.text()).not.toContain("\u001b[")
  })

  it("anchors relative PATH entries to the launch directory before planning", async () => {
    // `pnpm exec` prepends `./node_modules/.bin`; a trailing `:` adds an empty entry.
    const root = await fixture()
    const inherited = absolutePath()
    const env = {
      ...process.env,
      PATH: ["./node_modules/.bin", "", "tools", inherited].join(NodePath.delimiter)
    }
    const fake = host(["//:good", "--workspace", root, "--ui", "plain"], env)
    await Entry.main({ ...fake.value, cwd: root })
    expect(env.PATH).toBe(
      [NodePath.join(root, "node_modules", ".bin"), NodePath.join(root, "tools"), inherited].join(NodePath.delimiter)
    )
    expect(fake.codes).toEqual([])
    expect(fake.stdout.text()).toContain("ok: true")
  })

  it("leaves an absolute PATH and a missing PATH unchanged", async () => {
    const root = await fixture()
    const absolute = { ...process.env, PATH: `${root}${NodePath.sep}${NodePath.delimiter}${absolutePath()}` }
    const expected = absolute.PATH
    await Entry.main({ ...host(["//:good", "--workspace", root, "--ui", "plain"], absolute).value, cwd: root })
    expect(absolute.PATH).toBe(expected)
    const missing: Record<string, string | undefined> = { HOME: process.env["HOME"] }
    await Entry.main({ ...host(["--help"], missing).value, cwd: root })
    expect("PATH" in missing).toBe(false)
  })

  it("records the exit code of a failed command", async () => {
    const root = await fixture()
    const fake = host(["//:missing", "--workspace", root, "--ui", "plain"], { ...process.env })
    await Entry.main(fake.value)
    expect(fake.codes).toEqual([1])
    expect(fake.stdout.text()).toContain("target_failed")
  })

  it("aborts the run on SIGINT and exits 1 even though the command reported nothing", async () => {
    const root = await fixture()
    const fake = host(["//:good", "--workspace", root, "--ui", "plain"], { ...process.env })
    const running = Entry.main(fake.value)
    fake.raise("SIGINT")
    await running
    expect(fake.codes[0]).toBe(1)
    expect(fake.codes.at(-1)).toBe(1)
    expect(fake.owned("SIGINT")).toBe(0)
    expect(fake.stdout.text()).toContain("interrupted by SIGINT")
  })

  it("treats SIGTERM the same way", async () => {
    const root = await fixture()
    const fake = host(["query", "//...", "--workspace", root], { ...process.env })
    const running = Entry.main(fake.value)
    fake.raise("SIGTERM")
    await running
    expect(fake.codes).toContain(1)
    expect(fake.stdout.text()).toContain("interrupted by SIGTERM")
  })

  it("still owns the signal while a later listener runs, so the service backstop sees an owner", async () => {
    // ServiceSupervisor's orphan backstop registers after this entry does and
    // asks `listenerCount(signal)` whether anything else owns the signal. A
    // one-shot registration is removed before its own handler runs, so the
    // backstop saw itself alone, re-raised with no handler installed, and
    // killed the process on the spot: the abort never unwound, so out-of-set
    // writes stayed in the tree, scratch copies leaked, and services were
    // SIGKILLed instead of stopped with their declared signal.
    const root = await fixture()
    const fake = host(["//:good", "--workspace", root, "--ui", "plain"], { ...process.env })
    const running = Entry.main(fake.value)
    const observed: Array<number> = []
    fake.signals.on("SIGINT", () => observed.push(fake.owned("SIGINT")))
    fake.raise("SIGINT")
    // Two owners: this backstop stand-in and the entry, which has not yet let
    // go of the signal it is still acting on.
    expect(observed).toEqual([2])
    await running
    // A second interrupt is a demand to stop now, so the entry is gone from
    // the signal by then and only the backstop stand-in remains.
    expect(fake.owned("SIGINT")).toBe(1)
    expect(fake.stdout.text()).toContain("interrupted by SIGINT")
  })
})
