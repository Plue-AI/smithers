/**
 * Package-mode execution of the agent, git, GitHub, and memory lanes through
 * the real CLI against real trees, with the scripted agent fake selected by
 * `SMTHRS_AGENT_FAKE`:
 *
 * - Agent.Lint: an empty diff slice is vacuously green with zero spawns;
 *   findings are red; a green verdict caches under its full key and replays
 *   with zero spawns; `--no-cache` bypasses the replay; `--fix` writes only
 *   inside `fixes` and rejects an escaping candidate whole.
 * - Agent.Diff: payload inputs, `approval: "required"`, outward gates, and
 *   MCP reachability refuse before any session; the candidate/gate loop runs
 *   the declared gates against a scratch copy carrying the exact candidate,
 *   applies the accepted candidate to the tree, replays from cache, and
 *   preserves the final candidate on exhaustion.
 * - Github.CiGen: drift under check, publish under `--write` inside the
 *   write-set with preserved files untouched and stale output removed, and
 *   the workflow's run targets never executed; the `gitHooks` command
 *   checks and installs hook scripts.
 * - Git.Commit: gated commit with the declared, overridden, or agent-written
 *   message; the gates judge a scratch copy holding the tree the commit
 *   records, so an unstaged change outside the scope can neither pass nor fail
 *   them; a red gate refuses and restores the index.
 * - Github.Pr: the refusal gate, and NotImplemented past it.
 * - Memory.Retain: the typed unavailable notices, and the real backend call.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { serve as serveCli, type ServeOptions } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

/** Temp directories this file created; removed after the suite so a run leaves nothing in the OS temp dir. */
const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const exists = async (path: string): Promise<boolean> => Fs.access(path).then(() => true, () => false)

const workspaceModule = (extra = ""): string =>
  `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  agents: S.Agents({ default: S.Agent.Codex({ model: "luna" }), luna: S.Agent.Codex({ model: "luna" }) }),
  ${extra}
})
`

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

const initRepo = (root: string): void => {
  git(root, "init", "-q")
  git(root, "config", "user.email", "t@t.t")
  git(root, "config", "user.name", "t")
  git(root, "config", "commit.gpgsign", "false")
}

const commitAll = (root: string, message = "init"): void => {
  git(root, "add", "-A")
  git(root, "commit", "-qm", message)
}

const temporaryWorkspace = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-agent-lane-"))))

/** One scripted fake response, as `AgentFake.ScriptedResponse` decodes it. */
interface Response {
  readonly purpose?: "lint" | "fix" | "diff"
  readonly findings?: ReadonlyArray<
    { file: string; line: number; severity: "info" | "warning" | "error"; message: string }
  >
  readonly edits?: ReadonlyArray<{ path: string; contents: string | null }>
  readonly note?: string
  readonly fail?: string
}

/** Writes the fake script the next command replays and resets its spawn log; returns the log path. */
const script = async (root: string, responses: ReadonlyArray<Response>, identity = "fake"): Promise<string> => {
  await write(root, "fake.json", JSON.stringify({ identity, responses }))
  const logPath = NodePath.join(root, "fake.json.spawns.jsonl")
  await Fs.rm(logPath, { force: true })
  return logPath
}

/** The `=== FILES ===` paths the fake saw on its first recorded session run. */
const filesSeen = async (logPath: string): Promise<ReadonlyArray<string>> => {
  const [first] = (await Fs.readFile(logPath, "utf8")).split("\n").filter((line) => line !== "")
  return (JSON.parse(first!) as { files: ReadonlyArray<string> }).files
}

/** The number of session runs the fake recorded so far. */
const spawns = async (logPath: string): Promise<number> => {
  try {
    return (await Fs.readFile(logPath, "utf8")).split("\n").filter((line) => line !== "").length
  } catch {
    return 0
  }
}

/** Serves one command with the fake agent selected unless a case supplies its own environment. */
const serve = (root: string, args: ReadonlyArray<string>, options: ServeOptions = {}) =>
  serveCli(root, args, { environment: options.environment ?? { ...process.env, SMTHRS_AGENT_FAKE: "fake.json" } })

/** A TCP port nothing listens on. */
const closedPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = NodeNet.createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("no port assigned")))
        return
      }
      probe.close(() => resolve(address.port))
    })
    probe.on("error", reject)
  })

