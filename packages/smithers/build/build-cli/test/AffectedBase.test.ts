import { execFile, execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it, vi } from "vitest"
import * as AffectedBase from "../src/AffectedBase.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const fixture = async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "green-base-")))
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
  await write(root, "package.json", JSON.stringify({ name: "green", private: true, packageManager: "pnpm@11.25.0" }))
  await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  await write(root, ".gitignore", ".flows/\nnode_modules/\n")
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("fixture", {
 repository: "git+https://example.invalid/fixture.git", cache: S.Cache({ directory: ".flows" }),
 runtime: S.Runtime.Node({ version: ">=26.4.0" }),
 packageManager: S.PackageManager.Pnpm({ manifest: S.file("//package.json"), lockfile: S.file("//pnpm-lock.yaml") }),
 nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {} })`
  )
  for (const [pkg, count] of [["changed", 14], ["other", 198]] as const) {
    await write(root, `${pkg}/input.txt`, "before")
    await write(
      root,
      `${pkg}/PACKAGE.ts`,
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { ${
        Array.from({ length: count }, (_, i) => `t${i}: S.Copy({ from: S.file("input.txt"), to: "out${i}.txt" })`).join(
          ","
        )
      } } })`
    )
  }
  git("init", "-b", "main")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "user.name", "Fixture")
  git("add", ".")
  git("commit", "-qm", "base")
  const base = git("rev-parse", "HEAD")
  for (const path of ["input.txt", "a.txt", "b.txt"]) await write(root, `changed/${path}`, "after")
  git("add", ".")
  git("commit", "-qm", "head")
  git("remote", "add", "origin", root)
  return { root, git, base }
}

