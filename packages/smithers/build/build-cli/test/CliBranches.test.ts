/**
 * The command surface's remaining branches, driven through the real CLI:
 * PACKAGE.ts `deps()` and `--input` parsing, `--cache-dir`, `--plan` and
 * `--mermaid` under a human renderer, a red run without an exit hook,
 * `gitHooks`, and the human tree and table.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import * as Audience from "../src/Audience.ts"
import { makeCli, normalizeArgv, type RuntimeConfig } from "../src/Cli.ts"
import type * as Reporter from "../src/Reporter.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

const temporary = async (prefix: string): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  temporaryDirectories.push(root)
  return root
}

/** A committed PACKAGE.ts workspace: two tests and a suite that reaches one of them twice. */
const packageFixture = async (goodShell = "true"): Promise<string> => {
  const root = await temporary("smthrs-cli-branches-pkg-")
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
const good = S.Shell.Test({ shell: ${JSON.stringify(goodShell)} })
const bad = S.Shell.Test({ shell: "false" })
const hello = S.Shell.Run({ shell: "true" })
const pair = S.Suite({ tests: [good, bad] })
const all = S.Suite({ tests: [pair, good] })
const docs = S.DocsParity({ readme: S.file("README.md"), deps: [], minimumProseCharacters: 20 })
export const Package = S.Package({ targets: { good, bad, hello, pair, all, docs } })
`
  )
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  await write(root, "README.md", "# Fixture\n\nThis fixture has enough explanatory prose for the documentation gate.\n")
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  return root
}

const terminal = (isTTY: boolean): Reporter.Terminal & { readonly text: () => string } => {
  let out = ""
  return {
    write: (text) => {
      out += text
    },
    isTTY,
    columns: 100,
    text: () => out
  }
}

interface Served {
  readonly exitCode: number
  readonly recorded: number | undefined
  readonly stdout: string
  readonly stderr: string
  readonly envelope: string
}

const serve = async (
  root: string,
  args: ReadonlyArray<string>,
  isTTY: boolean,
  configure: (config: RuntimeConfig) => RuntimeConfig = (config) => config
): Promise<Served> => {
  const stdout = terminal(isTTY)
  const stderr = terminal(isTTY)
  let exitCode = 0
  let recorded: number | undefined
  let envelope = ""
  const environment = {
    ...process.env,
    SMITHERS_AUDIENCE: isTTY ? "human" : "agent",
    NO_COLOR: "1",
    CI: undefined,
    SMTHRS_UI: undefined,
    FORCE_COLOR: undefined
  }
  await makeCli(configure({
    environment,
    stdout,
    stderr,
    exit: (code) => {
      recorded = code
    }
  })).serve([...normalizeArgv(args), "--workspace", root], {
    exit: (code) => {
      exitCode = code
    },
    stdout: (text) => {
      envelope += text
    }
  })
  return { exitCode, recorded, stdout: stdout.text(), stderr: stderr.text(), envelope }
}

const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
const pretendTTY = (value: boolean): void => {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true, writable: true })
}
afterEach(() => {
  if (stdoutTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY
  else Object.defineProperty(process.stdout, "isTTY", stdoutTTY)
})

describe("PACKAGE.ts branches", () => {
  it("shows human watch progress without duplicating successful child envelopes", async () => {
    const root = await packageFixture()
    const good = await serve(root, ["watch", "test", "//:good", "--once"], true)
    expect(good.exitCode).toBe(0)
    expect(good.stderr).toContain("//:good")
    expect(good.stderr).toContain("Watch cycle 1 complete")
    expect(good.stderr).not.toContain("durationMs:")
    expect(good.stderr).not.toContain("counts:")
    const bad = await serve(root, ["watch", "test", "//:bad", "--once"], true)
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toContain("Watch cycle 1 failed")
    expect(bad.stderr).toContain("targets_failed")
  })

  it("keeps agent target execution quiet on a PTY and includes useful follow-up commands", async () => {
    const root = await packageFixture()
    const served = await serve(root, ["//:good", "--audience", "agent", "--ui", "tty"], true)
    expect(served.exitCode).toBe(0)
    expect(served.stderr).toBe("")
    expect(served.envelope).toContain("ok: true")
    expect(served.envelope).toContain("explain")
    expect(served.envelope).toContain("cache status")
    expect(served.envelope).toContain(root)
  })

  it("keeps explicitly encoded human results structured while showing progress", async () => {
    const root = await packageFixture()
    const served = await serve(root, ["//:good", "--json"], true, (config) => ({
      ...config,
      presentation: Audience.resolve({ env: {}, audience: "human", stdout: true, stderr: true })
    }))
    expect(served.exitCode).toBe(0)
    expect(served.stdout).toBe("")
    expect(() => JSON.parse(served.envelope)).not.toThrow()
    expect(served.stderr).toContain("Running //:good")
    expect(served.stderr).not.toContain("\u001b[")
  })

  it("answers deps() with the closure, visiting a shared member once, and refuses a pattern", async () => {
    const root = await packageFixture()
    pretendTTY(true)
    const closure = await serve(root, ["query", "deps(//:all)", "--ui", "tty"], true)
    expect(closure.exitCode).toBe(0)
    expect(closure.stdout).toBe("//:all depends on 3 targets\n  //:bad\n  //:good\n  //:pair\n")
    pretendTTY(false)
    const refused = await serve(root, ["query", "deps(//...)"], false)
    expect(refused.exitCode).toBe(1)
    expect(refused.envelope).toContain("deps() requires one exact or default target")
  })

  it("rejects malformed and repeated --input flags before running anything", async () => {
    const root = await packageFixture()
    const malformed = await serve(root, ["//:good", "--input", "novalue"], false)
    expect(malformed.exitCode).toBe(1)
    expect(malformed.envelope).toContain("--input expects name=value")
    const repeated = await serve(root, ["//:good", "--input", "a=1", "--input", "a=2"], false)
    expect(repeated.exitCode).toBe(1)
    expect(repeated.envelope).toMatch(/names .*a.* twice/)
  })

  it("honours --cache-dir over the declared cache directory", async () => {
    const root = await packageFixture()
    const served = await serve(root, ["//:good", "--cache-dir", "alt-cache", "--ui", "plain"], false)
    expect(served.exitCode).toBe(0)
    await expect(Fs.stat(NodePath.join(root, "alt-cache"))).resolves.toBeDefined()
  })

  it("returns the plan envelope under a human renderer and the mermaid envelope for graph", async () => {
    const root = await packageFixture()
    pretendTTY(true)
    const plan = await serve(root, ["//:good", "--plan", "--ui", "tty"], true)
    expect(plan.exitCode).toBe(0)
    expect(plan.envelope).toContain("rule: Shell.Test")
    expect(plan.stderr).toBe("")
    const graph = await serve(root, ["graph", "//:all", "--mermaid", "--ui", "tty"], true)
    expect(graph.exitCode).toBe(0)
    expect(graph.stdout).toBe("")
    // PACKAGE.ts execution used to accept --mermaid and render the text tree anyway,
    // labelling the envelope `format: text`. The flag now renders a flowchart
    // in both modes, and the envelope says which one it carries.
    expect(graph.envelope).toContain("format: mermaid")
    expect(graph.envelope).toContain("flowchart LR")
  })

  it("falls back to the structured error on a red human run when no exit hook exists", async () => {
    const root = await packageFixture()
    pretendTTY(true)
    const served = await serve(root, ["//:bad", "--ui", "stream"], true, (config) => ({ ...config, exit: undefined }))
    expect(served.exitCode).toBe(1)
    expect(served.recorded).toBeUndefined()
    expect(served.envelope).toContain("Error (targets_failed): 1 of 1 targets failed")
    expect(served.stderr).toContain("//:bad  failed")
    expect(served.stderr).not.toContain("\u001b[")
  })

  it("runs ci and docs through the PACKAGE.ts index", async () => {
    const root = await packageFixture()
    for (const verb of ["ci", "docs"]) {
      const served = await serve(root, [verb, "//:docs"], false)
      expect(served.exitCode).toBe(0)
      expect(served.envelope).toContain("ok: true")
    }
    const planned = await serve(root, ["ci", "//:docs", "--plan"], false)
    expect(planned.exitCode).toBe(0)
    expect(planned.envelope).toContain("verb: ci")
    expect(planned.envelope).toContain("label: \"//:docs\"")
    expect(planned.envelope).not.toContain("rule:")
  })

  it("plans and runs disjoint exact CI targets through their supported verbs", async () => {
    const root = await packageFixture()
    const planned = await serve(root, ["ci", "//:good", "//:docs", "--plan", "--format", "json"], false)
    expect(planned.exitCode, planned.envelope).toBe(0)
    const plan = JSON.parse(planned.envelope) as {
      readonly roots: ReadonlyArray<string>
      readonly targets: ReadonlyArray<{ readonly label: string }>
    }
    expect([...plan.roots].sort()).toEqual(["//:docs", "//:good"])
    expect(plan.targets.map((target) => target.label).sort()).toEqual(["//:docs", "//:good"])

    const executed = await serve(root, ["ci", "//:good", "//:docs", "--format", "json"], false)
    expect(executed.exitCode, executed.envelope).toBe(0)
    const summary = JSON.parse(executed.envelope) as {
      readonly ok: boolean
      readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
    }
    expect(summary.ok).toBe(true)
    expect(summary.results.map((result) => result.label).sort()).toEqual(["//:docs", "//:good"])
    expect(summary.results.every((result) => result.status === "ran")).toBe(true)
  })

  it("refuses a mixed CI command when an exact target supports no CI verb", async () => {
    const root = await packageFixture("mkdir -p .flows/tmp; printf good > .flows/tmp/good-ran.log")
    const marker = NodePath.join(root, ".flows", "tmp", "good-ran.log")
    const patterns = ["ci", "//:good", "//:hello"]

    const planned = await serve(root, [...patterns, "--plan", "--format", "json"], false)
    const executed = await serve(root, [...patterns, "--format", "json"], false)
    expect.soft(planned.exitCode, "plan must refuse").toBe(1)
    expect.soft(planned.envelope.includes("//:hello"), "plan must name hello").toBe(true)
    expect.soft(planned.envelope.includes("does not support"), "plan must explain refusal").toBe(true)
    expect.soft(executed.exitCode, "execution must refuse").toBe(1)
    expect.soft(executed.envelope.includes("//:hello"), "execution must name hello").toBe(true)
    expect.soft(executed.envelope.includes("does not support"), "execution must explain refusal").toBe(true)
    expect.soft(executed.envelope.includes('"counts":'), "execution must not report run counts").toBe(false)
    await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })

    const control = await serve(root, ["ci", "//:good", "--format", "json"], false)
    expect(control.exitCode, control.envelope).toBe(0)
    expect(await Fs.readFile(marker, "utf8")).toBe("good")
  })

  it("runs a repeated exact CI selector once", async () => {
    const root = await packageFixture()
    const executed = await serve(root, ["ci", "//:good", "//:good", "--format", "json"], false)
    expect(executed.exitCode, executed.envelope).toBe(0)
    const summary = JSON.parse(executed.envelope) as {
      readonly results: ReadonlyArray<{ readonly label: string }>
    }
    expect(summary.results.map((result) => result.label)).toEqual(["//:good"])
  })

  it("deduplicates a CI target selected by both an exact label and a recursive wildcard", async () => {
    const root = await packageFixture()
    const patterns = ["ci", "//:good", "//...:good", "//:docs"]
    const planned = await serve(root, [...patterns, "--plan", "--format", "json"], false)
    expect(planned.exitCode, planned.envelope).toBe(0)
    const plan = JSON.parse(planned.envelope) as { readonly roots: ReadonlyArray<string> }
    expect([...plan.roots].sort()).toEqual(["//:docs", "//:good"])

    const executed = await serve(root, [...patterns, "--format", "json"], false)
    expect(executed.exitCode, executed.envelope).toBe(0)
    const summary = JSON.parse(executed.envelope) as {
      readonly results: ReadonlyArray<{ readonly label: string }>
    }
    expect(summary.results.map((result) => result.label).sort()).toEqual(["//:docs", "//:good"])
  })

  it("still rejects an unsupported single verb and an unknown CI label", async () => {
    const root = await packageFixture()
    const unsupported = await serve(root, ["docs", "//:good", "--plan"], false)
    expect(unsupported.exitCode).toBe(1)
    expect(unsupported.envelope).toContain("does not support the docs verb")

    const unknown = await serve(root, ["ci", "//:good", "//:missing", "--plan"], false)
    expect(unknown.exitCode).toBe(1)
    expect(unknown.envelope).toContain("//:missing")
  })
})