describe("Agent.Lint dispatch", () => {
  it(
    "is vacuously green on a clean diff, red on findings, caches a green verdict, and fixes inside the write-set",
    async () => {
      const root = await temporaryWorkspace()
      await write(root, "WORKSPACE.ts", workspaceModule())
      await write(root, "prompt.md", "Flag every TODO.\n")
      await write(root, "src/a.ts", "export const a = 1\n")
      await write(root, "other.ts", "export const other = 1\n")
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const lint = S.Agent.Lint({ agent: S.Agents.luna, prompt: S.file("//prompt.md"), data: [S.gitDiff()], fixes: ["src/**"] })
export const Package = S.Package({ targets: { lint } })
`
      )
      initRepo(root)
      commitAll(root)
      const logPath = await script(root, [])

      // Clean tree: the expanded slice is empty, the agent is never invoked.
      const vacuous = await serve(root, ["//:lint"])
      expect(vacuous.exitCode).toBe(0)
      expect(vacuous.logs).toContain("//:lint  vacuous: agent not invoked")
      expect(vacuous.logs).toContain("//:lint  ran")
      expect(await spawns(logPath)).toBe(0)

      // An in-scope edit: the scripted findings make the lint red.
      await write(root, "src/a.ts", "export const a = 1 // TODO\n")
      await script(root, [{
        purpose: "lint",
        findings: [{ file: "src/a.ts", line: 1, severity: "error", message: "unresolved TODO" }]
      }])
      const red = await serve(root, ["//:lint"])
      expect(red.exitCode).toBe(1)
      expect(red.logs).toContain("//:lint  failed")
      expect(red.logs).toContain("the agent reported 1 finding(s)")
      expect(red.logs).toContain("src/a.ts:1 error: unresolved TODO")
      expect(await spawns(logPath)).toBe(1)

      // A green verdict is admitted under its full key ...
      await script(root, [{ purpose: "lint", findings: [] }])
      const green = await serve(root, ["//:lint"])
      expect(green.exitCode).toBe(0)
      expect(green.logs).toContain("//:lint  reviewed 1 file(s)")
      expect(green.logs).toContain("//:lint  ran")
      expect(await spawns(logPath)).toBe(1)

      // ... and replays on the identical diff with zero spawns: the script is
      // empty now, so any session run would fail loudly.
      await script(root, [])
      const hit = await serve(root, ["//:lint"])
      expect(hit.exitCode).toBe(0)
      expect(hit.logs).toContain("(cached verdict)")
      expect(hit.logs).toContain("//:lint  hit")
      expect(await spawns(logPath)).toBe(0)

      // --no-cache bypasses the verdict read and demands a session.
      const bypass = await serve(root, ["//:lint", "--no-cache"])
      expect(bypass.exitCode).toBe(1)
      expect(bypass.logs).toContain("the fake script is exhausted")

      // A changed prompt re-keys the verdict.
      await write(root, "prompt.md", "Flag every TODO and FIXME.\n")
      const rekeyed = await serve(root, ["//:lint"])
      expect(rekeyed.exitCode).toBe(1)
      expect(rekeyed.logs).toContain("the fake script is exhausted")

      // --fix applies the scripted edit inside `fixes`.
      await script(root, [{ purpose: "fix", edits: [{ path: "src/a.ts", contents: "export const a = 1\n" }] }])
      const fixed = await serve(root, ["//:lint", "--fix"])
      expect(fixed.exitCode).toBe(0)
      // The slice carries the edited prompt too; the fix wrote only inside `fixes`.
      expect(fixed.logs).toContain("//:lint  reviewed 2 file(s); wrote src/a.ts")
      expect(await Fs.readFile(NodePath.join(root, "src/a.ts"), "utf8")).toBe("export const a = 1\n")

      // An edit outside `fixes` rejects the candidate whole; the tree is untouched.
      await write(root, "src/a.ts", "export const a = 2 // TODO\n")
      await script(root, [{ purpose: "fix", edits: [{ path: "other.ts", contents: "tampered\n" }] }])
      const escaped = await serve(root, ["//:lint", "--fix"])
      expect(escaped.exitCode).toBe(1)
      expect(escaped.logs).toContain("outside the declared write-set")
      expect(escaped.logs).toContain("rejected whole")
      expect(await Fs.readFile(NodePath.join(root, "other.ts"), "utf8")).toBe("export const other = 1\n")

      // A path that leaves the workspace is refused before any write.
      await script(root, [{ purpose: "fix", edits: [{ path: "../escape.ts", contents: "x" }] }])
      const traversal = await serve(root, ["//:lint", "--fix"])
      expect(traversal.exitCode).toBe(1)
      expect(traversal.logs).toContain("leaves the workspace")
      expect(await exists(NodePath.join(root, "..", "escape.ts"))).toBe(false)
    },
    120_000
  )
})

describe("Agent.Diff dispatch", () => {
  const diffPackage = (port: number): string =>
    `import { Smithers as S } from "@smthrs/targets"
const srcs = S.Filegroup({ srcs: S.glob(["src/**"]) })
// The gate reads the candidate file's bytes, not just its metadata: seatbelt
// allows file-read-metadata under the whole workspace, so a bare \`test -f\`
// would go green on macOS even when the candidate is hidden from the gate.
const gate = S.Shell.Test({ shell: "grep -q generated out/generated.txt" })
const fix = S.Agent.Diff({
  prompt: S.file("//prompt.md"),
  payload: { issue: S.Input.String("issue id") },
  data: [srcs],
  changes: ["out/**"],
  gates: [gate],
  maxRounds: 2,
})
const never = S.Agent.Diff({
  prompt: S.file("//prompt.md"),
  data: [srcs],
  changes: ["out/**"],
  gates: [S.Shell.Test({ shell: "false" })],
  maxRounds: 1,
})
const escape = S.Agent.Diff({ prompt: S.file("//prompt.md"), data: [srcs], changes: ["out/**"], gates: [], maxRounds: 1 })
const unreachable = S.Agent.Diff({
  prompt: S.file("//prompt.md"),
  mcp: [S.Mcp.Http("probe", "http://127.0.0.1:${port}/mcp")],
  data: [srcs],
  changes: ["out/**"],
  gates: [],
  maxRounds: 1,
})
const gated = S.Agent.Diff({
  prompt: S.file("//prompt.md"),
  data: [srcs],
  changes: ["out/**"],
  gates: [S.Shell.Run({ shell: "touch ran.txt" })],
  maxRounds: 1,
})
const approved = S.Agent.Diff({
  prompt: S.file("//prompt.md"),
  data: [srcs],
  changes: ["out/**"],
  gates: [gate],
  approval: "required",
  maxRounds: 1,
})
export const Package = S.Package({ targets: { srcs, gate, fix, never, escape, unreachable, gated, approved } })
`

  it("refuses missing inputs, approval, outward gates, and unreachable MCP before any session", async () => {
    const root = await temporaryWorkspace()
    const port = await closedPort()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "prompt.md", "Fix the issue.\n")
    await write(root, "src/a.ts", "export const a = 1\n")
    await write(root, "PACKAGE.ts", diffPackage(port))
    initRepo(root)
    commitAll(root)
    const logPath = await script(root, [])

    const missing = await serve(root, ["//:fix"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs).toContain("needs input: required payload input \"issue\" is missing")
    expect(missing.logs).toContain("--input issue=<value>")
    const planned = await serve(root, ["//:fix", "--plan"])
    expect(planned.output).toContain("needs input")

    const undeclared = await serve(root, ["//:fix", "--input", "issue=X", "--input", "bogus=1"])
    expect(undeclared.exitCode).toBe(1)
    expect(undeclared.logs).toContain("payload input \"bogus\" is not declared")

    const approval = await serve(root, ["//:approved"])
    expect(approval.exitCode).toBe(1)
    expect(approval.logs).toContain("approval required")
    expect(approval.logs).toContain("this host has no approval store")
    // A refused consumer schedules no gates.
    expect(approval.logs).not.toContain("//:gate ")

    const gated = await serve(root, ["//:gated"])
    expect(gated.exitCode).toBe(1)
    expect(gated.logs).toContain("gates must be check/test-capable targets")
    expect(gated.logs).toContain("Shell.Run, an outward/Run target, and cannot gate")
    expect(await exists(NodePath.join(root, "ran.txt"))).toBe(false)

    const unreachable = await serve(root, ["//:unreachable"])
    expect(unreachable.exitCode).toBe(1)
    expect(unreachable.logs).toContain(`MCP server probe at http://127.0.0.1:${port}/mcp is unreachable`)

    expect(await spawns(logPath)).toBe(0)
  }, 120_000)

  it(
    "runs the gates against the exact candidate per round, applies the accepted candidate, replays from cache, and preserves an exhausted candidate",
    async () => {
      const root = await temporaryWorkspace()
      const port = await closedPort()
      await write(root, "WORKSPACE.ts", workspaceModule())
      await write(root, "prompt.md", "Fix the issue.\n")
      await write(root, "src/a.ts", "export const a = 1\n")
      await write(root, "PACKAGE.ts", diffPackage(port))
      initRepo(root)
      commitAll(root)

      // Round 1 proposes nothing: the gate is red against that candidate.
      // Round 2 proposes the file: the gate sees it in the scratch copy and
      // goes green, and only then is the candidate applied to the real tree.
      const logPath = await script(root, [
        { purpose: "diff", edits: [] },
        { purpose: "diff", edits: [{ path: "out/generated.txt", contents: "generated\n" }] }
      ])
      const converged = await serve(root, ["//:fix", "--input", "issue=FORCE-1"])
      expect(converged.exitCode).toBe(0)
      expect(converged.logs).toContain("//:fix  round 1: gate //:gate red")
      expect(converged.logs).toContain("//:fix  round 2: gate //:gate green")
      expect(converged.logs).toContain("//:fix  candidate accepted after 2 round(s); applied 1 file(s)")
      expect(converged.logs).toContain("//:fix  ran")
      expect(await Fs.readFile(NodePath.join(root, "out/generated.txt"), "utf8")).toBe("generated\n")
      expect(await spawns(logPath)).toBe(2)
      // The prompt rendered the data filegroup's files and not the prompt file.
      expect(await filesSeen(logPath)).toEqual(["src/a.ts"])

      // The same inputs replay the cached verdict with zero spawns; the
      // exhausted script would fail any session run.
      await Fs.rm(NodePath.join(root, "out"), { recursive: true, force: true })
      await script(root, [])
      const replay = await serve(root, ["//:fix", "--input", "issue=FORCE-1"])
      expect(replay.exitCode).toBe(0)
      expect(replay.logs).toContain("(cached verdict)")
      expect(replay.logs).toContain("//:fix  hit")
      expect(await Fs.readFile(NodePath.join(root, "out/generated.txt"), "utf8")).toBe("generated\n")
      expect(await spawns(logPath)).toBe(0)

      // A different input value is a different verdict key.
      const other = await serve(root, ["//:fix", "--input", "issue=FORCE-2"])
      expect(other.exitCode).toBe(1)
      expect(other.logs).toContain("the fake script is exhausted")

      // Exhaustion preserves the final candidate and gate report as artifacts
      // and leaves the tree untouched.
      await script(root, [{ purpose: "diff", edits: [{ path: "out/never.txt", contents: "never\n" }] }])
      const exhausted = await serve(root, ["//:never"])
      expect(exhausted.exitCode).toBe(1)
      expect(exhausted.logs).toContain("exhausted 1 round(s) without a green gate set")
      expect(exhausted.logs).toContain("candidate preserved in .flows/artifacts/never")
      expect(await exists(NodePath.join(root, "out/never.txt"))).toBe(false)
      const preserved = await Fs.readFile(NodePath.join(root, ".flows/artifacts/never/candidate.diff"), "utf8")
      expect(preserved).toContain("=== out/never.txt (candidate) ===")
      const report = JSON.parse(
        await Fs.readFile(NodePath.join(root, ".flows/artifacts/never/gate-report.json"), "utf8")
      ) as ReadonlyArray<{ gate: string; status: string }>
      expect(report.map((entry) => entry.status)).toEqual(["red"])

      // An escaping candidate edit is refused whole.
      await script(root, [{ purpose: "diff", edits: [{ path: "src/a.ts", contents: "tampered\n" }] }])
      const escaped = await serve(root, ["//:escape"])
      expect(escaped.exitCode).toBe(1)
      expect(escaped.logs).toContain("outside the declared write-set")
      expect(await Fs.readFile(NodePath.join(root, "src/a.ts"), "utf8")).toBe("export const a = 1\n")
    },
    120_000
  )
})