it("uses this job's last successful ancestor and reports the selection at the CLI boundary", async () => {
  const f = await fixture()
  let mode = "green"
  let equalTreeBase = ""
  const requests: Array<{ path: string; auth: string | undefined }> = []
  const other = createServer((req, res) => {
    requests.push({ path: "other", auth: req.headers.authorization })
    res.end("{}")
  })
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve))
  const otherPort = (other.address() as { port: number }).port
  const api = createServer((req, res) => {
    requests.push({ path: req.url!, auth: req.headers.authorization })
    if (mode === "error") {
      res.writeHead(500)
      res.end()
      return
    }
    if (mode === "redirect") {
      res.writeHead(302, { location: `http://localhost:${otherPort}/steal` })
      res.end()
      return
    }
    res.setHeader("Content-Type", "application/json")
    const base = mode === "equal-tree" ? equalTreeBase : f.base
    let response: unknown
    if (req.url!.includes("/jobs")) {
      const job = {
        name: "gate",
        conclusion: mode === "red-job" || req.url!.includes("/runs/2/") ? "failure" : "success"
      }
      response = mode === "malformed-jobs" ? {} : {
        total_count: mode === "truncated-jobs" ? 2 : 1,
        jobs: mode === "duplicate-jobs" ? [job, job] : [job]
      }
    } else if (req.url!.includes("/compare/")) {
      response = {
        status: mode === "diverged" ? "diverged" : "ahead",
        merge_base_commit: { sha: mode === "wrong-ancestor" ? "0".repeat(40) : base }
      }
    } else {
      const green = {
        id: mode === "invalid-id" ? 0 : 1,
        run_number: 1,
        head_sha: mode === "invalid" ? "bad" : mode === "same-sha" ? f.git("rev-parse", "HEAD") : base,
        head_branch: "main"
      }
      const wrongBranch = { ...green, head_branch: "other" }
      const runs = mode === "none" ?
        [] :
        mode === "bounded" ||
          (mode === "pagination" && new URL(req.url!, "http://fixture.invalid").searchParams.get("page") === "1") ?
        Array.from({ length: 100 }, () => wrongBranch) :
        mode === "ordering"
        ? [{ ...green, id: 2, run_number: 2 }, green, wrongBranch, { ...green, run_number: 3 }]
        : [green]
      response = mode === "malformed-runs" ? {} : { workflow_runs: runs }
    }
    res.end(JSON.stringify(response))
  })
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve))
  const environment = {
    ...process.env,
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_TOKEN: "fixture-token",
    GITHUB_REPOSITORY: "fixture/repo",
    GITHUB_WORKFLOW_REF: "fixture/repo/.github/workflows/ci.yml@refs/heads/main",
    GITHUB_JOB: "gate",
    GITHUB_REF_NAME: "main",
    GITHUB_RUN_NUMBER: "2",
    GITHUB_EVENT_NAME: "push",
    GITHUB_SHA: f.git("rev-parse", "HEAD")
  }
  const execute: typeof serve = (root, args, options = {}) =>
    serve(root, args, {
      ...options,
      baseTransport: (url, init) =>
        fetch(
          new URL(
            new URL(String(url)).pathname + new URL(String(url)).search,
            `http://127.0.0.1:${(api.address() as { port: number }).port}`
          ),
          init
        )
    })
  try {
    const run = (extra: Array<string> = []) =>
      execute(f.root, ["affected", "build", "//...", "--base-green", "--list", ...extra], { environment })
    const selected = await run()
    expect(selected.exitCode, selected.output + selected.logs).toBe(0)
    expect(selected.logs).toContain(`3 files changed since ${f.base.slice(0, 7)}`)
    expect(selected.logs).toContain("14 of 212 targets")
    expect(selected.logs).toContain("198 unaffected, not run")
    expect(requests.every((request) => request.auth === "Bearer fixture-token")).toBe(true)
    for (
      mode of [
        "none",
        "error",
        "invalid",
        "diverged",
        "redirect",
        "red-job",
        "malformed-runs",
        "malformed-jobs",
        "truncated-jobs",
        "duplicate-jobs",
        "invalid-id",
        "same-sha",
        "wrong-ancestor",
        "bounded"
      ]
    ) {
      const full = await run()
      expect(full.exitCode, full.output + full.logs).toBe(0)
      expect(full.logs).toContain("212 of 212 targets")
    }
    expect(requests.some((request) => request.path === "other")).toBe(false)
    for (mode of ["ordering", "pagination"]) {
      const partial = await execute(f.root, ["affected", "build", "//...", "--base-green", "--list"], {
        environment: { ...environment, GITHUB_RUN_NUMBER: "3" },
        signal: new AbortController().signal
      })
      expect(partial.exitCode, partial.output + partial.logs).toBe(0)
      expect(partial.logs, mode).toContain("14 of 212 targets")
    }
    for (
      const override of [
        { GITHUB_REPOSITORY: "invalid" },
        { GITHUB_WORKFLOW_REF: "invalid" },
        { GITHUB_API_URL: "http://example.invalid" },
        { GITHUB_API_URL: "https://example.invalid" },
        { GITHUB_EVENT_NAME: "workflow_dispatch" },
        { GITHUB_RUN_NUMBER: "0" }
      ]
    ) {
      const full = await execute(f.root, ["affected", "build", "//...", "--base-green", "--list"], {
        environment: { ...environment, ...override }
      })
      expect(full.logs).toContain("212 of 212 targets")
    }
    const cancelled = new AbortController()
    cancelled.abort()
    const aborted = await execute(f.root, ["affected", "build", "//...", "--base-green", "--list"], {
      environment,
      signal: cancelled.signal
    })
    expect(aborted.exitCode).not.toBe(0)
    mode = "green"
    f.git("remote", "remove", "origin")
    expect((await run()).logs).toContain("212 of 212 targets")
    f.git("remote", "add", "origin", f.root)
    const unchanged = await execute(f.root, ["affected", "build", "//other/...", "--base-green"], { environment })
    expect(unchanged.exitCode, unchanged.output + unchanged.logs).toBe(0)
    expect(unchanged.logs).toContain(`0 of 198 targets · unchanged since ${f.base.slice(0, 7)}`)
    expect(f.git("config", "--local", "--list")).not.toContain("extraheader")
    const ran = await execute(f.root, ["affected", "build", "//changed:t0", "--base-green"], { environment })
    expect(ran.exitCode, ran.output + ran.logs).toBe(0)
    expect(await Fs.readFile(join(f.root, "changed/out0.txt"), "utf8")).toBe("after")
    await Fs.rm(join(f.root, "changed/out0.txt"))
    const equal = await run(["--head", f.base])
    expect(equal.logs).toContain("212 of 212 targets")
    const apiCallsBeforePr = requests.length
    const pr = await execute(f.root, ["affected", "build", "//...", "--base-green", "--list"], {
      environment: { ...environment, GITHUB_EVENT_NAME: "pull_request" }
    })
    expect(pr.logs).toContain(`3 files changed since ${f.base.slice(0, 7)}`)
    const prUnchanged = await execute(f.root, ["affected", "build", "//other/...", "--base-green", "--list"], {
      environment: { ...environment, GITHUB_EVENT_NAME: "pull_request" }
    })
    expect(prUnchanged.logs).toContain("198 of 198 targets")
    expect(requests).toHaveLength(apiCallsBeforePr)
    equalTreeBase = f.git("rev-parse", "HEAD")
    f.git("commit", "--allow-empty", "-qm", "equal tree")
    mode = "equal-tree"
    expect((await run()).logs).toContain("212 of 212 targets")
    mode = "green"
    await write(f.root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n# changed\n")
    const global = await run()
    expect(global.logs).toContain("pnpm-lock.yaml is an input of every target")
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => api.close(() => resolve())),
      new Promise<void>((resolve) => other.close(() => resolve()))
    ])
    await Fs.rm(f.root, { recursive: true, force: true })
  }
}, 60_000)