describe("Agent.Diff service gates", () => {
  const node = process.execPath
  // A server that serves out/generated.txt from its own cwd, 404 otherwise:
  // green only when the candidate tree it was started from holds the file.
  const server = "const fs=require(\"fs\"),http=require(\"http\");" +
    "http.createServer((q,r)=>{if(fs.existsSync(\"out/generated.txt\")){r.end(fs.readFileSync(\"out/generated.txt\"))}" +
    "else{r.statusCode=404;r.end()}}).listen(Number(process.argv[1]),\"127.0.0.1\")"
  const probe = "require(\"http\").get(\"http://127.0.0.1:\"+process.argv[1]+\"/\",r=>{let s=\"\";" +
    "r.on(\"data\",d=>s+=d).on(\"end\",()=>process.exit(r.statusCode===200&&s.includes(\"generated\")?0:1))})" +
    ".on(\"error\",()=>process.exit(1))"
  const servedPackage = (port: number): string =>
    `import { Smithers as S } from "@smthrs/targets"
const srcs = S.Filegroup({ srcs: S.glob(["src/**"]) })
const svc = S.Shell.Serve({
  shell: ${JSON.stringify(`${node} -e '${server}' ${port}`)},
  readiness: { port: ${port} },
})
const smoke = S.Shell.Test({ shell: ${
      JSON.stringify(`${node} -e '${probe}' ${port}`)
    }, services: [svc], sandbox: { network: true } })
const served = S.Agent.Diff({
  prompt: S.file("//prompt.md"),
  data: [srcs],
  changes: ["out/**"],
  gates: [smoke],
  maxRounds: 2,
})
export const Package = S.Package({ targets: { srcs, svc, smoke, served } })
`

  it(
    "starts a gate's services from the candidate tree, so the served smoke test judges the candidate",
    async () => {
      const root = await temporaryWorkspace()
      const port = await closedPort()
      await write(root, "WORKSPACE.ts", workspaceModule())
      await write(root, "prompt.md", "Generate the file.\n")
      await write(root, "src/a.ts", "export const a = 1\n")
      await write(root, "PACKAGE.ts", servedPackage(port))
      initRepo(root)
      commitAll(root)

      // Round 1 proposes nothing: the server started from that candidate
      // 404s and the gate is red. Round 2 proposes the file: the server
      // started from the round-2 scratch copy serves it, the gate is green,
      // and only then does the real tree receive the candidate.
      const logPath = await script(root, [
        { purpose: "diff", edits: [] },
        { purpose: "diff", edits: [{ path: "out/generated.txt", contents: "generated\n" }] }
      ])
      const converged = await serve(root, ["//:served"])
      expect(converged.exitCode).toBe(0)
      expect(converged.logs).toContain("//:smoke  service //:svc: starting")
      expect(converged.logs).toContain("//:served  round 1: gate //:smoke red")
      expect(converged.logs).toContain("//:served  round 2: gate //:smoke green")
      expect(converged.logs).toContain("//:served  candidate accepted after 2 round(s); applied 1 file(s)")
      expect(await Fs.readFile(NodePath.join(root, "out/generated.txt"), "utf8")).toBe("generated\n")
      expect(await spawns(logPath)).toBe(2)
    },
    120_000
  )
})

describe("Github.CiGen dispatch and gitHooks", () => {
  const rootPackage = `import { Smithers as S } from "@smthrs/targets"
const check = S.Shell.Test({ shell: "touch check-ran.txt" })
export const Package = S.Package({ targets: { check } })
`
  const githubPackage = `import { Smithers as S } from "@smthrs/targets"
import { Package as root } from "../PACKAGE.js"

const setup = S.Github.Setup({ cacheUrl: S.Secret("SMITHERS_CACHE_URL"), cacheToken: S.Secret("SMITHERS_CACHE_TOKEN") })
const ci = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, setup, run: [root.check] })
const github = S.Github.CiGen({
  workflows: [ci],
  preserve: ["workflows/hand.yml"],
  changes: ["workflows/**", "actions/setup/**"],
})
export const Package = S.Package({ targets: { ci, github } })
`

  it(
    "reports drift, publishes inside the write-set preserving hand-written files, and never runs the workflow targets",
    async () => {
      const root = await temporaryWorkspace()
      await write(root, "WORKSPACE.ts", workspaceModule())
      await write(root, "PACKAGE.ts", rootPackage)
      await write(root, ".github/PACKAGE.ts", githubPackage)
      await write(root, ".github/workflows/hand.yml", "name: hand\n")
      await write(root, ".github/workflows/stale.yml", "name: stale\n")
      initRepo(root)
      commitAll(root)

      const drift = await serve(root, ["//.github:github"])
      expect(drift.exitCode).toBe(1)
      expect(drift.logs).toContain("drift in generated GitHub files")
      expect(drift.logs).toContain("actions/setup/action.yml=missing")
      expect(drift.logs).toContain("workflows/ci.yml=missing")
      expect(drift.logs).toContain("workflows/stale.yml=unexpected")
      expect(drift.logs).not.toContain("hand.yml")
      expect(await exists(NodePath.join(root, "check-ran.txt"))).toBe(false)

      const written = await serve(root, ["//.github:github", "--write"])
      expect(written.exitCode).toBe(0)
      expect(written.logs).toContain("wrote 2, unchanged 0, removed 1, preserved 1")
      expect(written.logs).toContain("removed: workflows/stale.yml")
      const ci = await Fs.readFile(NodePath.join(root, ".github/workflows/ci.yml"), "utf8")
      expect(ci).toContain("smithers-build '//:check'")
      expect(ci).toContain("uses: ./.github/actions/setup")
      expect(ci).toContain("\"cache-token\": \"${{ secrets.SMITHERS_CACHE_TOKEN }}\"")
      const action = await Fs.readFile(NodePath.join(root, ".github/actions/setup/action.yml"), "utf8")
      expect(action).toContain("yarn install --frozen-lockfile")
      expect(await Fs.readFile(NodePath.join(root, ".github/workflows/hand.yml"), "utf8")).toBe("name: hand\n")
      expect(await exists(NodePath.join(root, ".github/workflows/stale.yml"))).toBe(false)
      expect(await exists(NodePath.join(root, "check-ran.txt"))).toBe(false)

      // Byte-stable: the check is clean and a re-render writes nothing.
      const clean = await serve(root, ["lint", "//.github:github"])
      expect(clean.exitCode).toBe(0)
      expect(clean.logs).toContain("//.github:github  2 generated file(s) clean, 1 preserved")
      const again = await serve(root, ["//.github:github", "--write"])
      expect(again.logs).toContain("wrote 0, unchanged 2, removed 0, preserved 1")

      // Hand drift in a generated file is red again.
      await Fs.appendFile(NodePath.join(root, ".github/workflows/ci.yml"), "# edited\n")
      const edited = await serve(root, ["//.github:github"])
      expect(edited.exitCode).toBe(1)
      expect(edited.logs).toContain("workflows/ci.yml=stale")

      // The workflow declaration is inert and green on its own.
      const declaration = await serve(root, ["//.github:ci"])
      expect(declaration.exitCode).toBe(0)
      expect(declaration.logs).toContain("inert declaration (1 run entries)")
      expect(await exists(NodePath.join(root, "check-ran.txt"))).toBe(false)
    },
    120_000
  )

  it("checks and installs the WORKSPACE.ts git hook scripts", async () => {
    const root = await temporaryWorkspace()
    await write(
      root,
      "WORKSPACE.ts",
      `import { Package as root } from "./PACKAGE.js"\n${
        workspaceModule("gitHooks: { preCommit: root.check, prePush: root.check },")
      }`
    )
    await write(root, "PACKAGE.ts", rootPackage)
    initRepo(root)
    commitAll(root)

    const missing = await serve(root, ["gitHooks"])
    expect(missing.exitCode).toBe(1)
    expect(missing.output).toContain("pre-commit=missing")
    expect(missing.output).toContain("pre-push=missing")

    const installed = await serve(root, ["gitHooks", "--write"])
    expect(installed.exitCode).toBe(0)
    expect(installed.output).toContain("pre-commit")
    const hook = NodePath.join(root, ".git/hooks/pre-commit")
    expect(await Fs.readFile(hook, "utf8")).toContain("exec smithers-build '//:check'")
    expect((await Fs.stat(hook)).mode & 0o111).not.toBe(0)

    const clean = await serve(root, ["gitHooks"])
    expect(clean.exitCode).toBe(0)
    expect(clean.output).toContain("clean: true")
  }, 120_000)
})