it("withholds the API token from target children", async () => {
  const f = await fixture()
  try {
    await write(
      f.root,
      "changed/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { env: S.Shell.Run({ shell: "if printenv GITHUB_TOKEN >/dev/null; then exit 1; fi; echo NO_TOKEN", data: [S.file("input.txt")] }) } })`
    )
    const result = await serve(f.root, ["affected", "run", "//changed:env", "--base-green"], {
      environment: { ...process.env, GITHUB_TOKEN: "fixture-token", GITHUB_EVENT_NAME: "push" }
    })
    expect(result.exitCode, result.output + result.logs).toBe(0)
    expect(result.logs + result.output).toContain("NO_TOKEN")
    expect(result.logs + result.output).not.toContain("fixture-token")
  } finally {
    await Fs.rm(f.root, { recursive: true, force: true })
  }
}, 30_000)

it("admits one outward Run and refuses non-outward and multi-target selections", async () => {
  const f = await fixture()
  try {
    await write(
      f.root,
      "fixture/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
 dev: S.Filegroup({ srcs: [S.file("input.txt")] }),
 publish: S.Shell.Run({ shell: "echo OUTWARD_RAN" }),
 other: S.Shell.Run({ shell: "echo OTHER_RAN" })
} })`
    )
    const dev = await serve(f.root, ["run", "//fixture:dev", "--outward-only"])
    expect(dev.exitCode).not.toBe(0)
    expect(dev.output + dev.logs).toContain("//fixture:dev is not an outward target")
    await write(
      f.root,
      "pair/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
 one: S.Shell.Run({ shell: "echo OUTWARD_RAN" }), two: S.Shell.Run({ shell: "echo OTHER_RAN" })
} })`
    )
    const many = await serve(f.root, ["run", "//pair/...", "--outward-only"])
    expect(many.exitCode).not.toBe(0)
    expect(many.output + many.logs).toContain("--outward-only needs one explicit target")
    expect(many.output + many.logs).not.toContain("OUTWARD_RAN")
    const wildcard = await serve(f.root, ["run", "//fixture/...:publish", "--outward-only"])
    expect(wildcard.exitCode).not.toBe(0)
    expect(wildcard.output + wildcard.logs).toContain("--outward-only needs one explicit target")
    const run = await serve(f.root, ["run", "//fixture:publish", "--outward-only"])
    expect(run.exitCode, run.output + run.logs).toBe(0)
    expect(run.output + run.logs).toContain("OUTWARD_RAN")
  } finally {
    await Fs.rm(f.root, { recursive: true, force: true })
  }
}, 30_000)

it("refuses token-bearing foreign HTTPS origins before the transport boundary", async () => {
  const f = await fixture()
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const path = String(url)
    return Response.json(
      path.includes("/jobs") ?
        { jobs: [{ name: "gate", conclusion: "success" }] }
        : path.includes("/compare/") ?
        { status: "ahead", merge_base_commit: { sha: f.base } }
        : { workflow_runs: [{ id: 1, run_number: 1, head_branch: "main", head_sha: f.base }] }
    )
  })
  try {
    for (
      const origin of [
        "https://foreign.invalid",
        "https://user:password@api.github.com",
        "https://api.github.com/unexpected",
        "https://api.github.com?other=1"
      ]
    ) {
      const base = await AffectedBase.resolve(f.root, {
        ...process.env,
        GITHUB_EVENT_NAME: "push",
        GITHUB_API_URL: origin,
        GITHUB_TOKEN: "fixture-token",
        GITHUB_REPOSITORY: "fixture/repo",
        GITHUB_JOB: "gate",
        GITHUB_REF_NAME: "main",
        GITHUB_WORKFLOW_REF: "fixture/repo/.github/workflows/ci.yml@refs/heads/main",
        GITHUB_RUN_NUMBER: "2"
      })
      expect(base).toBeUndefined()
      expect(transport).not.toHaveBeenCalled()
    }
  } finally {
    transport.mockRestore()
    await Fs.rm(f.root, { recursive: true, force: true })
  }
})