describe("Git.Commit dispatch", () => {
  const commitPackage = `import { Smithers as S } from "@smthrs/targets"
const gate = S.Shell.Test({ shell: "true" })
const redGate = S.Shell.Test({ shell: "false" })
const commit = S.Git.Commit({ gates: [gate], message: "chore: declared" })
const agentCommit = S.Git.Commit({ gates: [gate], message: S.Agents.luna })
const blocked = S.Git.Commit({ gates: [redGate], message: "chore: never" })
export const Package = S.Package({ targets: { gate, redGate, commit, agentCommit, blocked } })
`

  it("stages, gates the candidate tree, composes the message, and commits; a red gate refuses", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "PACKAGE.ts", commitPackage)
    await write(root, ".gitignore", ".flows\nfake.json*\n")
    initRepo(root)
    commitAll(root)
    const base = git(root, "rev-parse", "HEAD").trim()

    await write(root, "one.txt", "1\n")
    // Without `--sweep` the rule refuses rather than absorbing a concurrent edit.
    const unswept = await serve(root, ["//:commit"])
    expect(unswept.exitCode).toBe(1)
    // The refusal lands before staging, so no gate judged anything.
    expect(unswept.logs).not.toContain("//:gate ")
    expect(unswept.logs).toContain("unrelated_changes")
    expect(unswept.logs).toContain("one.txt")
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(base)
    expect(git(root, "status", "--porcelain").trim()).toBe("?? one.txt")

    const declared = await serve(root, ["//:commit", "--sweep"])
    expect(declared.exitCode).toBe(0)
    expect(declared.logs).toContain(
      "//:commit  staged the whole working tree: --sweep, and no declared path scope"
    )
    expect(declared.logs).toMatch(/\/\/:commit  committed [0-9a-f]{12}: chore: declared; 1 file\(s\)/)
    expect(git(root, "log", "-1", "--format=%s").trim()).toBe("chore: declared")
    expect(git(root, "status", "--porcelain").trim()).toBe("")

    await write(root, "two.txt", "2\n")
    const overridden = await serve(root, ["//:commit", "--sweep", "-m", "feat: override wins"])
    expect(overridden.exitCode).toBe(0)
    expect(git(root, "log", "-1", "--format=%s").trim()).toBe("feat: override wins")

    await write(root, "three.txt", "3\n")
    const logPath = await script(root, [{ purpose: "diff", note: "docs: composed by the agent" }])
    const composed = await serve(root, ["//:agentCommit", "--sweep"])
    expect(composed.exitCode).toBe(0)
    expect(git(root, "log", "-1", "--format=%s").trim()).toBe("docs: composed by the agent")
    expect(await spawns(logPath)).toBe(1)

    const nothing = await serve(root, ["//:commit", "--sweep"])
    expect(nothing.exitCode).toBe(1)
    expect(nothing.logs).toContain("nothing_to_commit")

    await write(root, "four.txt", "4\n")
    const head = git(root, "rev-parse", "HEAD").trim()
    const blocked = await serve(root, ["//:blocked", "--sweep"])
    expect(blocked.exitCode).toBe(1)
    expect(blocked.logs).toMatch(/\/\/:blocked  gate \/\/:redGate red against tree [0-9a-f]{12}/)
    expect(blocked.logs).toContain("gates_failed: //:redGate")
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(head)
    // The refused invocation restored the index it staged.
    expect(git(root, "status", "--porcelain").trim()).toBe("?? four.txt")
    expect(base).not.toBe(head)
  }, 120_000)

  it("uses a declared write set as the commit scope", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const scoped = S.Git.Commit({ gates: [], message: "chore: scoped", changes: ["owned.txt"] })
export const Package = S.Package({ targets: { scoped } })
`
    )
    await write(root, "owned.txt", "owned baseline\n")
    await write(root, "other.txt", "other baseline\n")
    initRepo(root)
    commitAll(root)

    await write(root, "owned.txt", "owned change\n")
    await write(root, "other.txt", "concurrent change\n")
    await write(root, "untracked.txt", "concurrent addition\n")
    const scoped = await serve(root, ["//:scoped"])

    expect(scoped.exitCode).toBe(0)
    expect(scoped.logs).not.toContain("staged the whole working tree")
    expect(scoped.logs).toMatch(/\/\/:scoped  committed [0-9a-f]{12}: chore: scoped; 1 file\(s\)/)
    expect(git(root, "show", "--name-only", "--pretty=format:", "HEAD")).toBe("owned.txt\n")
    expect(git(root, "status", "--porcelain")).toBe(" M other.txt\n?? untracked.txt\n")
  }, 120_000)

  it("judges the gates against the tree being committed, not the working tree", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const needsReady = S.Shell.Test({ shell: "grep -q ready other.txt", data: [S.file("other.txt")] })
const rejectsBroken = S.Shell.Test({ shell: "! grep -q broken other.txt", data: [S.file("other.txt")] })
const passesOnlyUnstaged = S.Git.Commit({ gates: [needsReady], message: "chore: owned", changes: ["owned.txt"] })
const failsOnlyUnstaged = S.Git.Commit({ gates: [rejectsBroken], message: "chore: owned", changes: ["owned.txt"] })
export const Package = S.Package({ targets: { needsReady, rejectsBroken, passesOnlyUnstaged, failsOnlyUnstaged } })
`
    )
    await write(root, ".gitignore", ".flows\nfake.json*\n")
    await write(root, "owned.txt", "owned baseline\n")
    await write(root, "other.txt", "baseline\n")
    initRepo(root)
    commitAll(root)
    const base = git(root, "rev-parse", "HEAD").trim()

    // The only file that satisfies the gate is an unstaged edit outside the scope.
    await write(root, "owned.txt", "owned change\n")
    await write(root, "other.txt", "ready\n")
    const passesOnlyUnstaged = await serve(root, ["//:passesOnlyUnstaged"])
    expect(passesOnlyUnstaged.exitCode).toBe(1)
    expect(passesOnlyUnstaged.logs).toContain("gates_failed")
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(base)
    expect(git(root, "status", "--porcelain")).toBe(" M other.txt\n M owned.txt\n")

    // The only file that breaks the gate is an unstaged edit outside the scope.
    await write(root, "other.txt", "broken\n")
    const failsOnlyUnstaged = await serve(root, ["//:failsOnlyUnstaged"])
    expect(failsOnlyUnstaged.exitCode).toBe(0)
    expect(git(root, "show", "--name-only", "--pretty=format:", "HEAD")).toBe("owned.txt\n")
    expect(git(root, "status", "--porcelain")).toBe(" M other.txt\n")
  }, 120_000)
})

describe("Github.Pr dispatch", () => {
  it(
    "refuses in the plan before any gate runs, whatever the token or approval",
    async () => {
      const root = await temporaryWorkspace()
      await write(root, "WORKSPACE.ts", workspaceModule())
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const gate = S.Shell.Test({ shell: "true" })
const prNoToken = S.Github.Pr({ gates: [gate] })
const github = S.HttpSecret(S.Secret("GITHUB_TOKEN"), ["https://api.github.com"])
const pr = S.Github.Pr({ gates: [gate], secrets: [github] })
const prApproval = S.Github.Pr({ gates: [gate], secrets: [github], approval: "required" })
export const Package = S.Package({ targets: { gate, prNoToken, pr, prApproval } })
`
      )
      initRepo(root)
      commitAll(root)

      for (const label of ["prNoToken", "pr", "prApproval"]) {
        const refused = await serve(root, [`//:${label}`], {
          environment: { ...process.env, GITHUB_TOKEN: "ghp_secret" }
        })
        expect(refused.exitCode).toBe(1)
        expect(refused.logs).toContain("Github.Pr: not implemented by this executor")
        expect(refused.logs).not.toContain("//:gate ")
        expect(refused.logs).not.toContain("ghp_secret")
      }
    },
    120_000
  )
})