it("generated checkout supplies no persisted credential to CLI declarations or build children", async () => {
  const f = await fixture()
  try {
    // Simulate checkout's auth helper using a synthetic job credential and the
    // actual generated input; persistence must be off before loading declarations.
    const { toolchainSteps } = await import(new URL("../../targets/src/GithubCiGen.ts", import.meta.url).href)
    const checkout = toolchainSteps({ affected: true, pullRequest: true, packageManager: { name: "pnpm" } } as never, {
      toolchain: { runtimes: [] }
    } as never)[0]!
    f.git("config", "http.https://github.com/.extraheader", "AUTHORIZATION: basic synthetic-checkout-token")
    if (checkout.with?.["persist-credentials"] === "false") {
      f.git("config", "--unset-all", "http.https://github.com/.extraheader")
    }
    await write(
      f.root,
      "changed/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
const direct = process.env.GITHUB_TOKEN === "fixture-token" || process.env.CLOUDFLARE_API_TOKEN === "fixture-cloud-token" || process.env.GH_TOKEN === "fixture-alias-token"
const child = execFileSync(process.execPath, ["-e", 'console.log(process.env.GITHUB_TOKEN === "fixture-token" || process.env.CLOUDFLARE_API_TOKEN === "fixture-cloud-token" || process.env.GH_TOKEN === "fixture-alias-token")'], { encoding: "utf8" }).trim() === "true"
writeFileSync(${
        JSON.stringify(join(f.root, "credential-observation.json"))
      }, JSON.stringify({ direct, child, git: execFileSync("git", ["config", "--local", "--list"], { encoding: "utf8" }).includes("synthetic-checkout-token") }))
process.env.GITHUB_EVENT_NAME = "push"
export const Package = S.Package({ targets: {
 env: S.Shell.Run({ shell: "git config --local --list | grep -q synthetic-checkout-token && exit 1; echo SAFE_RUN" }),
 build: S.Shell.Build({ shell: ${
        JSON.stringify(
          `if git config --local --list | grep -q synthetic-checkout-token; then exit 1; fi; echo SAFE_BUILD > "${
            join(f.root, "changed/build-out.txt")
          }"`
        )
      }, outFiles: ["build-out.txt"] })
} })`
    )
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
    await Fs.mkdir(join(f.root, "bin"))
    await write(
      f.root,
      "bin/git",
      `#!${process.execPath}
import { appendFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
appendFileSync(${
        JSON.stringify(join(f.root, "git-credentials.jsonl"))
      }, JSON.stringify({github:process.env.GITHUB_TOKEN === "fixture-token",cloudflare:process.env.CLOUDFLARE_API_TOKEN === "fixture-cloud-token",alias:process.env.GH_TOKEN === "fixture-alias-token"}) + "\\n")
process.stdout.write(execFileSync(${JSON.stringify(realGit)}, process.argv.slice(2)))
`
    )
    await Fs.chmod(join(f.root, "bin/git"), 0o755)
    await Fs.appendFile(join(f.root, ".gitignore"), "bin/\n*-credentials.jsonl\ncredential-observation.json\n")
    f.git("add", ".gitignore", "changed/PACKAGE.ts")
    f.git("commit", "-qm", "declaration fixture")
    await write(f.root, "changed/input.txt", "latest")
    f.git("add", "changed/input.txt")
    f.git("commit", "-qm", "change one package")
    const entry = fileURLToPath(new URL("../src/main.js", import.meta.url))
    for (
      const args of [
        ["affected", "run", "//changed:env", "--base-green"],
        ["run", "//changed:env", "--outward-only"],
        ["build", "//changed:build"],
        ["affected", "build", "//other/...", "--base-green", "--list", `--workspace=${f.root}`]
      ]
    ) {
      const result = await promisify(execFile)(process.execPath, [entry, ...args], {
        cwd: args.includes("--list") ? fileURLToPath(new URL("../../../../../", import.meta.url)) : f.root,
        env: {
          ...process.env,
          GITHUB_TOKEN: "fixture-token",
          CLOUDFLARE_API_TOKEN: "fixture-cloud-token",
          GH_TOKEN: "fixture-alias-token",
          GITHUB_EVENT_NAME: "pull_request",
          PATH: `${join(f.root, "bin")}:${process.env.PATH}`
        }
      })
      if (args.includes("--list")) expect(result.stdout + result.stderr).toContain("198 of 198 targets")
      const observations = (await Fs.readFile(join(f.root, "git-credentials.jsonl"), "utf8")).trim().split("\n").map((
        line
      ) => JSON.parse(line))
      expect(observations.length).toBeGreaterThan(0)
      expect(observations.every((row) => !row.github && !row.cloudflare && !row.alias)).toBe(true)
      expect(JSON.parse(await Fs.readFile(join(f.root, "credential-observation.json"), "utf8"))).toEqual({
        direct: false,
        child: false,
        git: false
      })
      expect(result.stdout + result.stderr).not.toContain("fixture-token")
      expect(result.stdout + result.stderr).not.toContain("fixture-cloud-token")
    }
  } finally {
    await Fs.rm(f.root, { recursive: true, force: true })
  }
}, 90_000)

it.each(["build-only", "exclusive"])(
  "refuses a green affected test when the last runnable gate becomes %s",
  async (replacement) => {
    const f = await fixture()
    try {
      const declaration = (target: string) =>
        `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { gate: ${target} } })`
      await write(f.root, "changed/PACKAGE.ts", declaration("S.Shell.Test({ shell: \"true\" })"))
      f.git("add", ".")
      f.git("commit", "-qm", "test gate")
      const base = f.git("rev-parse", "HEAD")
      await write(
        f.root,
        "changed/PACKAGE.ts",
        declaration(
          replacement === "build-only"
            ? "S.Copy({ from: S.file(\"input.txt\"), to: \"output.txt\" })"
            : "S.Shell.Test({ shell: \"true\", exclusive: true })"
        )
      )
      f.git("add", ".")
      f.git("commit", "-qm", "remove runnable gate")
      vi.spyOn(AffectedBase, "resolve").mockResolvedValue(base)
      const result = await serve(f.root, ["affected", "test", "//changed/...", "--base-green"], {
        environment: { ...process.env, GITHUB_EVENT_NAME: "push" }
      })
      expect(result.exitCode, result.output + result.logs).not.toBe(0)
      expect(result.logs).not.toContain("unchanged since")
      expect(result.output + result.logs).toContain("no runnable gates")
    } finally {
      vi.restoreAllMocks()
      await Fs.rm(f.root, { recursive: true, force: true })
    }
  }
)

it.each(["build-only", "exclusive", "deleted"])(
  "runs the remaining test scope when a selected gate becomes %s",
  async (replacement) => {
    const f = await fixture()
    try {
      await write(
        f.root,
        "changed/PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { gate: S.Shell.Test({ shell: "true" }) } })`
      )
      await write(
        f.root,
        "other/PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { remaining: S.Shell.Test({ shell: "true" }) } })`
      )
      f.git("add", ".")
      f.git("commit", "-qm", "test gates")
      const base = f.git("rev-parse", "HEAD")
      await write(
        f.root,
        "changed/PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { ${
          replacement === "deleted" ? "" : `gate: ${
            replacement === "build-only"
              ? "S.Copy({ from: S.file(\"input.txt\"), to: \"output.txt\" })"
              : "S.Shell.Test({ shell: \"true\", exclusive: true })"
          }`
        } } })`
      )
      f.git("add", ".")
      f.git("commit", "-qm", "remove selected gate")
      vi.spyOn(AffectedBase, "resolve").mockResolvedValue(base)
      const result = await serve(f.root, ["affected", "test", "//...", "--base-green"], {
        environment: { ...process.env, GITHUB_EVENT_NAME: "push" }
      })
      expect(result.exitCode, result.output + result.logs).toBe(0)
      expect(result.logs).not.toContain("unchanged since")
      expect(result.output).toContain("//other:remaining")
      expect(result.logs).toContain("1 targets: 0 hit, 1 ran, 0 failed, 0 skipped")
    } finally {
      vi.restoreAllMocks()
      await Fs.rm(f.root, { recursive: true, force: true })
    }
  }
)

it("never calls the GitHub API for a pull-request merge checkout", async () => {
  const f = await fixture()
  const transport = vi.fn(() => {
    throw new Error("PR API call")
  })
  try {
    expect(
      await AffectedBase.resolve(
        f.root,
        {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_TOKEN: "synthetic-job-token"
        },
        undefined,
        transport
      )
    ).toBe(f.base)
    expect(transport).not.toHaveBeenCalled()
    expect(f.git("config", "--local", "--list")).not.toContain("extraheader")
  } finally {
    await Fs.rm(f.root, { recursive: true, force: true })
  }
})