describe("Memory.Retain dispatch", () => {
  const retainPackage = `import { Smithers as S } from "@smthrs/targets"
const retain = S.Memory.Retain({ source: S.gitCommit("HEAD"), tags: ["commit"] })
export const Package = S.Package({ targets: { retain } })
`

  it("reports the typed unavailable notices, and calls the backend when it is configured", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "PACKAGE.ts", retainPackage)
    initRepo(root)
    commitAll(root)

    const undeclared = await serve(root, ["//:retain"])
    expect(undeclared.exitCode).toBe(1)
    expect(undeclared.logs).toContain("memory backend unavailable (no_backend_declared)")

    await write(root, "WORKSPACE.ts", workspaceModule(`memory: S.Memory.SmithersCloud({ bank: ["repo"] }),`))
    const bin = NodePath.join(root, "bin-empty")
    await Fs.mkdir(bin, { recursive: true })
    const absent = await serve(root, ["//:retain"], { environment: { ...process.env, PATH: bin } })
    expect(absent.exitCode).toBe(1)
    expect(absent.logs).toContain("memory backend unavailable (cli_not_found)")

    // A stub backend on PATH: the real call writes the fact through the
    // shipped subcommand surface (memory set <bank> <key> <record>).
    const stubBin = NodePath.join(root, "bin-stub")
    const argvFile = NodePath.join(root, "argv.txt")
    await write(root, "bin-stub/smithers", `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(argvFile)}\n`)
    await Fs.chmod(NodePath.join(stubBin, "smithers"), 0o755)
    const called = await serve(root, ["//:retain"], {
      environment: { ...process.env, PATH: [stubBin, process.env["PATH"]].join(NodePath.delimiter) }
    })
    const sha = NodeChildProcess.execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    expect(called.exitCode).toBe(0)
    expect(called.logs).toContain(`//:retain  retained repo/commit:${sha} through`)
    const record = JSON.stringify({ source: "HEAD", commit: sha, tags: ["commit"] })
    expect((await Fs.readFile(argvFile, "utf8")).trim()).toBe(`memory set repo commit:${sha} ${record}`)

    // A refusing backend is a typed command failure naming the argv.
    await write(root, "bin-stub/smithers", `#!/bin/sh\necho "bank not found" >&2\nexit 3\n`)
    const refused = await serve(root, ["//:retain"], {
      environment: { ...process.env, PATH: [stubBin, process.env["PATH"]].join(NodePath.delimiter) }
    })
    expect(refused.exitCode).toBe(1)
    expect(refused.logs).toContain(`smithers memory set repo commit:${sha}`)
    expect(refused.logs).toContain("exited 3: bank not found")
  }, 120_000)
})
